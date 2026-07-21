import { ApiError } from "@vm/shared-client";
import type { PaymentRefundRecord } from "@vm/shared-types";

export type RefundOutcome = "completed" | "pending" | "failed";

export const canManuallyConfirmPayment = (
  canOperateDevice: boolean,
  canRefundPayments: boolean
) => canOperateDevice && canRefundPayments;

export const validateLegacyFullRefundAmount = (
  amount: number,
  expectedAmount?: number
) => {
  if (expectedAmount === undefined) {
    return "";
  }

  return amount === expectedAmount
    ? ""
    : `当前入口仅支持整单全额退款，退款金额必须为 ${expectedAmount} 分。`;
};

export const isFinancialActionOutcomeUncertain = (error: unknown) => {
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

export const classifyRefundOutcome = (
  refund: Pick<
    PaymentRefundRecord,
    "status" | "providerOutcome" | "businessApplyState"
  >
): RefundOutcome => {
  if (
    refund.status === "success" &&
    refund.providerOutcome === "success" &&
    refund.businessApplyState === "completed"
  ) {
    return "completed";
  }

  if (refund.status === "failed" || refund.providerOutcome === "failed") {
    return "failed";
  }

  return "pending";
};
