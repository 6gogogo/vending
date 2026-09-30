import { ConflictException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { CabinetEventRecord, SmartVmSettlementPayload } from "@vm/shared-types";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";
import { GoodsService } from "../goods/goods.service";

const TITLE = "结算处理失败待恢复";
const INTERVAL = 10 * 60_000;
const MAX_ATTEMPTS = 4; // 即刻一次，之后每十分钟最多重试三次。
type Apply = (payload: SmartVmSettlementPayload & Record<string, unknown>) => unknown | Promise<unknown>;

/** 只接收入口已经验签、绑定和校验过的结算；后台重试不伪造平台签名。 */
@Injectable()
export class SettlementRecoveryService {
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(GoodsService) private readonly goods: GoodsService,
    @Inject(AlertsService) private readonly alerts: AlertsService
  ) {}

  private normalized(payload: SmartVmSettlementPayload): NonNullable<CabinetEventRecord["settlementRecovery"]>["payload"] {
    return { eventId: payload.eventId, orderNo: payload.orderNo, deviceCode: payload.deviceCode,
      amount: payload.amount, notifyUrl: payload.notifyUrl,
      detail: payload.detail?.map(({ goodsId, goodsName, quantity, unitPrice }) =>
        ({ goodsId, goodsName, quantity, unitPrice })).sort((a, b) => a.goodsId.localeCompare(b.goodsId)) };
  }

  async handle(event: CabinetEventRecord, payload: SmartVmSettlementPayload & Record<string, unknown>, apply: Apply) {
    const normalized = this.normalized(payload);
    const existing = event.settlementRecovery;
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(normalized)) {
      this.alerts.create({ type: "callback", grade: "fault", title: "结算恢复收到冲突明细",
        deviceCode: event.deviceCode, relatedEventId: event.eventId, targetUserId: event.userId,
        dueAt: new Date().toISOString(), detail: "同一订单收到不同结算明细，已保留原始恢复任务，请人工核对。" });
      this.store.persist();
      throw new ConflictException("同一订单结算明细冲突，请人工核对。");
    }
    if (this.running.has(event.eventId)) return this.running.get(event.eventId);
    if (existing) {
      if (existing.status === "succeeded") return { recovered: true };
      // 平台频繁重发不能重置次数，也不能绕过十分钟间隔。
      throw new ServiceUnavailableException(existing.lastError ?? "结算已进入后台恢复任务，请查看待办。");
    }
    const missing = normalized.detail?.some(item => !this.store.goodsCatalog.some(g => g.goodsId === item.goodsId));
    if (!missing) {
      try {
        const result = await apply(payload);
        if (event.paymentNotifyStatus !== "failed") return result;
      } catch (error) {
        this.initialize(event, normalized);
        this.failed(event, error);
        throw error;
      }
      this.initialize(event, normalized);
      this.failed(event, new Error(event.paymentNotifyMessage ?? "平台完成状态回写失败"));
      throw new ServiceUnavailableException("结算已入账，平台回写失败，已加入自动恢复待办。");
    }
    this.initialize(event, normalized);
    return this.attempt(event, apply);
  }

  private initialize(event: CabinetEventRecord, payload: NonNullable<CabinetEventRecord["settlementRecovery"]>["payload"]) {
    const callback = this.store.callbackLog.find(c => c.type === "settlement" && c.payload.eventId === event.eventId && c.payload.deviceCode === event.deviceCode);
    if (!callback) throw new ConflictException("缺少已经验签的结算回调记录，不能创建恢复任务。");
    event.settlementRecovery = { status: "waiting", attempts: 0, callbackLogId: callback.id, updatedAt: new Date().toISOString(), payload };
  }

  async retryDue(apply: (event: CabinetEventRecord) => Apply, assertSafe: () => void) {
    for (const event of this.store.events) {
      const state = event.settlementRecovery;
      if (!state || !["waiting", "running"].includes(state.status) || this.running.has(event.eventId)) continue;
      if (!state.nextAttemptAt || Date.parse(state.nextAttemptAt) > Date.now()) continue;
      assertSafe();
      if (state.attempts >= MAX_ATTEMPTS) {
        state.status = "exhausted"; delete state.nextAttemptAt;
        this.present(event); this.store.persist(); continue;
      }
      try { await this.attempt(event, apply(event), assertSafe); }
      catch { /* 错误和后续时间已持久化，其他订单继续处理。 */ }
    }
  }

  private attempt(event: CabinetEventRecord, apply: Apply, assertSafe: () => void = () => {}) {
    const active = this.running.get(event.eventId);
    if (active) return active;
    const task = this.execute(event, apply, assertSafe).finally(() => this.running.delete(event.eventId));
    this.running.set(event.eventId, task);
    return task;
  }

  private async execute(event: CabinetEventRecord, apply: Apply, assertSafe: () => void) {
    const state = event.settlementRecovery!;
    assertSafe();
    state.attempts += 1;
    state.status = "running";
    state.updatedAt = new Date().toISOString();
    // 先落盘占用次数；重启后也不能立即重复外呼或无限重试。
    state.nextAttemptAt = new Date(Date.now() + INTERVAL).toISOString();
    this.present(event); this.store.persist();
    try {
      if (event.eventId !== state.payload.eventId || event.orderNo !== state.payload.orderNo || event.deviceCode !== state.payload.deviceCode || event.refundedAt) {
        throw new ConflictException("恢复任务与当前订单不一致或订单已退款，需人工核对。");
      }
      await this.goods.syncPlatformDoor(event.deviceCode, event.doorNum, undefined, assertSafe);
      assertSafe();
      const result = await apply({ ...state.payload, phone: event.phone });
      if (event.status !== "settled" || event.paymentNotifyStatus !== "success") {
        throw new Error(event.paymentNotifyMessage ?? "结算或平台回写尚未成功");
      }
      state.status = "succeeded"; state.updatedAt = new Date().toISOString();
      delete state.nextAttemptAt; delete state.lastError;
      this.present(event); this.store.persist();
      return result;
    } catch (error) {
      assertSafe();
      this.failed(event, error);
      throw error;
    }
  }

  private failed(event: CabinetEventRecord, error: unknown) {
    const state = event.settlementRecovery!;
    state.attempts = Math.max(1, state.attempts);
    state.updatedAt = new Date().toISOString();
    // 外部错误可能带通知地址或参数，待办只保留明确的本地错误或通用说明。
    const message = error instanceof Error ? error.message : "结算恢复失败";
    state.lastError = /^请求货品 [\w-]+ 不存在。$/.test(message) ? message : "商品同步、结算处理或平台回写未成功，请核对操作日志。";
    state.status = state.attempts >= MAX_ATTEMPTS ? "exhausted" : "waiting";
    state.nextAttemptAt = state.status === "waiting" ? new Date(Date.now() + INTERVAL).toISOString() : undefined;
    this.present(event); this.store.persist();
  }

  private present(event: CabinetEventRecord) {
    const state = event.settlementRecovery!;
    let alert = this.store.alerts.find(a => [TITLE, "结算回调超时待补记"].includes(a.title) && a.relatedEventId === event.eventId);
    if (!alert) alert = this.alerts.create({ type: "callback", grade: "fault", title: TITLE,
      deviceCode: event.deviceCode, relatedEventId: event.eventId, targetUserId: event.userId,
      dueAt: state.updatedAt, detail: "结算自动恢复处理中。" });
    alert.title = TITLE;
    const progress = state.status === "running" ? `正在同步商品并重试结算（第 ${state.attempts} 次尝试）。`
      : state.status === "succeeded" ? "结算及平台回写已成功，自动关闭。"
      : state.status === "exhausted" ? "即刻尝试及间隔十分钟的三次重试均未成功，已停止自动重试，请人工处理。"
      : `第 ${state.attempts} 次尝试失败；将在北京时间 ${new Date(state.nextAttemptAt!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 再次同步商品并结算，剩余 ${MAX_ATTEMPTS - state.attempts} 次重试。`;
    alert.detail = `订单 ${event.orderNo}；${progress}${state.lastError ? ` ${state.lastError}` : ""}`;
    alert.previewDetail = progress;
    alert.status = state.status === "succeeded" ? "resolved" : "open";
    alert.dueAt = state.nextAttemptAt ?? state.updatedAt;
    if (state.status === "succeeded") { alert.resolvedAt = state.updatedAt; alert.resolutionNote = progress; }
    this.store.decorateAlert(alert);
    this.store.logOperation({ category: "alert", type: "settlement-recovery", status: state.status === "succeeded" ? "success" : "pending",
      actor: { type: "system", name: "结算自动恢复" }, description: progress,
      relatedEventId: event.eventId, relatedOrderNo: event.orderNo,
      metadata: { attempts: state.attempts, recoveryStatus: state.status, undoState: "not_undoable" } });
  }
}
