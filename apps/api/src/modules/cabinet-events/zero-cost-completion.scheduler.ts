import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { isProductionRuntime } from "../../common/config/runtime-environment";
import { FinancialSingleWriterService } from "../../common/coordination/financial-single-writer.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { SystemAuditLogService, type CriticalAuditOperation } from "../../common/store/system-audit-log.service";
import { CabinetEventsService } from "./cabinet-events.service";

/** 补发平台已确认的零元结算；不补造识别结果，也不重复开门。 */
@Injectable()
export class ZeroCostCompletionScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ZeroCostCompletionScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private cycle?: Promise<boolean>;
  private stopped = false;
  private readonly auditPath = "/internal/cabinet-events/zero-cost-completion";

  constructor(
    @Inject(CabinetEventsService) private readonly events: CabinetEventsService,
    @Inject(FinancialSingleWriterService) private readonly writer: FinancialSingleWriterService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(SystemAuditLogService) private readonly audit: SystemAuditLogService
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => { void this.runCycle(); }, 60_000);
    this.timer.unref();
    void this.runCycle();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.cycle;
  }

  async runCycle() {
    if (this.stopped || this.cycle || !this.isReady()) return false;
    const cycle = this.execute();
    this.cycle = cycle;
    try { return await cycle; }
    finally { if (this.cycle === cycle) this.cycle = undefined; }
  }

  private isReady() {
    return this.writer.getStatus().held && (!isProductionRuntime() ||
      (this.store.isPersistedStateIntegrityReady() && this.audit.isReady()));
  }

  private async execute() {
    let intent: CriticalAuditOperation | undefined;
    let completed = false;
    try {
      if (isProductionRuntime()) {
        intent = this.audit.beginCriticalIntent({ method: "SYSTEM", path: this.auditPath });
      }
      await this.events.completePendingZeroCostOrders(() => {
        this.writer.assertHeld();
        if (!this.isReady()) throw new Error("零元订单自动完结的运行条件不可用。");
      });
      completed = true;
      return true;
    } catch {
      this.logger.error("零元订单自动完结本轮未完成，稍后重试。");
      return false;
    } finally {
      if (intent) {
        try {
          this.audit.completeCriticalOperation(intent, {
            method: "SYSTEM", path: this.auditPath, durationMs: Math.max(0, Date.now() - intent.startedAt),
            statusCode: completed ? 200 : 500, outcome: completed ? "completed" : "failed"
          });
        } catch {
          this.logger.error("零元订单周期终态审计写入失败，后续周期等待审计恢复。");
        }
      }
    }
  }
}
