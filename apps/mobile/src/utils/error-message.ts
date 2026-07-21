import { ApiError } from "@vm/shared-client";

const ACTIONABLE_NETWORK_ERROR = "暂时无法连接服务，请检查网络后重试。";
const ACTIONABLE_TIMEOUT_ERROR = "请求超时，请检查网络后重试。";

const normalizeClientErrorMessage = (message: string) => {
  const normalized = message.trim();

  if (!normalized) {
    return "请求失败，请稍后重试。";
  }

  if (/timeout|timed out|请求超时/i.test(normalized)) {
    return ACTIONABLE_TIMEOUT_ERROR;
  }

  if (
    /request:fail/i.test(normalized) ||
    /failed to fetch|fetch failed|network(?: request)? failed|networkerror|\bload failed\b/i.test(normalized) ||
    /err_(?:connection|network|internet|name_not_resolved)|econnrefused|econnreset|enotfound|ehostunreach/i.test(normalized)
  ) {
    return ACTIONABLE_NETWORK_ERROR;
  }

  return normalized;
};

export const appendErrorContext = (message: string, context: string) => {
  const normalizedMessage = message.trim().replace(/[。！？!?]+$/u, "");
  const normalizedContext = context.trim().replace(/^[。！？!?]+/u, "");

  return `${normalizedMessage || "请求失败"}。${normalizedContext}`;
};

export const getErrorMessage = (error: unknown) => {
  if (error instanceof ApiError) {
    return normalizeClientErrorMessage(error.message);
  }

  if (error instanceof Error) {
    return normalizeClientErrorMessage(error.message);
  }

  if (typeof error === "object" && error !== null && "errMsg" in error) {
    const errorMessage = (error as { errMsg?: unknown }).errMsg;

    if (typeof errorMessage === "string") {
      return normalizeClientErrorMessage(errorMessage);
    }
  }

  return "请求失败，请稍后重试。";
};
