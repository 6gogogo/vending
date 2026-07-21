import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PaymentOrderRecord } from "@vm/shared-types";
import { ApiError } from "@vm/shared-client";

import {
  classifyClientPaymentError,
  isPaymentRequestOutcomeUncertain,
  resolvePaymentReconciliationRequestOrderId,
  resolvePaymentLaunchAction
} from "./payment-safety";

const createOrder = (
  overrides: Partial<PaymentOrderRecord> = {}
): PaymentOrderRecord => ({
  id: "payment-mobile-safety",
  paymentNo: "payment-no-mobile-safety",
  provider: "wechat",
  phase: "post_settlement",
  status: "pending",
  amount: 500,
  currency: "CNY",
  subject: "移动端支付安全测试",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
});

describe("移动端支付发起门禁", () => {
  test("服务端已支付或已退款的支付单绝不再次唤起支付组件", () => {
    assert.equal(
      resolvePaymentLaunchAction(createOrder({ status: "paid" }), {
        timeStamp: "1",
        nonceStr: "nonce",
        package: "prepay_id=paid",
        paySign: "signature"
      }),
      "already_paid"
    );
    assert.equal(
      resolvePaymentLaunchAction(createOrder({ status: "refunded" }), {
        timeStamp: "1",
        nonceStr: "nonce",
        package: "prepay_id=refunded",
        paySign: "signature"
      }),
      "already_paid"
    );
  });

  test("渠道结果未知或唤起参数不完整时只能查询，不能发起支付", () => {
    assert.equal(
      resolvePaymentLaunchAction(
        createOrder({ metadata: { providerCreateOutcome: "unknown" } }),
        {}
      ),
      "unknown"
    );
    assert.equal(resolvePaymentLaunchAction(createOrder(), {}), "unknown");
  });

  test("仅完整真实参数可唤起支付，显式模拟单进入模拟确认", () => {
    assert.equal(
      resolvePaymentLaunchAction(createOrder(), {
        timeStamp: "1",
        nonceStr: "nonce",
        package: "prepay_id=pending",
        paySign: "signature"
      }),
      "invoke"
    );
    assert.equal(
      resolvePaymentLaunchAction(createOrder(), {
        simulated: true
      }),
      "simulate"
    );
  });
});

describe("支付组件错误分流", () => {
  test("只有明确的用户取消可视为未支付，网络或未知错误必须待确认", () => {
    assert.equal(
      classifyClientPaymentError({ errMsg: "requestPayment:fail cancel" }),
      "cancelled"
    );
    assert.equal(
      classifyClientPaymentError({ resultCode: "6001", memo: "用户取消" }),
      "cancelled"
    );
    assert.equal(
      classifyClientPaymentError({ errMsg: "requestPayment:fail network error" }),
      "unknown"
    );
    assert.equal(classifyClientPaymentError(new Error("timeout")), "unknown");
  });

  test("金融请求的超时、冲突、服务端错误和网络异常按结果未知处理", () => {
    for (const status of [408, 409, 500, 502]) {
      assert.equal(
        isPaymentRequestOutcomeUncertain(new ApiError(`HTTP ${status}`, status)),
        true
      );
    }
    assert.equal(
      isPaymentRequestOutcomeUncertain(new ApiError("参数错误", 400)),
      false
    );
    assert.equal(
      isPaymentRequestOutcomeUncertain(new ApiError("付款身份已失效", 410)),
      false
    );
    assert.equal(
      isPaymentRequestOutcomeUncertain(new Error("network error")),
      true
    );
  });
});

describe("结果未知时的安全核对请求", () => {
  test("只把本人待确认支付单交给后台核对，不在客户端触达支付渠道", () => {
    assert.equal(
      resolvePaymentReconciliationRequestOrderId({
        pendingPayment: {
          id: "payment-safe-reconcile",
          paymentNo: "payment-no-safe-reconcile",
          provider: "wechat",
          phase: "post_settlement",
          status: "pending",
          amount: 500,
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z"
        }
      }),
      "payment-safe-reconcile"
    );
  });

  test("没有待确认单、尚未提交的 created 单或已终态单时仅刷新事件，不发起核对请求", () => {
    assert.equal(resolvePaymentReconciliationRequestOrderId(), undefined);
    assert.equal(
      resolvePaymentReconciliationRequestOrderId({
        pendingPayment: {
          id: "payment-created",
          paymentNo: "payment-no-created",
          provider: "alipay",
          phase: "post_settlement",
          status: "created",
          amount: 500,
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z"
        }
      }),
      undefined
    );
    assert.equal(
      resolvePaymentReconciliationRequestOrderId({
        pendingPayment: {
          id: "payment-already-paid",
          paymentNo: "payment-no-already-paid",
          provider: "alipay",
          phase: "post_settlement",
          status: "paid",
          amount: 500,
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z"
        }
      }),
      undefined
    );
  });
});
