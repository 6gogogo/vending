import { isProductionRuntime } from "../config/runtime-environment";

export interface FinancialWriterFence {
  getFencingToken(): string | undefined;
  runWithFence<T>(operation: () => T): T;
}

const truthyValues = new Set(["1", "true", "yes", "on"]);

let activeFence: FinancialWriterFence | undefined;

const requiresInstalledFence = () =>
  isProductionRuntime() ||
  truthyValues.has(
    (process.env.FINANCIAL_SINGLE_WRITER_ENABLED ?? "").trim().toLowerCase()
  );

export const installFinancialWriterFence = (fence: FinancialWriterFence) => {
  if (activeFence && activeFence !== fence) {
    throw new Error("当前进程已安装其他金融写入 fencing token，已关闭式阻断。");
  }
  if (!fence.getFencingToken()) {
    throw new Error("金融写入 fencing token 尚未获取，不能安装。");
  }

  activeFence = fence;
  return () => {
    if (activeFence === fence) {
      activeFence = undefined;
    }
  };
};

export const runWithFinancialWriterFence = <T>(operation: () => T): T => {
  if (activeFence) {
    return activeFence.runWithFence(operation);
  }

  if (requiresInstalledFence()) {
    throw new Error(
      "当前进程未持有金融单写者 fencing token，已关闭式阻断持久化。"
    );
  }

  return operation();
};

export const getInstalledFinancialWriterFenceToken = () =>
  activeFence?.getFencingToken();
