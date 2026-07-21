import type { PaymentOrderRecord, PaymentRecoveryState } from "@vm/shared-types";
import { ApiError } from "@vm/shared-client";

export type PaymentLaunchAction =
  | "already_paid"
  | "simulate"
  | "invoke"
  | "unknown";

export type ClientPaymentErrorKind = "cancelled" | "unknown";

const readNonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const resolvePaymentLaunchAction = (
  order: Pick<PaymentOrderRecord, "provider" | "status" | "metadata">,
  invokePayload: Record<string, unknown>
): PaymentLaunchAction => {
  if (order.status === "paid" || order.status === "refunded") {
    return "already_paid";
  }

  if (order.status !== "pending" && order.status !== "created") {
    return "unknown";
  }

  if (invokePayload.simulated === true) {
    return "simulate";
  }

  if (
    order.metadata?.providerCreateOutcome === "unknown" ||
    order.metadata?.providerCreateOutcome === "submitting"
  ) {
    return "unknown";
  }

  if (order.provider === "wechat") {
    const hasWechatPayload = [
      invokePayload.timeStamp,
      invokePayload.nonceStr,
      invokePayload.package,
      invokePayload.paySign
    ].every((value) => Boolean(readNonEmptyString(value)));
    return hasWechatPayload ? "invoke" : "unknown";
  }

  const hasAlipayPayload = Boolean(
    readNonEmptyString(invokePayload.tradeNO) ??
      readNonEmptyString(invokePayload.orderStr)
  );
  return hasAlipayPayload ? "invoke" : "unknown";
};

export const classifyClientPaymentError = (
  error: unknown
): ClientPaymentErrorKind => {
  if (!error || typeof error !== "object") {
    return "unknown";
  }

  const record = error as Record<string, unknown>;
  const resultCode = readNonEmptyString(record.resultCode);

  if (resultCode === "6001") {
    return "cancelled";
  }

  const message = [
    record.errMsg,
    record.errorMessage,
    record.message,
    record.memo
  ]
    .map(readNonEmptyString)
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  return /\bcancel(?:led)?\b|用户取消|取消支付/.test(message)
    ? "cancelled"
    : "unknown";
};

export const isPaymentRequestOutcomeUncertain = (error: unknown) => {
  const status =
    error instanceof ApiError
      ? error.status
      : error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;

  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || Number(status) >= 500;
  }

  return true;
};

/**
 * 结果未知时，移动端最多只能请求后端安排核对；它不能直接查询或重发渠道支付。
 * 缺少可核对订单时保留“只刷新事件详情”的安全降级路径。
 */
export const resolvePaymentReconciliationRequestOrderId = (
  recovery?: PaymentRecoveryState
) => {
  const pendingPayment = recovery?.pendingPayment;

  if (!pendingPayment || pendingPayment.status !== "pending") {
    return undefined;
  }

  return pendingPayment.id;
};
