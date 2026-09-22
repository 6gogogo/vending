import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, ServiceUnavailableException } from "@nestjs/common";
import type { PlatformGoodsSyncReport, PlatformGoodsSyncStatus } from "@vm/shared-types";
import { isProductionRuntime } from "../../common/config/runtime-environment";
import { FinancialSingleWriterService } from "../../common/coordination/financial-single-writer.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { SystemAuditLogService, type CriticalAuditOperation } from "../../common/store/system-audit-log.service";
import { GoodsService } from "./goods.service";

/** 每晚只查询一次平台；分钟定时器仅判断北京时间，不轮询平台。 */
@Injectable()
export class PlatformGoodsSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformGoodsSyncService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private activeReport?: PlatformGoodsSyncReport;
  private stopped = false;
  private readonly auditPath = "/internal/goods/platform-sync";

  constructor(
    @Inject(GoodsService) private readonly goods: GoodsService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(FinancialSingleWriterService) private readonly writer: FinancialSingleWriterService,
    @Inject(SystemAuditLogService) private readonly audit: SystemAuditLogService
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.runNightly(), 60_000);
    this.timer.unref();
    this.runNightly();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  getStatus(): PlatformGoodsSyncStatus {
    const latest = this.store.logs.find((log) => log.type === "sync-platform-goods" &&
      log.metadata?.tenantId === this.store.getDefaultTenantId());
    const report = structuredClone(this.activeReport ?? latest?.metadata?.report ?? null) as PlatformGoodsSyncReport | null;
    if (report?.status === "running" && !this.activeReport) report.status = "interrupted";
    return { schedule: "每天 23:00（北京时间）", report };
  }

  start(actorUserId?: string, scheduledDate?: string) {
    if (this.running) return this.getStatus();
    this.assertReady();
    const devices = this.store.devices.filter((device) => this.store.getDeviceTenantId(device) === this.store.getDefaultTenantId());
    const report: PlatformGoodsSyncReport = {
      id: this.store.createId("goods-sync"), trigger: scheduledDate ? "nightly" : "manual", scheduledDate,
      status: "running", startedAt: new Date().toISOString(), deviceCount: devices.length, goodsCount: 0,
      doors: devices.flatMap((device) => [...new Set(device.doors.length ? device.doors.map((door) => door.doorNum) : ["1"])]
        .map((doorNum) => ({ deviceCode: device.deviceCode, deviceName: device.name, doorNum, status: "pending" as const, goodsCount: 0 })))
    };
    const intent = isProductionRuntime() ? this.audit.beginCriticalIntent({ method: "SYSTEM", path: this.auditPath }) : undefined;
    try {
      // 先持久化日期占位。重启、重复点击、上次失败均不会导致当晚重复自动执行。
      this.store.runAtomicMutation(() => {
        const actor = actorUserId ? this.store.users.find((user) => user.id === actorUserId) : undefined;
        this.store.logOperation({ id: report.id, category: "goods", type: "sync-platform-goods", status: "pending",
          actor: actor ? { type: "admin", id: actor.id, name: actor.name } : { type: "system", name: scheduledDate ? "夜间货品同步" : "平台货品同步" },
          detail: "正在汇总全部柜机的平台货品资料。", description: "平台货品同步已开始。",
          metadata: { tenantId: this.store.getDefaultTenantId(), report: structuredClone(report) } });
      });
    } catch (error) {
      this.completeAudit(intent, false);
      throw error;
    }
    this.activeReport = report;
    this.running = this.execute(report, actorUserId, intent).finally(() => {
      this.running = undefined;
      this.activeReport = undefined;
    });
    return this.getStatus();
  }

  runNightly(now = new Date()) {
    if (this.stopped || this.running || !this.isReady()) return false;
    const beijing = new Date(now.getTime() + 8 * 60 * 60_000);
    if (beijing.getUTCHours() !== 23) return false;
    const date = beijing.toISOString().slice(0, 10);
    if (this.store.logs.some((log) => log.type === "sync-platform-goods" &&
      log.metadata?.tenantId === this.store.getDefaultTenantId() &&
      (log.metadata?.report as PlatformGoodsSyncReport | undefined)?.scheduledDate === date)) return false;
    try { this.start(undefined, date); return true; }
    catch { this.logger.error("夜间货品同步暂未启动，等待运行条件恢复。"); return false; }
  }

  private isReady() {
    return this.writer.getStatus().held && (!isProductionRuntime() ||
      (this.store.isPersistedStateIntegrityReady() && this.audit.isReady()));
  }

  private assertReady() {
    if (this.stopped || !this.isReady()) throw new ServiceUnavailableException("货品同步暂不可用，请稍后重试。");
    this.writer.assertHeld();
  }

  private saveReport(report: PlatformGoodsSyncReport) {
    this.assertReady();
    // 单门失败可能回滚内存快照，因此始终按 ID 重新取得日志。
    this.store.runAtomicMutation(() => {
      const log = this.store.logs.find((entry) => entry.id === report.id)!;
      log.metadata = { ...log.metadata, report: structuredClone(report) };
      log.status = report.status === "running" ? "pending" : report.status === "success" ? "success" : report.status === "partial" ? "warning" : "failed";
      log.description = log.detail = `平台货品同步：${report.doors.filter((door) => door.status === "success").length}/${report.doors.length} 个柜门成功，汇总 ${report.goodsCount} 种货品。`;
    });
  }

  private async execute(report: PlatformGoodsSyncReport, actorUserId?: string, intent?: CriticalAuditOperation) {
    const ids = new Set<string>();
    try {
      for (const door of report.doors) {
        this.assertReady();
        try {
          const result = await this.goods.syncPlatformDoor(door.deviceCode, door.doorNum, actorUserId, () => this.assertReady());
          result.goodsIds.forEach((id) => ids.add(id));
          door.goodsCount = new Set(result.goodsIds).size;
          door.status = "success";
        } catch {
          this.assertReady();
          door.status = "failed";
          door.message = "未完成同步，请检查平台连接、柜机配置及未结算订单后重试。";
        }
        report.goodsCount = new Set([...ids].map((id) => this.store.resolveGoodsId(id))).size;
        this.saveReport(report);
      }
      const failed = report.doors.filter((door) => door.status === "failed").length;
      report.status = failed === 0 ? "success" : failed === report.doors.length ? "failed" : "partial";
      report.finishedAt = new Date().toISOString();
      this.saveReport(report);
    } catch {
      // 租约或审计失效时不再写盘，留下已持久化的进度供下次启动识别为中断。
      this.logger.error("平台货品同步已中断，已完成柜门的资料和进度保留。");
    } finally {
      this.completeAudit(intent, report.status === "success");
    }
  }

  private completeAudit(intent: CriticalAuditOperation | undefined, completed: boolean) {
    if (!intent) return;
    try {
      this.audit.completeCriticalOperation(intent, { method: "SYSTEM", path: this.auditPath,
        durationMs: Math.max(0, Date.now() - intent.startedAt), statusCode: completed ? 200 : 500,
        outcome: completed ? "completed" : "failed" });
    } catch { this.logger.error("货品同步终态审计写入失败，后续同步等待审计恢复。"); }
  }
}
