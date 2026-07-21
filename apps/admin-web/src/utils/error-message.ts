const networkErrorPattern =
  /failed to fetch|fetch failed|networkerror|network error|\bload failed\b/i;
const responseFormatErrorPattern =
  /unexpected token|json\.parse|is not valid json/i;

export const getAdminErrorMessage = (
  error: unknown,
  fallback = "操作失败，请稍后重试。"
) => {
  const message = error instanceof Error ? error.message.trim() : "";

  if (!message) {
    return fallback;
  }
  if (networkErrorPattern.test(message)) {
    return "暂时无法连接服务，请检查连接后重试。";
  }
  if (responseFormatErrorPattern.test(message)) {
    return "服务响应格式异常，请稍后重试。";
  }

  return message;
};
