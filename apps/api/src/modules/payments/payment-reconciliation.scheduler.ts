import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { isProductionRuntime } from "../../common/config/runtime-environment";
import { FinancialSingleWriterService } from "../../common/coordination/financial-single-writer.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import {
  SystemAuditLogService,
  type CriticalAuditOperation
} from "../../common/store/system-audit-log.service";
import { PaymentsService } from "./payments.service";

const truthyValues = new Set(["1", "true", "yes", "on"]);

/**
 * 只负责触发已到期的对账任务；支付状态解释、退避和告警均留在 PaymentsService。
 * 调度器不持有任何金融锁，租约丢失时宁可跳过本轮也不触发外部支付查询。
 */
@Injectable()
export class PaymentReconciliationScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentReconciliationScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private currentCycle?: Promise<boolean>;
  private stopped = false;

  constructor(
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(FinancialSingleWriterService)
    private readonly financialSingleWriter: FinancialSingleWriterService,
    @Optional()
    @Inject(InMemoryStoreService)
    private readonly store?: InMemoryStoreService,
    @Optional()
    @Inject(SystemAuditLogService)
    private readonly auditLog?: SystemAuditLogService
  ) {}

  onApplicationBootstrap() {
    this.start();
  }

  async onApplicationShutdown() {
    try {
      await this.stop();
    } finally {
      this.financialSingleWriter.release();
    }
  }

  start() {
    if (this.stopped || !this.isEnabled() || this.timer) {
      return false;
    }

    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.readIntervalMs());
    this.timer.unref();
    void this.runCycle();
    return true;
  }

  async stop() {
    const wasRunning = Boolean(this.timer);
    const currentCycle = this.currentCycle;
    this.stopped = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (currentCycle) {
      await currentCycle;
    }
    return wasRunning || Boolean(currentCycle);
  }

  isRunning() {
    return Boolean(this.timer);
  }

  async runCycle() {
    if (
      this.stopped ||
      !this.isEnabled() ||
      this.currentCycle ||
      !this.financialSingleWriter.getStatus().held ||
      !this.isProductionSafetyReady()
    ) {
      return false;
    }

    const currentCycle = this.executeCycle();
    this.currentCycle = currentCycle;
    try {
      return await currentCycle;
    } finally {
      if (this.currentCycle === currentCycle) {
        this.currentCycle = undefined;
      }
    }
  }

  private async executeCycle() {
    let criticalAudit: CriticalAuditOperation | undefined;

    try {
      criticalAudit = this.beginProductionCycleAuditIntent();
    } catch {
      this.logger.error("支付自动对账周期未建立审计意图。");
      return false;
    }

    this.paymentsService.recordAutomaticReconciliationStarted?.();
    try {
      const summary =
        await this.paymentsService.runAutomaticReconciliationCycle({
          assertRuntimeSafety: () => this.assertProductionCycleSafety()
        });
      this.paymentsService.recordAutomaticReconciliationSuccess?.(summary);
      this.completeProductionCycleAudit(criticalAudit, "completed", 200);
      return true;
    } catch (error) {
      this.paymentsService.recordAutomaticReconciliationFailure?.(error);
      this.completeProductionCycleAudit(criticalAudit, "failed", 500);
      this.logger.error("支付自动对账周期失败。");
      return false;
    }
  }

  private isEnabled() {
    return truthyValues.has(
      this.configService
        .get<string>("PAYMENT_RECONCILIATION_ENABLED")
        ?.trim()
        .toLowerCase() ?? ""
    );
  }

  private isProductionSafetyReady() {
    return (
      !isProductionRuntime() ||
      (this.store?.isPersistedStateIntegrityReady() === true &&
        this.auditLog?.isReady() === true)
    );
  }

  private assertProductionCycleSafety() {
    if (!this.isProductionSafetyReady()) {
      throw new Error("自动对账运行时安全门禁不可用。");
    }
  }

  /**
   * 自动对账会外查支付渠道并可能落盘金融状态；生产中必须先建立最小审计意图。
   * 细节仅写入固定动作，不携带订单、退款号、渠道响应或异常原文。
   */
  private beginProductionCycleAuditIntent() {
    if (!isProductionRuntime()) {
      return undefined;
    }

    return this.auditLog?.beginCriticalIntent({
      method: "SYSTEM",
      path: "/internal/payments/automatic-reconciliation",
      metadata: {
        component: "payments",
        operationClass: "automatic-reconciliation"
      }
    });
  }

  private completeProductionCycleAudit(
    criticalAudit: CriticalAuditOperation | undefined,
    outcome: "completed" | "failed",
    statusCode: 200 | 500
  ) {
    if (!criticalAudit) {
      return;
    }

    this.auditLog?.completeCriticalOperation(criticalAudit, {
      method: "SYSTEM",
      path: "/internal/payments/automatic-reconciliation",
      statusCode,
      durationMs: Math.max(0, Date.now() - criticalAudit.startedAt),
      outcome,
      metadata: {
        component: "payments",
        operationClass: "automatic-reconciliation"
      }
    });
  }

  private readIntervalMs() {
    const raw = this.configService
      .get<string>("PAYMENT_RECONCILIATION_INTERVAL_MS")
      ?.trim();
    if (!raw) {
      return 30_000;
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
      throw new Error(
        "PAYMENT_RECONCILIATION_INTERVAL_MS 必须是 1000 到 3600000 之间的整数毫秒值。"
      );
    }
    return value;
  }
}
