import type { VerificationProvider } from "@vm/shared-types";

export type BackofficePasswordResetRuntimeStatus = "loading" | "ready" | "error";

interface BackofficePasswordResetCodeActionState {
  status: BackofficePasswordResetRuntimeStatus;
  provider?: unknown;
  username: string;
  phone: string;
  requestingCode: boolean;
  cooldownSeconds: number;
}

export const BACKOFFICE_PASSWORD_RESET_RUNTIME_ERROR_MESSAGE =
  "暂时无法读取当前验证码方式，请检查连接并刷新页面后重试。";

const verificationProviders = new Set<VerificationProvider>([
  "mock",
  "aliyun_pnvs",
  "manual"
]);

export const isBackofficePasswordResetVerificationProvider = (
  provider: unknown
): provider is VerificationProvider =>
  typeof provider === "string" &&
  verificationProviders.has(provider as VerificationProvider);

export const canRequestBackofficePasswordResetCode = (
  state: BackofficePasswordResetCodeActionState
) =>
  state.status === "ready" &&
  isBackofficePasswordResetVerificationProvider(state.provider) &&
  (state.provider === "mock" || state.provider === "aliyun_pnvs") &&
  state.username.trim().length > 0 &&
  /^1\d{10}$/u.test(state.phone.trim()) &&
  !state.requestingCode &&
  state.cooldownSeconds === 0;

export const resolveBackofficePasswordResetCodeActionLabel = (
  state: BackofficePasswordResetCodeActionState
) => {
  if (state.status === "loading") {
    return "正在读取验证方式";
  }
  if (
    state.status === "error" ||
    !isBackofficePasswordResetVerificationProvider(state.provider)
  ) {
    return "验证方式不可用";
  }
  if (state.provider === "manual") {
    return "请向管理员获取";
  }
  if (state.requestingCode) {
    return "发送中...";
  }
  if (state.cooldownSeconds > 0) {
    return `${state.cooldownSeconds} 秒后可重发`;
  }
  return "获取找回验证码";
};
