import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { resolveFinancialSingleWriterLeaseFile } from "../store/persistence";
import {
  FinancialSingleWriterLease,
  type FinancialWriterLeaseSnapshot
} from "./financial-single-writer-lease";
import type { AcquiredFinancialSingleWriterRuntime } from "./financial-single-writer-runtime";
import { installFinancialWriterFence } from "./financial-writer-fence";

@Injectable()
export class FinancialSingleWriterService {
  private lease?: FinancialSingleWriterLease;
  private acquired?: FinancialWriterLeaseSnapshot;
  private uninstallFence?: () => void;
  private adoptedRuntime?: AcquiredFinancialSingleWriterRuntime;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  adoptPreAcquiredRuntime(runtime: AcquiredFinancialSingleWriterRuntime) {
    if (this.lease && this.lease !== runtime.lease) {
      throw new Error("金融单写者服务已持有另一份租约，不能接管预启动租约。");
    }

    runtime.lease.assertHeld();
    const snapshot = runtime.lease.getSnapshot();
    if (
      !snapshot ||
      snapshot.fencingToken !== runtime.acquired.fencingToken
    ) {
      throw new Error("预启动金融租约 fencing token 不一致，已关闭式停止。");
    }

    this.lease = runtime.lease;
    this.acquired = snapshot;
    this.adoptedRuntime = runtime;
    return structuredClone(snapshot);
  }

  acquire() {
    if (this.acquired) {
      return structuredClone(this.acquired);
    }

    const leaseDurationMs = this.readPositiveInteger(
      "FINANCIAL_SINGLE_WRITER_LEASE_MS",
      30_000,
      5_000,
      300_000
    );
    const heartbeatIntervalMs = this.readPositiveInteger(
      "FINANCIAL_SINGLE_WRITER_HEARTBEAT_MS",
      Math.floor(leaseDurationMs / 3),
      1_000,
      Math.floor(leaseDurationMs / 2)
    );
    this.lease = new FinancialSingleWriterLease({
      lockFile: resolveFinancialSingleWriterLeaseFile(
        this.configService.get<string>("FINANCIAL_SINGLE_WRITER_LEASE_FILE")
      ),
      ownerId: this.configService.get<string>("FINANCIAL_INSTANCE_ID"),
      leaseDurationMs,
      heartbeatIntervalMs
    });
    try {
      this.acquired = this.lease.acquire();
      this.uninstallFence = installFinancialWriterFence(this.lease);
    } catch (error) {
      this.lease.release();
      this.lease = undefined;
      this.acquired = undefined;
      throw error;
    }
    return structuredClone(this.acquired);
  }

  assertHeld() {
    this.lease?.assertHeld();
    if (!this.lease) {
      throw new Error("金融单写者租约尚未获取，已关闭式阻断金融操作。");
    }
  }

  release() {
    if (this.adoptedRuntime) {
      this.adoptedRuntime.release();
    } else {
      this.lease?.release();
      this.uninstallFence?.();
    }
    this.lease = undefined;
    this.acquired = undefined;
    this.uninstallFence = undefined;
    this.adoptedRuntime = undefined;
  }

  getStatus() {
    return {
      enabled: true,
      held: this.lease?.isHeld() ?? false,
      lease: this.lease?.getSnapshot()
    };
  }

  private readPositiveInteger(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number
  ) {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) {
      return fallback;
    }

    const parsed = Number(raw);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < minimum ||
      parsed > maximum
    ) {
      throw new Error(
        `${key} 必须是 ${minimum} 到 ${maximum} 之间的整数毫秒值。`
      );
    }
    return parsed;
  }
}
