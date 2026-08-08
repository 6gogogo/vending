import { ApiError } from "@vm/shared-client";

const uncertainOpenOutcomeKeywords = [
  "结果待确认",
  "结果未知",
  "请勿重复",
  "请求超时",
  "暂时无法连接服务",
  "响应异常",
  "网络异常",
  "网络中断",
  "未结束的开门操作",
  "正在处理另一项开门请求",
  "等待结果确认",
  "failed to fetch",
  "fetch failed",
  "network error"
];

const confirmedOpenRejectionKeywords = [
  "柜机平台开柜失败",
  "柜机平台已拒绝开门请求",
  "设备明确拒绝"
];

const getOperationCode = (error: ApiError) => {
  if (!error.body || typeof error.body !== "object" || !("code" in error.body)) {
    return "";
  }

  const code = error.body.code;
  return typeof code === "string" ? code : "";
};

export const isOpenOutcomeUncertain = (message: string, error?: unknown) => {
  const normalized = message.toLowerCase();
  if (error instanceof ApiError) {
    const operationCode = getOperationCode(error);
    if (operationCode === "operation_rejected") {
      return false;
    }
    if (
      operationCode === "operation_indeterminate" ||
      operationCode === "operation_confirmed"
    ) {
      return true;
    }
  }

  if (confirmedOpenRejectionKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return false;
  }
  if (uncertainOpenOutcomeKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return true;
  }
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 409 || error.status >= 500;
  }

  return error !== undefined;
};
