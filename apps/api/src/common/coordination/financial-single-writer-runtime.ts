import { resolveFinancialSingleWriterLeaseFile } from "../store/persistence";
import {
  FinancialSingleWriterLease,
  type FinancialWriterLeaseSnapshot
} from "./financial-single-writer-lease";
import { installFinancialWriterFence } from "./financial-writer-fence";

const readPositiveInteger = (
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const raw = process.env[key]?.trim();
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
};

export interface AcquiredFinancialSingleWriterRuntime {
  readonly lease: FinancialSingleWriterLease;
  readonly acquired: FinancialWriterLeaseSnapshot;
  release(): void;
}

const acquireFinancialSingleWriterRuntime = (
  defaultOwnerId?: string
): AcquiredFinancialSingleWriterRuntime => {
  const leaseDurationMs = readPositiveInteger(
    "FINANCIAL_SINGLE_WRITER_LEASE_MS",
    30_000,
    5_000,
    300_000
  );
  const lease = new FinancialSingleWriterLease({
    lockFile: resolveFinancialSingleWriterLeaseFile(),
    ownerId:
      process.env.FINANCIAL_INSTANCE_ID?.trim() ||
      defaultOwnerId,
    leaseDurationMs,
    heartbeatIntervalMs: readPositiveInteger(
      "FINANCIAL_SINGLE_WRITER_HEARTBEAT_MS",
      Math.floor(leaseDurationMs / 3),
      1_000,
      Math.floor(leaseDurationMs / 2)
    )
  });

  let uninstallFence: (() => void) | undefined;
  let acquired: FinancialWriterLeaseSnapshot;
  try {
    acquired = lease.acquire();
    uninstallFence = installFinancialWriterFence(lease);
  } catch (error) {
    lease.release();
    throw error;
  }

  let released = false;
  return {
    lease,
    acquired,
    release() {
      if (released) {
        return;
      }
      released = true;
      lease.release();
      uninstallFence?.();
    }
  };
};

/**
 * API 必须在 Nest 构造依赖图、仓储读取账本之前取得租约和 fencing token。
 * 返回的同一个 runtime 会交给 FinancialSingleWriterService 接管生命周期。
 */
export const acquireFinancialSingleWriterForApiBootstrap = () =>
  acquireFinancialSingleWriterRuntime();

/**
 * 初始化、清空和恢复运行数据都必须与 API 进程竞争同一租约。
 * 该入口只用于短生命周期的本机维护命令，不负责加载 .env。
 */
export const acquireFinancialSingleWriterForMaintenance = () =>
  acquireFinancialSingleWriterRuntime(`maintenance-${process.pid}`);
