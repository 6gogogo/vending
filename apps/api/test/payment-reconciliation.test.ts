import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BadGatewayException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PaymentOrderRecord, PaymentRefundRecord } from "@vm/shared-types";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import {
  ALLOWED_BACKOFFICE_PERMISSIONS_KEY,
  ALLOWED_ROLES_KEY
} from "../src/common/guards/allowed-roles.decorator";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { PaymentPayerIdentityHandleService } from "../src/modules/payments/payment-payer-identity-handle.service";
import { PaymentsController } from "../src/modules/payments/payments.controller";
import { PaymentsService } from "../src/modules/payments/payments.service";

const admin = { id: "admin-reconciliation", role: "admin" as const };

const createHarness = (configOverrides: Record<string, string> = {}) => {
  let sequence = 0;
  let persistCalls = 0;
  const inventoryRefunds: unknown[] = [];
  const paymentAlerts: unknown[] = [];
  const store = {
    events: [],
    users: [],
    goodsCatalog: [],
    paymentOrders: [] as PaymentOrderRecord[],
    paymentRefunds: [] as PaymentRefundRecord[],
    createId(prefix: string) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
    logOperation(entry: unknown) {
      return entry;
    },
    persist() {
      persistCalls += 1;
    }
  };
  const config = new ConfigService({
    PAYMENT_MODE: "real",
    WECHAT_PAY_APP_ID: "wx-app-reconciliation",
    WECHAT_PAY_MCH_ID: "wx-mch-reconciliation",
    WECHAT_PAY_REFUND_NOTIFY_URL: "https://payment.example.test/wechat-refund",
    ALIPAY_APP_ID: "ali-app-reconciliation",
    ALIPAY_SELLER_ID: "ali-seller-reconciliation",
    ...configOverrides
  });
  const service = new PaymentsService(
    store as unknown as InMemoryStoreService,
    config,
    {
      async notifyConfirmedPaymentSuccess() {
        return {};
      }
    } as unknown as CabinetEventsService,
    {
      markRefund(...args: unknown[]) {
        inventoryRefunds.push(args);
        return {};
      }
    } as unknown as InventoryOrdersService,
    new PaymentPayerIdentityHandleService(config),
    {
      create(payload: unknown) {
        paymentAlerts.push(payload);
        return payload;
      }
    } as unknown as AlertsService
  );

  return {
    service,
    store,
    config,
    inventoryRefunds,
    paymentAlerts,
    get persistCalls() {
      return persistCalls;
    }
  };
};

const appendOrder = (
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<PaymentOrderRecord> = {}
) => {
  const now = new Date().toISOString();
  const order: PaymentOrderRecord = {
    id: `payment-reconciliation-${harness.store.paymentOrders.length + 1}`,
    paymentNo: `payment-no-reconciliation-${harness.store.paymentOrders.length + 1}`,
    provider: "wechat",
    phase: "post_settlement",
    status: "pending",
    amount: 1_000,
    currency: "CNY",
    subject: "主动核对测试",
    merchantUserId: "merchant-reconciliation",
    providerOrderId: "provider-order-reconciliation",
    metadata: {
      simulated: false
    },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  harness.store.paymentOrders.unshift(order);
  return order;
};

const appendRefund = (
  harness: ReturnType<typeof createHarness>,
  order: PaymentOrderRecord,
  overrides: Partial<PaymentRefundRecord> = {}
) => {
  const now = new Date().toISOString();
  const refund: PaymentRefundRecord = {
    id: `refund-reconciliation-${harness.store.paymentRefunds.length + 1}`,
    paymentOrderId: order.id,
    paymentNo: order.paymentNo,
    refundNo: `refund-no-reconciliation-${harness.store.paymentRefunds.length + 1}`,
    provider: order.provider,
    status: "pending",
    amount: order.amount,
    requestSource: "backoffice",
    requestedByUserId: admin.id,
    requestedByRole: admin.role,
    providerOutcome: "unknown",
    businessApplyState: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  harness.store.paymentRefunds.unshift(refund);
  return refund;
};

describe("支付与退款主动核对", () => {
  test("主动核对与关单控制器入口仅开放给具备退款权限的后台管理员或商户", () => {
    for (const methodName of [
      "reconcileOrder",
      "reconcileRefund",
      "closeUnpaidOrder"
    ]) {
      const handler = (
        PaymentsController.prototype as unknown as Record<string, object>
      )[methodName];
      assert.equal(typeof handler, "function");
      assert.deepEqual(
        Reflect.getMetadata(ALLOWED_ROLES_KEY, handler),
        ["admin", "merchant"]
      );
      assert.deepEqual(
        Reflect.getMetadata(ALLOWED_BACKOFFICE_PERMISSIONS_KEY, handler),
        ["payments:refund"]
      );
    }
  });

  test("服务层仅允许管理员或支付单所属商户执行核对与关单", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-owned-transaction",
      paidAt: new Date().toISOString()
    });

    assert.equal(
      await harness.service.reconcileOrder(order.id, {
        id: order.merchantUserId!,
        role: "merchant"
      }),
      order
    );
    await assert.rejects(
      harness.service.reconcileOrder(order.id, {
        id: "other-merchant",
        role: "merchant"
      }),
      /无权核对或关闭/
    );
    await assert.rejects(
      harness.service.reconcileOrder(order.id, {
        id: "special-reconciliation",
        role: "special"
      }),
      /无权核对或关闭/
    );
    await assert.rejects(
      harness.service.reconcileOrder(order.id),
      /登录态已失效/
    );
  });

  test("特殊群体本人查询支付单只返回白名单摘要，不暴露渠道交易与回调数据", () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      payerUserId: "special-payment-owner",
      providerTransactionId: "provider-transaction-secret",
      invokePayload: { paySign: "sensitive-pay-sign" },
      callbackPayload: { raw: "sensitive-callback" },
      metadata: {
        simulated: false,
        internalIdempotencyKey: "sensitive-idempotency"
      }
    });

    const ownDetail = harness.service.detail(order.id, {
      id: "special-payment-owner",
      role: "special"
    });
    assert.deepEqual(Object.keys(ownDetail).sort(), [
      "amount",
      "createdAt",
      "id",
      "paymentNo",
      "phase",
      "provider",
      "status",
      "updatedAt"
    ]);
    assert.equal("providerTransactionId" in ownDetail, false);
    assert.equal("invokePayload" in ownDetail, false);
    assert.equal("callbackPayload" in ownDetail, false);
    assert.equal("metadata" in ownDetail, false);
    assert.equal(harness.service.detail(order.id, admin), order);
  });

  test("微信支付查询确认成功后，通过既有入账路径完成支付且只保存白名单字段", async () => {
    const harness = createHarness();
    const order = appendOrder(harness);
    const calls: unknown[][] = [];
    (
      harness.service as unknown as {
        callWechatApi(
          method: string,
          path: string,
          body?: Record<string, unknown>
        ): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async (...args: unknown[]) => {
      calls.push(args);
      return {
        appid: "wx-app-reconciliation",
        mchid: "wx-mch-reconciliation",
        out_trade_no: order.paymentNo,
        transaction_id: "wx-transaction-reconciliation",
        trade_state: "SUCCESS",
        amount: {
          total: order.amount,
          currency: "CNY"
        },
        payer: {
          openid: "sensitive-openid-must-not-persist"
        }
      };
    };

    const result = await (
      harness.service as unknown as {
        reconcileOrder(
          id: string,
          actor: typeof admin
        ): Promise<PaymentOrderRecord>;
      }
    ).reconcileOrder(order.id, admin);

    assert.equal(result.status, "paid");
    assert.equal(result.providerTransactionId, "wx-transaction-reconciliation");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "GET");
    assert.match(String(calls[0]?.[1]), /out-trade-no/);
    assert.equal(
      JSON.stringify(result.callbackPayload).includes("sensitive-openid"),
      false
    );
  });

  test("微信未支付查询只把本地订单保持为待支付，不提前释放或误判失败", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, { status: "created" });
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => ({
      appid: "wx-app-reconciliation",
      mchid: "wx-mch-reconciliation",
      out_trade_no: order.paymentNo,
      trade_state: "NOTPAY",
      amount: {
        total: order.amount,
        currency: "CNY"
      },
      payer: {
        openid: "must-not-persist"
      }
    });

    const result = await harness.service.reconcileOrder(order.id, admin);

    assert.equal(result.status, "pending");
    assert.equal(result.closedAt, undefined);
    assert.equal(result.failReason, undefined);
    assert.equal(
      JSON.stringify(result.callbackPayload).includes("must-not-persist"),
      false
    );
    assert.ok(harness.persistCalls > 0);
  });

  test("微信明确关闭或支付失败时，主动核对才释放本地支付单", async () => {
    for (const [tradeState, expectedStatus] of [
      ["CLOSED", "closed"],
      ["REVOKED", "closed"],
      ["PAYERROR", "failed"]
    ] as const) {
      const harness = createHarness();
      const order = appendOrder(harness);
      (
        harness.service as unknown as {
          callWechatApi(): Promise<Record<string, unknown>>;
        }
      ).callWechatApi = async () => ({
        appid: "wx-app-reconciliation",
        mchid: "wx-mch-reconciliation",
        out_trade_no: order.paymentNo,
        trade_state: tradeState,
        amount: {
          total: order.amount,
          currency: "CNY"
        }
      });

      const result = await harness.service.reconcileOrder(order.id, admin);

      assert.equal(result.status, expectedStatus);
      assert.equal(Boolean(result.closedAt), expectedStatus === "closed");
      assert.equal(
        Boolean(result.failReason),
        expectedStatus === "failed"
      );
    }
  });

  test("微信支付查询任一身份、订单、交易、金额或币种绑定不一致都保持本地 pending", async () => {
    const invalidResponses = [
      { appid: "other-app" },
      { mchid: "other-merchant" },
      { out_trade_no: "other-payment-no" },
      { transaction_id: undefined },
      { amount: { total: 999, currency: "CNY" } },
      { amount: { total: 1_000, currency: "USD" } }
    ];

    for (const invalid of invalidResponses) {
      const harness = createHarness();
      const order = appendOrder(harness);
      (
        harness.service as unknown as {
          callWechatApi(): Promise<Record<string, unknown>>;
        }
      ).callWechatApi = async () => ({
        appid: "wx-app-reconciliation",
        mchid: "wx-mch-reconciliation",
        out_trade_no: order.paymentNo,
        transaction_id: "wx-transaction-reconciliation",
        trade_state: "SUCCESS",
        amount: {
          total: order.amount,
          currency: "CNY"
        },
        ...invalid
      });

      await assert.rejects(
        harness.service.reconcileOrder(order.id, admin)
      );
      assert.equal(order.status, "pending");
      assert.equal(order.providerTransactionId, undefined);
    }
  });

  test("支付宝支付查询确认成功后，严格绑定交易与金额并复用既有入账路径", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      provider: "alipay",
      providerOrderId: "ali-trade-reconciliation"
    });
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    (
      harness.service as unknown as {
        callAlipayGateway(
          method: string,
          params: Record<string, string>
        ): Promise<Record<string, unknown>>;
      }
    ).callAlipayGateway = async (method, params) => {
      calls.push({ method, params });
      return {
        code: "10000",
        seller_id: "ali-seller-reconciliation",
        out_trade_no: order.paymentNo,
        trade_no: "ali-trade-reconciliation",
        trade_status: "TRADE_SUCCESS",
        total_amount: "10.00",
        buyer_user_id: "sensitive-buyer-must-not-persist"
      };
    };

    const result = await harness.service.reconcileOrder(order.id, admin);

    assert.equal(result.status, "paid");
    assert.equal(result.providerTransactionId, "ali-trade-reconciliation");
    assert.equal(calls[0]?.method, "alipay.trade.query");
    assert.deepEqual(JSON.parse(calls[0]?.params.biz_content ?? "{}"), {
      out_trade_no: order.paymentNo
    });
    assert.equal(
      JSON.stringify(result.callbackPayload).includes("sensitive-buyer"),
      false
    );
  });

  test("支付宝等待付款保持 pending，只有渠道明确关闭才释放支付单", async () => {
    for (const [tradeStatus, expectedStatus] of [
      ["WAIT_BUYER_PAY", "pending"],
      ["TRADE_CLOSED", "closed"]
    ] as const) {
      const harness = createHarness();
      const order = appendOrder(harness, {
        provider: "alipay",
        providerOrderId: "ali-trade-reconciliation"
      });
      (
        harness.service as unknown as {
          callAlipayGateway(): Promise<Record<string, unknown>>;
        }
      ).callAlipayGateway = async () => ({
        code: "10000",
        seller_id: "ali-seller-reconciliation",
        out_trade_no: order.paymentNo,
        trade_no: "ali-trade-reconciliation",
        trade_status: tradeStatus,
        total_amount: "10.00"
      });

      const result = await harness.service.reconcileOrder(order.id, admin);

      assert.equal(result.status, expectedStatus);
      assert.equal(Boolean(result.closedAt), expectedStatus === "closed");
    }
  });

  test("支付宝支付查询任一收款方、订单、交易、金额或币种绑定不一致都拒绝入账", async () => {
    const invalidResponses = [
      { seller_id: "other-seller" },
      { out_trade_no: "other-payment-no" },
      { trade_no: "other-trade-no" },
      { total_amount: "9.99" },
      { currency: "USD" }
    ];

    for (const invalid of invalidResponses) {
      const harness = createHarness();
      const order = appendOrder(harness, {
        provider: "alipay",
        providerOrderId: "ali-trade-reconciliation"
      });
      (
        harness.service as unknown as {
          callAlipayGateway(): Promise<Record<string, unknown>>;
        }
      ).callAlipayGateway = async () => ({
        code: "10000",
        seller_id: "ali-seller-reconciliation",
        out_trade_no: order.paymentNo,
        trade_no: "ali-trade-reconciliation",
        trade_status: "TRADE_SUCCESS",
        total_amount: "10.00",
        ...invalid
      });

      await assert.rejects(
        harness.service.reconcileOrder(order.id, admin)
      );
      assert.equal(order.status, "pending");
      assert.equal(order.providerTransactionId, undefined);
    }
  });

  test("微信退款查询确认成功后，通过既有退款应用路径完成账本状态且脱敏落盘", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-transaction-reconciliation",
      paidAt: new Date().toISOString()
    });
    const refund = appendRefund(harness, order);
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => ({
      refund_id: "wx-refund-reconciliation",
      out_refund_no: refund.refundNo,
      transaction_id: order.providerTransactionId,
      out_trade_no: order.paymentNo,
      status: "SUCCESS",
      user_received_account: "sensitive-bank-account",
      amount: {
        total: order.amount,
        refund: refund.amount
      }
    });

    const result = await (
      harness.service as unknown as {
        reconcileRefund(
          id: string,
          actor: typeof admin
        ): Promise<PaymentRefundRecord>;
      }
    ).reconcileRefund(refund.id, admin);

    assert.equal(result.status, "success");
    assert.equal(result.providerOutcome, "success");
    assert.equal(result.businessApplyState, "completed");
    assert.equal(result.providerRefundId, "wx-refund-reconciliation");
    assert.equal(order.status, "refunded");
    assert.equal(
      JSON.stringify(result.callbackPayload).includes("sensitive-bank"),
      false
    );
  });

  test("微信退款处理中或异常时保持 pending，只有退款关闭才明确失败并释放金额", async () => {
    for (const [providerStatus, expectedStatus, expectedOutcome] of [
      ["PROCESSING", "pending", "pending"],
      ["ABNORMAL", "pending", "pending"],
      ["CLOSED", "failed", "failed"]
    ] as const) {
      const harness = createHarness();
      const order = appendOrder(harness, {
        status: "paid",
        providerTransactionId: "wx-transaction-reconciliation",
        paidAt: new Date().toISOString()
      });
      const refund = appendRefund(harness, order);
      (
        harness.service as unknown as {
          callWechatApi(): Promise<Record<string, unknown>>;
        }
      ).callWechatApi = async () => ({
        refund_id: "wx-refund-reconciliation",
        out_refund_no: refund.refundNo,
        transaction_id: order.providerTransactionId,
        out_trade_no: order.paymentNo,
        status: providerStatus,
        amount: {
          total: order.amount,
          refund: refund.amount,
          currency: "CNY"
        }
      });

      const result = await harness.service.reconcileRefund(refund.id, admin);

      assert.equal(result.status, expectedStatus);
      assert.equal(result.providerOutcome, expectedOutcome);
      assert.equal(order.status, "paid");
    }
  });

  test("微信退款查询若明确返回非 CNY 币种则拒绝应用，账本保持 pending", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-transaction-reconciliation",
      paidAt: new Date().toISOString()
    });
    const refund = appendRefund(harness, order);
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => ({
      refund_id: "wx-refund-reconciliation",
      out_refund_no: refund.refundNo,
      transaction_id: order.providerTransactionId,
      out_trade_no: order.paymentNo,
      status: "SUCCESS",
      amount: {
        total: order.amount,
        refund: refund.amount,
        currency: "USD"
      }
    });

    await assert.rejects(
      harness.service.reconcileRefund(refund.id, admin),
      /币种不匹配/
    );
    assert.equal(refund.status, "pending");
    assert.equal(refund.providerOutcome, "unknown");
    assert.equal(order.status, "paid");
  });

  test("微信退款查询任一退款单、原交易、订单或金额绑定不一致都拒绝应用", async () => {
    const invalidResponses = [
      { refund_id: "other-provider-refund" },
      { out_refund_no: "other-refund-no" },
      { transaction_id: "other-transaction" },
      { out_trade_no: "other-payment-no" },
      { amount: { total: 999, refund: 1_000, currency: "CNY" } },
      { amount: { total: 1_000, refund: 999, currency: "CNY" } }
    ];

    for (const invalid of invalidResponses) {
      const harness = createHarness();
      const order = appendOrder(harness, {
        status: "paid",
        providerTransactionId: "wx-transaction-reconciliation",
        paidAt: new Date().toISOString()
      });
      const refund = appendRefund(harness, order, {
        providerRefundId: "wx-refund-reconciliation"
      });
      (
        harness.service as unknown as {
          callWechatApi(): Promise<Record<string, unknown>>;
        }
      ).callWechatApi = async () => ({
        refund_id: "wx-refund-reconciliation",
        out_refund_no: refund.refundNo,
        transaction_id: order.providerTransactionId,
        out_trade_no: order.paymentNo,
        status: "SUCCESS",
        amount: {
          total: order.amount,
          refund: refund.amount,
          currency: "CNY"
        },
        ...invalid
      });

      await assert.rejects(
        harness.service.reconcileRefund(refund.id, admin)
      );
      assert.equal(refund.status, "pending");
      assert.equal(refund.providerOutcome, "unknown");
      assert.equal(order.status, "paid");
    }
  });

  test("支付宝退款查询仅在返回完整匹配的退款数据时确认成功", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      provider: "alipay",
      status: "paid",
      providerOrderId: "ali-transaction-reconciliation",
      providerTransactionId: "ali-transaction-reconciliation",
      paidAt: new Date().toISOString()
    });
    const refund = appendRefund(harness, order, {
      provider: "alipay"
    });
    refund.providerRefundId = refund.refundNo;
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    (
      harness.service as unknown as {
        callAlipayGateway(
          method: string,
          params: Record<string, string>
        ): Promise<Record<string, unknown>>;
      }
    ).callAlipayGateway = async (method, params) => {
      calls.push({ method, params });
      return {
        code: "10000",
        seller_id: "ali-seller-reconciliation",
        trade_no: order.providerTransactionId,
        out_trade_no: order.paymentNo,
        out_request_no: refund.refundNo,
        total_amount: "10.00",
        refund_amount: "10.00",
        refund_reason: "sensitive-free-text-must-not-persist"
      };
    };

    const result = await harness.service.reconcileRefund(refund.id, admin);

    assert.equal(result.status, "success");
    assert.equal(result.providerOutcome, "success");
    assert.equal(order.status, "refunded");
    assert.equal(calls[0]?.method, "alipay.trade.fastpay.refund.query");
    assert.deepEqual(JSON.parse(calls[0]?.params.biz_content ?? "{}"), {
      out_trade_no: order.paymentNo,
      out_request_no: refund.refundNo
    });
    assert.equal(
      JSON.stringify(result.callbackPayload).includes("sensitive-free-text"),
      false
    );
  });

  test("支付宝退款查询任一收款方、退款请求、原交易、订单、金额或币种绑定不一致都保持 pending", async () => {
    const invalidResponses = [
      { seller_id: "other-seller" },
      { trade_no: "other-trade-no" },
      { out_trade_no: "other-payment-no" },
      { out_request_no: "other-refund-no" },
      { total_amount: "9.99" },
      { refund_amount: "9.99" },
      { currency: "USD" }
    ];

    for (const invalid of invalidResponses) {
      const harness = createHarness();
      const order = appendOrder(harness, {
        provider: "alipay",
        status: "paid",
        providerOrderId: "ali-transaction-reconciliation",
        providerTransactionId: "ali-transaction-reconciliation",
        paidAt: new Date().toISOString()
      });
      const refund = appendRefund(harness, order, {
        provider: "alipay"
      });
      const calls: string[] = [];
      (
        harness.service as unknown as {
          callAlipayGateway(method: string): Promise<Record<string, unknown>>;
        }
      ).callAlipayGateway = async (method) => {
        calls.push(method);
        return {
          code: "10000",
          seller_id: "ali-seller-reconciliation",
          trade_no: order.providerTransactionId,
          out_trade_no: order.paymentNo,
          out_request_no: refund.refundNo,
          total_amount: "10.00",
          refund_amount: "10.00",
          ...invalid
        };
      };

      await assert.rejects(
        harness.service.reconcileRefund(refund.id, admin)
      );
      assert.equal(refund.status, "pending");
      assert.equal(refund.providerOutcome, "unknown");
      assert.equal(order.status, "paid");
      assert.deepEqual(calls, ["alipay.trade.fastpay.refund.query"]);
    }
  });

  test("退款查询明确不存在时复用原退款号重投，绝不新建第二条退款意图", async () => {
    {
      const harness = createHarness();
      const order = appendOrder(harness, {
        status: "paid",
        providerTransactionId: "wx-transaction-reconciliation",
        paidAt: new Date().toISOString()
      });
      const refund = appendRefund(harness, order);
      const calls: Array<{
        method: string;
        path: string;
        body?: Record<string, unknown>;
      }> = [];
      (
        harness.service as unknown as {
          callWechatApi(
            method: string,
            path: string,
            body?: Record<string, unknown>
          ): Promise<Record<string, unknown>>;
        }
      ).callWechatApi = async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET") {
          throw new BadGatewayException({
            message: "微信退款查询明确返回退款单不存在。",
            providerCode: "RESOURCE_NOT_EXISTS"
          });
        }
        return {
          refund_id: "wx-refund-retry-same-no",
          out_refund_no: refund.refundNo,
          transaction_id: order.providerTransactionId,
          out_trade_no: order.paymentNo,
          status: "PROCESSING",
          amount: {
            total: order.amount,
            refund: refund.amount,
            currency: "CNY"
          }
        };
      };

      const result = await harness.service.reconcileRefund(refund.id, admin);

      assert.equal(result.id, refund.id);
      assert.equal(result.refundNo, refund.refundNo);
      assert.equal(result.status, "pending");
      assert.equal(harness.store.paymentRefunds.length, 1);
      assert.deepEqual(
        calls.map((entry) => entry.method),
        ["GET", "POST"]
      );
      assert.equal(calls[1]?.body?.out_refund_no, refund.refundNo);
    }

    {
      const harness = createHarness();
      const order = appendOrder(harness, {
        provider: "alipay",
        status: "paid",
        providerOrderId: "ali-transaction-reconciliation",
        providerTransactionId: "ali-transaction-reconciliation",
        paidAt: new Date().toISOString()
      });
      const refund = appendRefund(harness, order, {
        provider: "alipay"
      });
      const calls: Array<{ method: string; params: Record<string, string> }> = [];
      (
        harness.service as unknown as {
          callAlipayGateway(
            method: string,
            params: Record<string, string>
          ): Promise<Record<string, unknown>>;
        }
      ).callAlipayGateway = async (method, params) => {
        calls.push({ method, params });
        if (method === "alipay.trade.fastpay.refund.query") {
          return {
            code: "10000",
            msg: "Success"
          };
        }
        return {
          code: "10000",
          trade_no: order.providerTransactionId,
          out_trade_no: order.paymentNo,
          out_request_no: refund.refundNo,
          refund_fee: "10.00",
          fund_change: "Y"
        };
      };

      const result = await harness.service.reconcileRefund(refund.id, admin);

      assert.equal(result.id, refund.id);
      assert.equal(result.refundNo, refund.refundNo);
      assert.equal(result.status, "success");
      assert.equal(harness.store.paymentRefunds.length, 1);
      assert.deepEqual(
        calls.map((entry) => entry.method),
        ["alipay.trade.fastpay.refund.query", "alipay.trade.refund"]
      );
      assert.equal(
        JSON.parse(calls[1]?.params.biz_content ?? "{}").out_request_no,
        refund.refundNo
      );
    }
  });

  test("微信退款成功回调与同业务付款回写共用业务锁和退款锁", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      eventId: "event-refund-callback-lock",
      orderNo: "order-refund-callback-lock",
      status: "paid",
      providerTransactionId: "transaction-refund-callback-lock",
      paidAt: new Date().toISOString()
    });
    const refund = appendRefund(harness, order);
    Object.assign(harness.service as object, {
      parseWechatRefundPayload() {
        return {
          provider: "wechat",
          paymentNo: order.paymentNo,
          refundNo: refund.refundNo,
          providerRefundId: "provider-refund-callback-lock",
          providerTransactionId: order.providerTransactionId,
          status: "success",
          amount: refund.amount,
          totalAmount: order.amount,
          callbackPayload: { source: "signed-wechat-callback" }
        };
      }
    });

    let releaseBusinessLock!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBusinessLock = resolve;
    });
    let lockEntered = false;
    const financialOperations = (
      harness.service as unknown as {
        financialOperations: {
          run<T>(
            eventId: string,
            businessOrderNo: string,
            action: () => Promise<T>
          ): Promise<T>;
        };
      }
    ).financialOperations;
    const blocker = financialOperations.run(
      order.eventId!,
      order.orderNo!,
      async () => {
        lockEntered = true;
        await gate;
      }
    );
    while (!lockEntered) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    let callbackSettled = false;
    const callback = harness.service
      .handleWechatRefundCallback({}, {})
      .finally(() => {
        callbackSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(callbackSettled, false);
    assert.equal(refund.status, "pending");

    releaseBusinessLock();
    await blocker;
    await callback;
    assert.equal(refund.status, "success");
    assert.equal(order.status, "refunded");
  });

  test("微信关单前先查询未支付，关单后再查询确认关闭才更新本地状态", async () => {
    const harness = createHarness();
    const order = appendOrder(harness);
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const responses = ["NOTPAY", "CLOSED"];
    (
      harness.service as unknown as {
        callWechatApi(
          method: string,
          path: string,
          body?: Record<string, unknown>
        ): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST") {
        return {};
      }
      const tradeState = responses.shift();
      return {
        appid: "wx-app-reconciliation",
        mchid: "wx-mch-reconciliation",
        out_trade_no: order.paymentNo,
        trade_state: tradeState,
        amount: {
          total: order.amount,
          currency: "CNY"
        }
      };
    };

    const result = await (
      harness.service as unknown as {
        closeUnpaidOrder(
          id: string,
          actor: typeof admin
        ): Promise<PaymentOrderRecord>;
      }
    ).closeUnpaidOrder(order.id, admin);

    assert.equal(result.status, "closed");
    assert.ok(result.closedAt);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["GET", "POST", "GET"]
    );
    assert.deepEqual(calls[1]?.body, {
      mchid: "wx-mch-reconciliation"
    });
    assert.match(calls[1]?.path ?? "", /\/close$/);
  });

  test("支付宝关单前先确认等待付款，且仅接受交易号与商户订单号都匹配的关单响应", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      provider: "alipay",
      providerOrderId: "ali-trade-reconciliation"
    });
    const calls: Array<{ method: string; params: Record<string, string> }> = [];
    (
      harness.service as unknown as {
        callAlipayGateway(
          method: string,
          params: Record<string, string>
        ): Promise<Record<string, unknown>>;
      }
    ).callAlipayGateway = async (method, params) => {
      calls.push({ method, params });
      if (method === "alipay.trade.close") {
        return {
          code: "10000",
          trade_no: "ali-trade-reconciliation",
          out_trade_no: order.paymentNo
        };
      }
      return {
        code: "10000",
        seller_id: "ali-seller-reconciliation",
        out_trade_no: order.paymentNo,
        trade_no: "ali-trade-reconciliation",
        trade_status: "WAIT_BUYER_PAY",
        total_amount: "10.00"
      };
    };

    const result = await harness.service.closeUnpaidOrder(order.id, admin);

    assert.equal(result.status, "closed");
    assert.ok(result.closedAt);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["alipay.trade.query", "alipay.trade.close"]
    );
    assert.deepEqual(JSON.parse(calls[1]?.params.biz_content ?? "{}"), {
      out_trade_no: order.paymentNo
    });
  });

  test("关单前查询若发现已经支付，只完成入账且绝不调用关单接口", async () => {
    const harness = createHarness();
    const order = appendOrder(harness);
    const calls: Array<{ method: string; path: string }> = [];
    (
      harness.service as unknown as {
        callWechatApi(
          method: string,
          path: string
        ): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async (method, path) => {
      calls.push({ method, path });
      return {
        appid: "wx-app-reconciliation",
        mchid: "wx-mch-reconciliation",
        out_trade_no: order.paymentNo,
        transaction_id: "wx-paid-before-close",
        trade_state: "SUCCESS",
        amount: {
          total: order.amount,
          currency: "CNY"
        }
      };
    };

    const result = await harness.service.closeUnpaidOrder(order.id, admin);

    assert.equal(result.status, "paid");
    assert.equal(result.providerTransactionId, "wx-paid-before-close");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls.some((entry) => entry.path.endsWith("/close")), false);
  });

  test("关单响应或关单后复查未严格确认关闭时，本地订单继续保持 pending", async () => {
    {
      const harness = createHarness();
      const order = appendOrder(harness);
      (
        harness.service as unknown as {
          callWechatApi(
            method: string
          ): Promise<Record<string, unknown>>;
        }
      ).callWechatApi = async (method) =>
        method === "POST"
          ? {}
          : {
              appid: "wx-app-reconciliation",
              mchid: "wx-mch-reconciliation",
              out_trade_no: order.paymentNo,
              trade_state: "NOTPAY",
              amount: {
                total: order.amount,
                currency: "CNY"
              }
            };

      await assert.rejects(
        harness.service.closeUnpaidOrder(order.id, admin),
        /复查未确认关闭/
      );
      assert.equal(order.status, "pending");
    }

    {
      const harness = createHarness();
      const order = appendOrder(harness, {
        provider: "alipay",
        providerOrderId: "ali-trade-reconciliation"
      });
      (
        harness.service as unknown as {
          callAlipayGateway(
            method: string
          ): Promise<Record<string, unknown>>;
        }
      ).callAlipayGateway = async (method) =>
        method === "alipay.trade.close"
          ? {
              code: "10000",
              trade_no: "ali-trade-reconciliation",
              out_trade_no: "other-payment-no"
            }
          : {
              code: "10000",
              seller_id: "ali-seller-reconciliation",
              out_trade_no: order.paymentNo,
              trade_no: "ali-trade-reconciliation",
              trade_status: "WAIT_BUYER_PAY",
              total_amount: "10.00"
            };

      await assert.rejects(
        harness.service.closeUnpaidOrder(order.id, admin),
        /商户订单号不匹配/
      );
      assert.equal(order.status, "pending");
    }
  });

  test("支付单仅在受控手工核对跨越宽限期且多次明确不存在后才标记失败", async () => {
    const harness = createHarness({
      PAYMENT_NOT_FOUND_CONFIRMATIONS: "2",
      PAYMENT_NOT_FOUND_GRACE_SECONDS: "60"
    });
    const order = appendOrder(harness);
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => {
      throw new BadGatewayException({
        message: "微信支付查询明确返回订单不存在。",
        providerCode: "ORDER_NOT_EXIST"
      });
    };

    await assert.rejects(
      harness.service.reconcileOrder(order.id, admin),
      /订单不存在/
    );
    assert.equal(order.status, "pending");
    assert.equal(order.metadata?.providerNotFoundCount, 1);
    order.metadata = {
      ...(order.metadata ?? {}),
      providerNotFoundFirstAt: new Date(Date.now() - 61_000).toISOString()
    };

    const result = await harness.service.reconcileOrder(order.id, admin);

    assert.equal(result.status, "failed");
    assert.equal(result.metadata?.providerNotFoundCount, 2);
    assert.match(result.failReason ?? "", /多次确认.*不存在/);

    const unknownHarness = createHarness();
    const unknownOrder = appendOrder(unknownHarness);
    (
      unknownHarness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => {
      throw new BadGatewayException({
        message: "微信支付接口系统繁忙。",
        providerCode: "SYSTEM_ERROR"
      });
    };
    await assert.rejects(
      unknownHarness.service.reconcileOrder(unknownOrder.id, admin),
      /系统繁忙/
    );
    assert.equal(unknownOrder.status, "pending");
    assert.equal(unknownOrder.metadata?.providerNotFoundCount, undefined);
  });

  test("已释放的旧支付意图晚到可信付款仍入账，且与新支付冲突时阻断回写并告警", async () => {
    const harness = createHarness();
    const releasedOrder = appendOrder(harness, {
      eventId: "event-late-payment-after-release",
      orderNo: "order-late-payment-after-release",
      status: "failed",
      failReason: "支付渠道已确认不存在。",
      metadata: {
        simulated: false,
        providerCreateOutcome: "not_found_confirmed",
        providerNotFoundCount: 2
      }
    });
    appendOrder(harness, {
      eventId: releasedOrder.eventId,
      orderNo: releasedOrder.orderNo,
      status: "paid",
      providerTransactionId: "replacement-payment-transaction",
      paidAt: new Date().toISOString()
    });
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => ({
      appid: "wx-app-reconciliation",
      mchid: "wx-mch-reconciliation",
      out_trade_no: releasedOrder.paymentNo,
      transaction_id: "late-provider-transaction",
      trade_state: "SUCCESS",
      amount: {
        total: releasedOrder.amount,
        currency: releasedOrder.currency
      }
    });

    const result = await harness.service.reconcileOrder(releasedOrder.id, admin);

    assert.equal(result.status, "paid");
    assert.equal(result.providerTransactionId, "late-provider-transaction");
    assert.equal(result.metadata?.reconciliationState, "duplicate_payment");
    assert.equal(result.metadata?.smartVmForwardState, "blocked");
    assert.equal(result.metadata?.providerCreateOutcome, "not_found_confirmed");
    assert.equal(harness.paymentAlerts.length, 1);
  });

  test("人工核对不会把已关闭或普通失败终态回退成待支付", async () => {
    const harness = createHarness();
    const closed = appendOrder(harness, {
      status: "closed",
      closedAt: "2026-07-19T00:00:00.000Z"
    });
    const failed = appendOrder(harness, {
      status: "failed",
      failReason: "渠道已确认失败"
    });
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => ({
      state: "pending",
      closable: true,
      summary: { source: "stale-provider-pending" }
    });

    assert.equal(
      (await harness.service.reconcileOrder(closed.id, admin)).status,
      "closed"
    );
    assert.equal(
      (await harness.service.reconcileOrder(failed.id, admin)).status,
      "failed"
    );
    assert.equal(closed.closedAt, "2026-07-19T00:00:00.000Z");
    assert.equal(failed.failReason, "渠道已确认失败");
  });

  test("终态支付单遇到渠道订单不存在异常时不回退状态或写入新证据", async () => {
    const harness = createHarness();
    const closed = appendOrder(harness, {
      status: "closed",
      closedAt: "2026-07-19T00:00:00.000Z",
      metadata: {
        simulated: false,
        terminalMarker: "closed-original"
      }
    });
    const failed = appendOrder(harness, {
      status: "failed",
      failReason: "渠道已确认失败",
      metadata: {
        simulated: false,
        terminalMarker: "failed-original"
      }
    });
    const closedBefore = structuredClone(closed);
    const failedBefore = structuredClone(failed);
    const persistCallsBefore = harness.persistCalls;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      throw new BadGatewayException({
        message: "微信支付查询明确返回订单不存在。",
        providerCode: "ORDER_NOT_EXIST"
      });
    };

    await assert.rejects(
      harness.service.reconcileOrder(closed.id, admin),
      /订单不存在/
    );
    await assert.rejects(
      harness.service.reconcileOrder(failed.id, admin),
      /订单不存在/
    );

    assert.deepEqual(closed, closedBefore);
    assert.deepEqual(failed, failedBefore);
    assert.equal(harness.persistCalls, persistCallsBefore);
  });
});

describe("支付与退款后台自动对账", () => {
  test("到期的真实支付单会被自动查单并持久化下一次退避时间，未到期时不会重复打渠道", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const dueAt = "2026-07-19T01:00:00.000Z";
    const order = appendOrder(harness, {
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: dueAt
        }
      }
    });
    let queryCalls = 0;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      queryCalls += 1;
      return {
        state: "pending",
        closable: false,
        summary: { source: "automatic-query", state: "USERPAYING" }
      };
    };
    const automatic = harness.service as unknown as {
      runAutomaticReconciliationCycle(options: {
        now: Date;
        limit?: number;
      }): Promise<{ attempted: number; pending: number }>;
    };

    const first = await automatic.runAutomaticReconciliationCycle({
      now: new Date(dueAt)
    });
    assert.equal(first.attempted, 1);
    assert.equal(first.pending, 1);
    assert.equal(queryCalls, 1);

    const state = (
      order.metadata?.reconciliation as {
        state: string;
        attemptCount: number;
        nextAttemptAt: string;
      }
    );
    assert.equal(state.state, "scheduled");
    assert.equal(state.attemptCount, 1);
    assert.equal(state.nextAttemptAt, "2026-07-19T01:00:02.000Z");

    const second = await automatic.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T01:00:01.000Z")
    });
    assert.equal(second.attempted, 0);
    assert.equal(queryCalls, 1);
  });

  test("自动对账在支付渠道响应后发现运行时安全门禁失效时不修改或持久化账本", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const dueAt = "2026-07-19T01:00:00.000Z";
    const order = appendOrder(harness, {
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: dueAt
        }
      }
    });
    let runtimeSafe = true;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      runtimeSafe = false;
      return {
        state: "pending",
        closable: false,
        summary: { source: "automatic-query", state: "USERPAYING" }
      };
    };
    const automatic = harness.service as unknown as {
      runAutomaticReconciliationCycle(options: {
        now: Date;
        assertRuntimeSafety?: () => void;
      }): Promise<unknown>;
    };
    const persistCallsBefore = harness.persistCalls;
    const orderBefore = structuredClone(order);

    await assert.rejects(
      automatic.runAutomaticReconciliationCycle({
        now: new Date(dueAt),
        assertRuntimeSafety: () => {
          if (!runtimeSafe) {
            throw new Error("automatic-reconciliation-safety-unavailable");
          }
        }
      }),
      /automatic-reconciliation-safety-unavailable/
    );

    assert.deepEqual(order, orderBefore);
    assert.equal(harness.persistCalls, persistCallsBefore);
  });

  test("待确认退款也会复用原退款单自动查单并持久化退避状态", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const dueAt = "2026-07-19T02:00:00.000Z";
    const order = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-original-automatic-refund",
      paidAt: "2026-07-19T01:30:00.000Z"
    });
    const refund = appendRefund(harness, order);
    (
      refund as PaymentRefundRecord & {
        reconciliation?: Record<string, unknown>;
      }
    ).reconciliation = {
      state: "scheduled",
      attemptCount: 0,
      nextAttemptAt: dueAt
    };
    let queryCalls = 0;
    (
      harness.service as unknown as {
        callWechatApi(
          method: string,
          path: string
        ): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => {
      queryCalls += 1;
      return {
        refund_id: "wx-refund-automatic",
        out_refund_no: refund.refundNo,
        transaction_id: order.providerTransactionId,
        out_trade_no: order.paymentNo,
        status: "PROCESSING",
        amount: {
          total: order.amount,
          refund: refund.amount,
          currency: "CNY"
        }
      };
    };
    const automatic = harness.service as unknown as {
      runAutomaticReconciliationCycle(options: {
        now: Date;
      }): Promise<{ attempted: number; pending: number }>;
    };

    const result = await automatic.runAutomaticReconciliationCycle({
      now: new Date(dueAt)
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.pending, 1);
    assert.equal(queryCalls, 1);
    assert.deepEqual(
      (
        refund as PaymentRefundRecord & {
          reconciliation?: {
            state: string;
            attemptCount: number;
            nextAttemptAt: string;
          };
        }
      ).reconciliation,
      {
        state: "scheduled",
        attemptCount: 1,
        lastAttemptAt: dueAt,
        lastResult: "pending",
        nextAttemptAt: "2026-07-19T02:00:02.000Z"
      }
    );
  });

  test("自动对账在退款渠道响应后发现运行时安全门禁失效时不修改或持久化账本", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const dueAt = "2026-07-19T02:00:00.000Z";
    const order = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-runtime-safety-refund",
      paidAt: "2026-07-19T01:30:00.000Z"
    });
    const refund = appendRefund(harness, order);
    (
      refund as PaymentRefundRecord & {
        reconciliation?: Record<string, unknown>;
      }
    ).reconciliation = {
      state: "scheduled",
      attemptCount: 0,
      nextAttemptAt: dueAt
    };
    let runtimeSafe = true;
    (
      harness.service as unknown as {
        callWechatApi(
          method: string,
          path: string
        ): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => {
      runtimeSafe = false;
      return {
        refund_id: "wx-runtime-safety-refund",
        out_refund_no: refund.refundNo,
        transaction_id: order.providerTransactionId,
        out_trade_no: order.paymentNo,
        status: "PROCESSING",
        amount: {
          total: order.amount,
          refund: refund.amount,
          currency: "CNY"
        }
      };
    };
    const automatic = harness.service as unknown as {
      runAutomaticReconciliationCycle(options: {
        now: Date;
        assertRuntimeSafety?: () => void;
      }): Promise<unknown>;
    };
    const persistCallsBefore = harness.persistCalls;
    const orderBefore = structuredClone(order);
    const refundBefore = structuredClone(refund);

    await assert.rejects(
      automatic.runAutomaticReconciliationCycle({
        now: new Date(dueAt),
        assertRuntimeSafety: () => {
          if (!runtimeSafe) {
            throw new Error("automatic-reconciliation-safety-unavailable");
          }
        }
      }),
      /automatic-reconciliation-safety-unavailable/
    );

    assert.deepEqual(order, orderBefore);
    assert.deepEqual(refund, refundBefore);
    assert.equal(harness.persistCalls, persistCallsBefore);
  });

  test("自动查单连续失败会指数退避并只生成一次人工核对告警，不会擅自把资金判为失败", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000",
      PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS: "2"
    });
    const order = appendOrder(harness, {
      eventId: "event-automatic-alert",
      deviceCode: "VM-AUTOMATIC-ALERT",
      payerUserId: "special-automatic-alert",
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: "2026-07-19T03:00:00.000Z"
        }
      }
    });
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      throw new BadGatewayException("渠道查询暂时超时");
    };

    await harness.service.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T03:00:00.000Z")
    });
    assert.equal(order.status, "pending");
    assert.equal(harness.paymentAlerts.length, 0);

    await harness.service.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T03:00:02.000Z")
    });
    assert.equal(order.status, "pending");
    assert.equal(harness.paymentAlerts.length, 1);

    await harness.service.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T03:00:06.000Z")
    });
    assert.equal(order.status, "pending");
    assert.equal(harness.paymentAlerts.length, 1);
    const state = order.metadata?.reconciliation as {
      attemptCount: number;
      nextAttemptAt: string;
      alertedAt?: string;
    };
    assert.equal(state.attemptCount, 3);
    assert.equal(state.nextAttemptAt, "2026-07-19T03:00:14.000Z");
    assert.equal(state.alertedAt, "2026-07-19T03:00:02.000Z");
  });

  test("服务重建后会沿用已持久化的下一次核对时间，不会丢失或提前重复查单", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const order = appendOrder(harness, {
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: "2026-07-19T04:00:00.000Z"
        }
      }
    });
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      throw new BadGatewayException("首次查询暂时失败");
    };
    await harness.service.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T04:00:00.000Z")
    });

    let restartedQueryCalls = 0;
    const restarted = new PaymentsService(
      harness.store as unknown as InMemoryStoreService,
      harness.config,
      {
        async notifyConfirmedPaymentSuccess() {
          return {};
        }
      } as unknown as CabinetEventsService,
      {
        markRefund() {
          return {};
        }
      } as unknown as InventoryOrdersService,
      new PaymentPayerIdentityHandleService(harness.config),
      {
        create(payload: unknown) {
          return payload;
        }
      } as unknown as AlertsService
    );
    (
      restarted as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      restartedQueryCalls += 1;
      return {
        state: "pending",
        closable: false,
        summary: { source: "restart-recovery" }
      };
    };

    const beforeDue = await restarted.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T04:00:01.000Z")
    });
    assert.equal(beforeDue.attempted, 0);
    assert.equal(restartedQueryCalls, 0);

    const atDue = await restarted.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T04:00:02.000Z")
    });
    assert.equal(atDue.attempted, 1);
    assert.equal(restartedQueryCalls, 1);
    assert.equal(
      (order.metadata?.reconciliation as { attemptCount: number }).attemptCount,
      2
    );
  });

  test("自动核对确认支付成功后复用既有入账路径并把对账任务标记为完成", async () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 1,
          nextAttemptAt: "2026-07-19T05:00:00.000Z"
        }
      }
    });
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => ({
      state: "paid",
      providerTransactionId: "wx-automatic-terminal-success",
      closable: false,
      summary: { source: "automatic-terminal-success" }
    });

    const result = await harness.service.runAutomaticReconciliationCycle({
      now: new Date("2026-07-19T05:00:00.000Z")
    });

    assert.equal(result.completed, 1);
    assert.equal(order.status, "paid");
    assert.equal(order.providerTransactionId, "wx-automatic-terminal-success");
    assert.deepEqual(order.metadata?.reconciliation, {
      state: "completed",
      attemptCount: 2,
      lastAttemptAt: "2026-07-19T05:00:00.000Z",
      lastCompletedAt: "2026-07-19T05:00:00.000Z",
      lastResult: "paid"
    });
  });

  test("自动对账在柜机付款回写返回后发现运行时安全门禁失效时不完成后续账本写入", async () => {
    const harness = createHarness();
    const dueAt = "2026-07-19T05:30:00.000Z";
    const order = appendOrder(harness, {
      eventId: "event-runtime-safety-smartvm",
      orderNo: "order-runtime-safety-smartvm",
      deviceCode: "VM-RUNTIME-SAFETY-SMARTVM",
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: dueAt
        }
      }
    });
    let runtimeSafe = true;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
        cabinetEventsService: {
          notifyConfirmedPaymentSuccess(): Promise<unknown>;
        };
      }
    ).queryProviderPayment = async () => ({
      state: "paid",
      providerTransactionId: "wx-runtime-safety-smartvm",
      closable: false,
      summary: { source: "automatic-runtime-safety-smartvm" }
    });
    (
      harness.service as unknown as {
        cabinetEventsService: {
          notifyConfirmedPaymentSuccess(): Promise<unknown>;
        };
      }
    ).cabinetEventsService = {
      async notifyConfirmedPaymentSuccess() {
        runtimeSafe = false;
        return {};
      }
    };
    const automatic = harness.service as unknown as {
      runAutomaticReconciliationCycle(options: {
        now: Date;
        assertRuntimeSafety?: () => void;
      }): Promise<unknown>;
    };

    await assert.rejects(
      automatic.runAutomaticReconciliationCycle({
        now: new Date(dueAt),
        assertRuntimeSafety: () => {
          if (!runtimeSafe) {
            throw new Error("automatic-reconciliation-safety-unavailable");
          }
        }
      }),
      /automatic-reconciliation-safety-unavailable/
    );

    assert.equal(order.status, "paid");
    assert.equal(order.metadata?.smartVmForwardState, "submitting");
    assert.deepEqual(order.metadata?.reconciliation, {
      state: "scheduled",
      attemptCount: 0,
      nextAttemptAt: dueAt
    });
    assert.equal(harness.persistCalls, 2);
  });

  test("支付已入账但柜机回写失败时，服务重启后会复用原交易号自动补回写", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const dueAt = "2026-07-19T06:00:00.000Z";
    const order = appendOrder(harness, {
      eventId: "event-smartvm-recovery",
      orderNo: "order-smartvm-recovery",
      deviceCode: "VM-SMARTVM-RECOVERY",
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: dueAt
        }
      }
    });
    let forwardCalls = 0;
    (
      harness.service as unknown as {
        cabinetEventsService: {
          notifyConfirmedPaymentSuccess(): Promise<unknown>;
        };
      }
    ).cabinetEventsService = {
      async notifyConfirmedPaymentSuccess() {
        forwardCalls += 1;
        throw new BadGatewayException("首次柜机回写暂时失败");
      }
    };
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => ({
      state: "paid",
      providerTransactionId: "wx-original-smartvm-transaction",
      closable: false,
      summary: { source: "paid-before-forward-failure" }
    });

    const first = await harness.service.runAutomaticReconciliationCycle({
      now: new Date(dueAt)
    });
    assert.equal(first.failed, 1);
    assert.equal(order.status, "paid");
    assert.equal(order.providerTransactionId, "wx-original-smartvm-transaction");
    assert.equal(order.metadata?.smartVmForwardState, "pending");
    assert.equal(forwardCalls, 1);

    let restartedQueryCalls = 0;
    const restarted = new PaymentsService(
      harness.store as unknown as InMemoryStoreService,
      harness.config,
      {
        async notifyConfirmedPaymentSuccess(payload: {
          transactionId: string;
        }) {
          forwardCalls += 1;
          assert.equal(
            payload.transactionId,
            "wx-original-smartvm-transaction"
          );
          return {};
        }
      } as unknown as CabinetEventsService,
      {
        markRefund() {
          return {};
        }
      } as unknown as InventoryOrdersService,
      new PaymentPayerIdentityHandleService(harness.config),
      {
        create(payload: unknown) {
          return payload;
        }
      } as unknown as AlertsService
    );
    (
      restarted as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      restartedQueryCalls += 1;
      throw new Error("已支付补回写不应再次查询或创建支付交易");
    };
    const nextAttemptAt = (
      order.metadata?.reconciliation as { nextAttemptAt: string }
    ).nextAttemptAt;

    const second = await restarted.runAutomaticReconciliationCycle({
      now: new Date(nextAttemptAt)
    });
    assert.equal(second.completed, 1);
    assert.equal(restartedQueryCalls, 0);
    assert.equal(forwardCalls, 2);
    assert.equal(order.metadata?.smartVmForwardState, "completed");
    assert.equal(
      (order.metadata?.reconciliation as { state: string }).state,
      "completed"
    );
  });

  test("支付积压不会占满整个批次，已到期退款始终保留自动核对配额", async () => {
    const harness = createHarness();
    const dueAt = "2026-07-19T07:00:00.000Z";
    for (let index = 0; index < 3; index += 1) {
      appendOrder(harness, {
        metadata: {
          simulated: false,
          reconciliation: {
            state: "scheduled",
            attemptCount: 0,
            nextAttemptAt: dueAt
          }
        }
      });
    }
    const paidOrder = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-refund-fairness",
      paidAt: "2026-07-19T06:30:00.000Z"
    });
    const refund = appendRefund(harness, paidOrder);
    refund.reconciliation = {
      state: "scheduled",
      attemptCount: 0,
      nextAttemptAt: dueAt
    };
    let paymentQueries = 0;
    let refundQueries = 0;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      paymentQueries += 1;
      return {
        state: "pending",
        closable: false,
        summary: { source: "fairness-payment" }
      };
    };
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => {
      refundQueries += 1;
      return {
        refund_id: "wx-refund-fairness-provider",
        out_refund_no: refund.refundNo,
        transaction_id: paidOrder.providerTransactionId,
        out_trade_no: paidOrder.paymentNo,
        status: "PROCESSING",
        amount: {
          total: paidOrder.amount,
          refund: refund.amount,
          currency: "CNY"
        }
      };
    };

    const result = await harness.service.runAutomaticReconciliationCycle({
      now: new Date(dueAt),
      limit: 2
    });
    assert.equal(result.attempted, 2);
    assert.equal(paymentQueries, 1);
    assert.equal(refundQueries, 1);
  });

  test("单槽批次按最早到期项选择，并在连续轮次中让支付与退款都获得核对机会", async () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "1000",
      PAYMENT_RECONCILIATION_MAX_DELAY_MS: "8000"
    });
    const dueAt = "2026-07-19T07:30:00.000Z";
    appendOrder(harness, {
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 0,
          nextAttemptAt: dueAt
        }
      }
    });
    const paidOrder = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-single-slot-refund",
      paidAt: "2026-07-19T07:00:00.000Z"
    });
    const refund = appendRefund(harness, paidOrder);
    refund.reconciliation = {
      state: "scheduled",
      attemptCount: 0,
      nextAttemptAt: dueAt
    };
    let paymentQueries = 0;
    let refundQueries = 0;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      paymentQueries += 1;
      return {
        state: "pending",
        closable: false,
        summary: { source: "single-slot-payment" }
      };
    };
    (
      harness.service as unknown as {
        callWechatApi(): Promise<Record<string, unknown>>;
      }
    ).callWechatApi = async () => {
      refundQueries += 1;
      return {
        refund_id: "wx-single-slot-refund-provider",
        out_refund_no: refund.refundNo,
        transaction_id: paidOrder.providerTransactionId,
        out_trade_no: paidOrder.paymentNo,
        status: "PROCESSING",
        amount: {
          total: paidOrder.amount,
          refund: refund.amount,
          currency: "CNY"
        }
      };
    };

    const first = await harness.service.runAutomaticReconciliationCycle({
      now: new Date(dueAt),
      limit: 1
    });
    const second = await harness.service.runAutomaticReconciliationCycle({
      now: new Date(dueAt),
      limit: 1
    });

    assert.equal(first.attempted, 1);
    assert.equal(second.attempted, 1);
    assert.equal(refundQueries, 1);
    assert.equal(paymentQueries, 1);
  });
});

describe("特殊群体本人安全请求支付核对", () => {
  test("控制器入口只开放给特殊群体本人，不复用后台同步查单权限", () => {
    const handler = (
      PaymentsController.prototype as unknown as Record<string, object>
    ).requestOwnOrderReconciliation;
    assert.equal(typeof handler, "function");
    assert.deepEqual(Reflect.getMetadata(ALLOWED_ROLES_KEY, handler), ["special"]);
    assert.equal(
      Reflect.getMetadata(ALLOWED_BACKOFFICE_PERMISSIONS_KEY, handler),
      undefined
    );
  });

  test("本人请求只把原支付单提速到后台队列，不在请求线程访问支付渠道", () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_USER_REQUEST_COOLDOWN_MS: "60000"
    });
    const order = appendOrder(harness, {
      payerUserId: "special-self-reconcile",
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 2,
          nextAttemptAt: "2026-07-19T06:30:00.000Z"
        }
      }
    });
    let providerCalls = 0;
    (
      harness.service as unknown as {
        queryProviderPayment(order: PaymentOrderRecord): Promise<unknown>;
      }
    ).queryProviderPayment = async () => {
      providerCalls += 1;
      throw new Error("本人请求线程不应调用渠道");
    };

    const first = harness.service.requestOwnOrderReconciliation(order.id, {
      id: order.payerUserId!,
      role: "special"
    });
    const firstState = {
      ...(order.metadata?.reconciliation as Record<string, unknown>)
    };
    const second = harness.service.requestOwnOrderReconciliation(order.id, {
      id: order.payerUserId!,
      role: "special"
    });

    assert.equal(providerCalls, 0);
    assert.equal(first.order.id, order.id);
    assert.equal(first.order.status, "pending");
    assert.equal(
      second.reconciliation.requestedByUserAt,
      first.reconciliation.requestedByUserAt
    );
    assert.deepEqual(order.metadata?.reconciliation, firstState);
    assert.equal(firstState.state, "scheduled");
    assert.equal(firstState.nextAttemptAt, firstState.requestedByUserAt);
    assert.ok(harness.persistCalls > 0);
  });

  test("不能请求核对他人的、模拟的或已结束的支付单", () => {
    const harness = createHarness();
    const order = appendOrder(harness, {
      payerUserId: "special-owner",
      metadata: { simulated: false }
    });

    assert.throws(
      () =>
        harness.service.requestOwnOrderReconciliation(order.id, {
          id: "special-other",
          role: "special"
        }),
      /无权访问/
    );

    order.metadata = { simulated: true };
    assert.throws(
      () =>
        harness.service.requestOwnOrderReconciliation(order.id, {
          id: "special-owner",
          role: "special"
        }),
      /模拟支付单/
    );

    order.metadata = { simulated: false };
    order.status = "paid";
    assert.throws(
      () =>
        harness.service.requestOwnOrderReconciliation(order.id, {
          id: "special-owner",
          role: "special"
        }),
      /无需再次核对/
    );
  });
});

describe("后台资金恢复可观测性", () => {
  test("支付自检把已入账但 SmartVM 回写未完成的债务计入到期恢复任务", () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_ENABLED: "true"
    });
    appendOrder(harness, {
      status: "paid",
      eventId: "event-diagnostics-smartvm-debt",
      orderNo: "order-diagnostics-smartvm-debt",
      deviceCode: "VM-DIAGNOSTICS-SMARTVM",
      providerTransactionId: "wx-diagnostics-smartvm-debt",
      paidAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      metadata: {
        simulated: false,
        smartVmForwardState: "pending",
        reconciliation: {
          state: "scheduled",
          attemptCount: 1,
          nextAttemptAt: "2026-07-18T00:00:00.000Z"
        }
      }
    });

    const diagnostics = harness.service.getPaymentDiagnostics();

    assert.equal(diagnostics.reconciliation.pendingPayments, 0);
    assert.equal(diagnostics.reconciliation.pendingSmartVmForwards, 1);
    assert.equal(diagnostics.reconciliation.pendingRefunds, 0);
    assert.equal(diagnostics.reconciliation.dueNow, 1);
  });

  test("支付自检汇总真实待确认支付、退款、到期、人工核对与告警数量", () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_ENABLED: "true"
    });
    appendOrder(harness, {
      updatedAt: "2026-07-18T00:00:00.000Z",
      metadata: {
        simulated: false,
        reconciliation: {
          state: "scheduled",
          attemptCount: 2,
          nextAttemptAt: "2026-07-18T00:00:00.000Z",
          alertedAt: "2026-07-18T00:01:00.000Z"
        }
      }
    });
    appendOrder(harness, {
      metadata: {
        simulated: true
      }
    });
    const paidOrder = appendOrder(harness, {
      status: "paid",
      providerTransactionId: "wx-observability-paid",
      paidAt: "2026-07-18T00:00:00.000Z",
      metadata: {
        simulated: false
      }
    });
    appendRefund(harness, paidOrder, {
      reconciliation: {
        state: "manual_review",
        attemptCount: 5,
        alertedAt: "2026-07-18T00:02:00.000Z"
      }
    });

    const diagnostics = harness.service.getPaymentDiagnostics();

    assert.deepEqual(diagnostics.reconciliation, {
      automaticEnabled: true,
      singleWriterEnabled: false,
      singleWriterHeld: false,
      pendingPayments: 1,
      pendingSmartVmForwards: 0,
      pendingRefunds: 1,
      dueNow: 1,
      manualReview: 1,
      alerted: 2
    });
  });

  test("支付自检暴露自动核对最近成功与失败时间，便于发现循环持续失效", () => {
    const harness = createHarness({
      PAYMENT_RECONCILIATION_ENABLED: "true"
    });
    harness.service.recordAutomaticReconciliationStarted(
      new Date("2026-07-19T08:00:00.000Z")
    );
    harness.service.recordAutomaticReconciliationSuccess(
      {
        scanned: 10,
        attempted: 2,
        completed: 1,
        pending: 1,
        failed: 0
      },
      new Date("2026-07-19T08:00:01.000Z")
    );
    harness.service.recordAutomaticReconciliationFailure(
      new Error("运行时配置无效"),
      new Date("2026-07-19T08:01:00.000Z")
    );

    const diagnostics = harness.service.getPaymentDiagnostics();
    assert.equal(
      diagnostics.reconciliation.lastStartedAt,
      "2026-07-19T08:00:00.000Z"
    );
    assert.equal(
      diagnostics.reconciliation.lastSuccessAt,
      "2026-07-19T08:00:01.000Z"
    );
    assert.equal(
      diagnostics.reconciliation.lastErrorAt,
      "2026-07-19T08:01:00.000Z"
    );
    assert.match(
      diagnostics.reconciliation.lastError ?? "",
      /运行时配置无效/
    );
    assert.deepEqual(diagnostics.reconciliation.lastSummary, {
      scanned: 10,
      attempted: 2,
      completed: 1,
      pending: 1,
      failed: 0
    });
  });
});
