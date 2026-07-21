import { getErrorMessage } from "./error-message";

export const showOperationSuccess = (message = "操作成功") => {
  uni.showToast({
    title: message,
    icon: "none"
  });
};

export const showOperationFailure = (error: unknown) => {
  const message = getErrorMessage(error).trim();

  uni.showToast({
    title: message ? `操作失败：${message}` : "操作失败",
    icon: "none"
  });
};
