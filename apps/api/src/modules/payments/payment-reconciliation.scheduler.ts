import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { FinancialSingleWriterService } from "../../common/coordination/financial-single-writer.service";
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
    private readonly financialSingleWriter: FinancialSingleWriterService
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
      !this.financialSingleWriter.getStatus().held
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
    this.paymentsService.recordAutomaticReconciliationStarted?.();
    try {
      const summary =
        await this.paymentsService.runAutomaticReconciliationCycle();
      this.paymentsService.recordAutomaticReconciliationSuccess?.(summary);
      return true;
    } catch (error) {
      this.paymentsService.recordAutomaticReconciliationFailure?.(error);
      const message = error instanceof Error ? error.message : "未知错误";
      this.logger.error(`支付自动对账周期失败：${message}`);
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
