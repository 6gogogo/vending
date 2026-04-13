import { getErrorMessage } from "./error-message";

export const showOperationSuccess = () => {
  uni.showToast({
    title: "操作成功",
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
