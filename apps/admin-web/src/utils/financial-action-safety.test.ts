import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "@vm/shared-client";

import {
  canManuallyConfirmPayment,
  classifyRefundOutcome,
  isFinancialActionOutcomeUncertain,
  validateLegacyFullRefundAmount
} from "./financial-action-safety";

test("手工付款成功回写必须同时具备柜机操作和退款支付处理权限", () => {
  assert.equal(canManuallyConfirmPayment(true, true), true);
  assert.equal(canManuallyConfirmPayment(true, false), false);
  assert.equal(canManuallyConfirmPayment(false, true), false);
  assert.equal(canManuallyConfirmPayment(false, false), false);
});

test("旧退款入口只允许与订单金额完全一致的全额退款", () => {
  assert.equal(validateLegacyFullRefundAmount(1_000, 1_000), "");
  assert.match(
    validateLegacyFullRefundAmount(999, 1_000),
    /仅支持整单全额退款/
  );
  assert.match(
    validateLegacyFullRefundAmount(1_001, 1_000),
    /仅支持整单全额退款/
  );
});

test("金融动作超时、冲突、服务端异常和网络错误必须标记为结果待确认", () => {
  for (const status of [408, 409, 500, 503]) {
    assert.equal(
      isFinancialActionOutcomeUncertain(new ApiError(`HTTP ${status}`, status)),
      true
    );
  }
  assert.equal(
    isFinancialActionOutcomeUncertain(new ApiError("参数错误", 400)),
    false
  );
  assert.equal(
    isFinancialActionOutcomeUncertain(new Error("network error")),
    true
  );
});

test("退款响应只有渠道成功且业务副作用完成时才显示已完成", () => {
  assert.equal(
    classifyRefundOutcome({
      status: "success",
      providerOutcome: "success",
      businessApplyState: "completed"
    }),
    "completed"
  );
  assert.equal(
    classifyRefundOutcome({
      status: "pending",
      providerOutcome: "unknown",
      businessApplyState: "pending"
    }),
    "pending"
  );
  assert.equal(
    classifyRefundOutcome({
      status: "pending",
      providerOutcome: "success",
      businessApplyState: "pending"
    }),
    "pending"
  );
  assert.equal(
    classifyRefundOutcome({
      status: "failed",
      providerOutcome: "failed",
      businessApplyState: "pending"
    }),
    "failed"
  );
});
