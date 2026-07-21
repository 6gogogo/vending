import assert from "node:assert/strict";
import { createCipheriv, createSign, generateKeyPairSync } from "node:crypto";
import { describe, test } from "node:test";

import { ConfigService } from "@nestjs/config";
import type {
  CabinetEventRecord,
  InventoryMovement,
  PaymentOrderCreatePayload,
  PaymentOrderRecord,
  PaymentRefundRecord
} from "@vm/shared-types";

import {
  FinancialOperationCoordinator,
  type FinancialOperationLease
} from "../src/common/coordination/financial-operation-coordinator";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { LegacyRefundController } from "../src/modules/payments/legacy-refund.controller";
import { PaymentPayerIdentityHandleService } from "../src/modules/payments/payment-payer-identity-handle.service";
import { PaymentsService } from "../src/modules/payments/payments.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";

const createEvent = (overrides: Partial<CabinetEventRecord> = {}): CabinetEventRecord => ({
  eventId: "event-payment-1",
  orderNo: "order-payment-1",
  userId: "special-payment-1",
  phone: "13800009999",
  role: "special",
  deviceCode: "CAB-PAYMENT-1",
  doorNum: "1",
  status: "settled",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  amount: 1_000,
  goods: [],
  ...overrides
});

const completeRealWechatConfig = {
  PAYMENT_MODE: "real",
  WECHAT_PAY_APP_ID: "app-id",
  WECHAT_PAY_MCH_ID: "merchant-id",
  WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
  WECHAT_PAY_MERCHANT_PRIVATE_KEY: "private-key",
  WECHAT_PAY_MERCHANT_CERT_SERIAL_NO: "serial",
  WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "platform-serial",
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: "public-key",
  WECHAT_MINI_APP_SECRET: "mini-secret",
  WECHAT_PAY_NOTIFY_URL: "https://payment.example.test/payments/callbacks/wechat",
  WECHAT_PAY_REFUND_NOTIFY_URL: "https://payment.example.test/payments/callbacks/wechat-refund"
};

const createPaymentHarness = (options?: {
  event?: CabinetEventRecord;
  config?: Record<string, string>;
  financialOperations?: FinancialOperationCoordinator;
}) => {
  let sequence = 0;
  const event = options?.event ?? createEvent();
  const operationLogs: unknown[] = [];
  const cabinetPaymentNotifications: unknown[] = [];
  const inventoryRefunds: Array<{
    orderNo: string;
    transactionId: string;
    amount: number;
    options?: unknown;
  }> = [];
  const paymentAlerts: unknown[] = [];
  let persistCalls = 0;
  const store = {
    events: [event],
    users: [],
    goodsCatalog: [],
    paymentOrders: [] as PaymentOrderRecord[],
    paymentRefunds: [] as PaymentRefundRecord[],
    createId(prefix: string) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
    logOperation(entry: unknown) {
      operationLogs.push(entry);
      return entry;
    },
    persist() {
      persistCalls += 1;
    }
  };
  const cabinetEvents = {
    async notifyPaymentSuccess(payload: unknown) {
      cabinetPaymentNotifications.push(payload);
      return payload;
    },
    async notifyConfirmedPaymentSuccess(payload: unknown) {
      cabinetPaymentNotifications.push(payload);
      return payload;
    }
  };
  const inventoryOrders = {
    markRefund(orderNo: string, transactionId: string, amount: number, refundOptions?: unknown) {
      inventoryRefunds.push({ orderNo, transactionId, amount, options: refundOptions });
      return { orderNo, transactionId, amount };
    }
  };
  const config = new ConfigService({
    PAYMENT_MODE: "mock",
    ...options?.config
  });
  const payerIdentityHandles = new PaymentPayerIdentityHandleService(config);
  const service = new PaymentsService(
    store as unknown as InMemoryStoreService,
    config,
    cabinetEvents as unknown as CabinetEventsService,
    inventoryOrders as unknown as InventoryOrdersService,
    payerIdentityHandles,
    {
      create(payload: unknown) {
        paymentAlerts.push(payload);
        return payload;
      }
    } as unknown as AlertsService,
    options?.financialOperations
  );
  let refundRequestSequence = 0;

  return {
    event,
    store,
    service,
    refund(
      payload: Parameters<PaymentsService["refund"]>[0],
      actor?: Parameters<PaymentsService["refund"]>[1],
      idempotencyKey = `test-refund-${++refundRequestSequence}`
    ) {
      return service.refund(payload, actor, idempotencyKey);
    },
    payerIdentityHandles,
    operationLogs,
    cabinetPaymentNotifications,
    inventoryRefunds,
    paymentAlerts,
    get persistCalls() {
      return persistCalls;
    }
  };
};

const appendPaidOrder = (
  harness: ReturnType<typeof createPaymentHarness>,
  overrides: Partial<PaymentOrderRecord> = {}
) => {
  const now = new Date().toISOString();
  const status = overrides.status ?? "paid";
  const order: PaymentOrderRecord = {
    id: `payment-order-${harness.store.paymentOrders.length + 1}`,
    paymentNo: `payment-no-${harness.store.paymentOrders.length + 1}`,
    provider: "wechat",
    phase: "post_settlement",
    status,
    amount: 1_000,
    currency: "CNY",
    subject: "支付完整性测试",
    eventId: harness.event.eventId,
    orderNo: harness.event.orderNo,
    deviceCode: harness.event.deviceCode,
    payerUserId: harness.event.userId,
    providerTransactionId:
      status === "paid" || status === "refunded"
        ? `provider-transaction-${harness.store.paymentOrders.length + 1}`
        : undefined,
    metadata: { simulated: true },
    createdAt: now,
    updatedAt: now,
    paidAt: now,
    ...overrides
  };
  harness.store.paymentOrders.unshift(order);
  return order;
};

const defaultCreatePayload = (
  event: CabinetEventRecord,
  overrides: Partial<PaymentOrderCreatePayload> = {}
): PaymentOrderCreatePayload => ({
  provider: "wechat",
  phase: "post_settlement",
  eventId: event.eventId,
  orderNo: event.orderNo,
  deviceCode: event.deviceCode,
  payerUserId: event.userId,
  ...overrides
});

describe("支付单金额与幂等", () => {
  test("支付宝商户支付单号和退款请求号只使用官方允许的字母数字下划线字符集", () => {
    const harness = createPaymentHarness();
    const privateService = harness.service as unknown as {
      createPaymentNo(provider: "wechat" | "alipay"): string;
      createRefundNo(provider: "wechat" | "alipay"): string;
    };
    const paymentNo = privateService.createPaymentNo("alipay");
    const refundNo = privateService.createRefundNo("alipay");

    assert.match(paymentNo, /^[A-Za-z0-9_]{1,64}$/);
    assert.match(refundNo, /^[A-Za-z0-9_]{1,64}$/);
    assert.equal(paymentNo.includes("-"), false);
    assert.equal(refundNo.includes("-"), false);
  });

  test("拒绝无业务关联或客户端篡改金额，并使用服务端事件金额", async () => {
    const harness = createPaymentHarness();
    const actor = { id: harness.event.userId, role: "special" as const };

    await assert.rejects(
      harness.service.createOrder(
        { provider: "wechat", phase: "post_settlement", amount: 1 },
        actor
      ),
      /必须关联柜机事件或业务订单/
    );
    await assert.rejects(
      harness.service.createOrder(defaultCreatePayload(harness.event, { amount: 1 }), actor),
      /客户端支付金额与服务端业务金额不一致/
    );

    const created = await harness.service.createOrder(defaultCreatePayload(harness.event), actor);
    assert.equal(created.order.amount, harness.event.amount);
    assert.equal(created.order.eventId, harness.event.eventId);
    assert.equal(created.order.orderNo, harness.event.orderNo);
  });

  test("补扣金额只能取事件内关联补扣单金额", async () => {
    const adjustmentEvent = createEvent({
      adjustments: [
        {
          orderNo: "adjustment-1",
          sourceOrderNo: "order-payment-1",
          amount: 275,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    });
    const harness = createPaymentHarness({ event: adjustmentEvent });
    const actor = { id: adjustmentEvent.userId, role: "special" as const };

    await assert.rejects(
      harness.service.createOrder(
        defaultCreatePayload(adjustmentEvent, {
          adjustmentOrderNo: "adjustment-1",
          amount: 274
        }),
        actor
      ),
      /客户端支付金额与服务端业务金额不一致/
    );

    const created = await harness.service.createOrder(
      defaultCreatePayload(adjustmentEvent, { adjustmentOrderNo: "adjustment-1" }),
      actor
    );
    assert.equal(created.order.amount, 275);
    assert.equal(created.order.adjustmentOrderNo, "adjustment-1");
  });

  test("服务端业务金额不是正整数分值时拒绝创建支付单而不是静默取整", async () => {
    for (const event of [
      createEvent({ amount: 1_000.5 }),
      createEvent({
        adjustments: [
          {
            orderNo: "adjustment-fractional",
            sourceOrderNo: "order-payment-1",
            amount: 275.5,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ]
      })
    ]) {
      const harness = createPaymentHarness({ event });
      const actor = { id: event.userId, role: "special" as const };

      await assert.rejects(
        harness.service.createOrder(
          defaultCreatePayload(event, {
            adjustmentOrderNo: event.adjustments?.[0]?.orderNo
          }),
          actor
        ),
        /当前业务事件没有需要支付的有效金额/
      );
      assert.equal(harness.store.paymentOrders.length, 0);
    }
  });

  test("顺序重复和并发重复都只创建一个供应商支付单", async () => {
    const harness = createPaymentHarness();
    const actor = { id: harness.event.userId, role: "special" as const };
    const payload = defaultCreatePayload(harness.event);
    const first = await harness.service.createOrder(payload, actor);
    const second = await harness.service.createOrder(payload, actor);

    assert.equal(second.order.id, first.order.id);
    assert.equal(harness.store.paymentOrders.length, 1);
    await assert.rejects(
      harness.service.createOrder({ ...payload, provider: "alipay" }, actor),
      /已有其他支付渠道的有效支付单/
    );
    assert.equal(harness.store.paymentOrders.length, 1);

    const concurrentHarness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerCalls = 0;
    Object.assign(concurrentHarness.service as object, {
      async createProviderPaymentOrder(order: PaymentOrderRecord) {
        providerCalls += 1;
        await providerGate;
        return {
          providerOrderId: `provider-${order.paymentNo}`,
          invokePayload: { provider: "wechat", simulated: false }
        };
      }
    });
    const concurrentActor = {
      id: concurrentHarness.event.userId,
      role: "special" as const
    };
    const concurrentIdentity = concurrentHarness.payerIdentityHandles.issue(
      "wechat",
      concurrentActor,
      "openid-payment-user"
    );
    const concurrentPayload = defaultCreatePayload(concurrentHarness.event, {
      payerIdentityHandle: concurrentIdentity.handle
    });
    const pendingFirst = concurrentHarness.service.createOrder(concurrentPayload, concurrentActor);
    const pendingSecond = concurrentHarness.service.createOrder(concurrentPayload, concurrentActor);
    releaseProvider();
    const [concurrentFirst, concurrentSecond] = await Promise.all([pendingFirst, pendingSecond]);

    assert.equal(concurrentSecond.order.id, concurrentFirst.order.id);
    assert.equal(providerCalls, 1);
    assert.equal(concurrentHarness.store.paymentOrders.length, 1);
  });

  test("真实支付下单响应丢失后保留同一支付意图，重试不得再次外呼", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    let providerCalls = 0;
    Object.assign(harness.service as object, {
      async createProviderPaymentOrder() {
        providerCalls += 1;
        throw new Error("供应商可能已受理，但本地响应丢失");
      }
    });
    const actor = { id: harness.event.userId, role: "special" as const };
    const identity = harness.payerIdentityHandles.issue(
      "wechat",
      actor,
      "openid-payment-user"
    );
    const payload = defaultCreatePayload(harness.event, {
      payerIdentityHandle: identity.handle
    });

    await assert.rejects(
      harness.service.createOrder(payload, actor),
      /本地响应丢失/
    );
    const replay = await harness.service.createOrder(payload, actor);

    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentOrders.length, 1);
    assert.equal(replay.order.id, harness.store.paymentOrders[0]?.id);
    assert.equal(replay.order.status, "pending");
    assert.equal(replay.order.metadata?.providerCreateOutcome, "unknown");
    assert.deepEqual(replay.invokePayload, {});
    assert.ok(harness.persistCalls >= 1);
  });

  test("已退款或已完成付款回写的业务不得重新创建支付单", async () => {
    const refundedEvent = createEvent({
      status: "refunded",
      refundedAt: new Date().toISOString()
    });
    const refundedHarness = createPaymentHarness({ event: refundedEvent });
    const refundedActor = {
      id: refundedEvent.userId,
      role: "special" as const
    };

    await assert.rejects(
      refundedHarness.service.createOrder(
        defaultCreatePayload(refundedEvent),
        refundedActor
      ),
      /已退款/
    );
    assert.equal(refundedHarness.store.paymentOrders.length, 0);

    const paidEvent = createEvent({
      paymentNotifyStatus: "success",
      paymentTransactionId: "platform-paid-transaction"
    });
    const paidHarness = createPaymentHarness({ event: paidEvent });
    const paidActor = { id: paidEvent.userId, role: "special" as const };

    await assert.rejects(
      paidHarness.service.createOrder(
        defaultCreatePayload(paidEvent),
        paidActor
      ),
      /已完成支付/
    );
    assert.equal(paidHarness.store.paymentOrders.length, 0);
  });

  test("开柜前支付阶段未形成可核销账单时必须关闭式拒绝", async () => {
    const event = createEvent({
      status: "created",
      amount: 0,
      preSettlement: {
        deviceCode: "CAB-PAYMENT-1",
        doorNum: "1",
        createdAt: new Date().toISOString(),
        totalQuantity: 1,
        freeQuantity: 0,
        paidQuantity: 1,
        originalAmount: 500,
        payableAmount: 500,
        freeAmount: 0,
        chargeRequired: true,
        summary: "需支付 5.00 元",
        items: []
      }
    });
    const harness = createPaymentHarness({ event });
    const actor = { id: event.userId, role: "special" as const };

    await assert.rejects(
      harness.service.createOrder(
        defaultCreatePayload(event, {
          phase: "pre_open",
          amount: 500
        }),
        actor
      ),
      /开柜前支付阶段尚未启用/
    );
    assert.equal(harness.store.paymentOrders.length, 0);
  });
});

describe("累计退款与单向状态", () => {
  test("部分退款保持已支付，累计全额后才标记全退且只回写一次库存退款", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness);
    const actor = { id: "admin-1", role: "admin" as const };

    const first = await harness.refund(
      { paymentOrderId: order.id, amount: 400, reason: "部分退款" },
      actor
    );
    assert.equal(first.status, "success");
    assert.ok(first.refundedAt);
    assert.equal(order.status, "paid");
    assert.equal(harness.inventoryRefunds.length, 0);

    const second = await harness.refund(
      { paymentOrderId: order.id, amount: 600, reason: "补足退款" },
      actor
    );
    assert.equal(second.status, "success");
    assert.equal(order.status, "refunded");
    assert.equal(harness.inventoryRefunds.length, 1);
    assert.equal(harness.inventoryRefunds[0]?.amount, 1_000);
  });

  test("重复扣款纠错退款不撤销原业务，主交易在重复款未处理前保持关闭", async () => {
    const event = createEvent({
      paymentNotifyStatus: "success",
      paymentTransactionId: "business-transaction-a"
    });
    const harness = createPaymentHarness({ event });
    const primaryOrder = appendPaidOrder(harness, {
      id: "primary-payment-order",
      paymentNo: "primary-payment-no",
      providerTransactionId: "business-transaction-a"
    });
    const duplicateOrder = appendPaidOrder(harness, {
      id: "duplicate-payment-order",
      paymentNo: "duplicate-payment-no",
      providerTransactionId: "duplicate-transaction-b",
      metadata: {
        simulated: true,
        reconciliationState: "duplicate_payment",
        smartVmForwardState: "blocked"
      }
    });
    const actor = { id: "admin-1", role: "admin" as const };

    await assert.rejects(
      harness.service.refundByBusinessOrder(
        {
          orderNo: event.orderNo,
          transactionId: primaryOrder.providerTransactionId!,
          deviceCode: event.deviceCode,
          refundNo: "primary-refund-before-correction",
          amount: primaryOrder.amount
        },
        actor
      ),
      /仍有其他已支付款项待处理/
    );
    assert.equal(harness.store.paymentRefunds.length, 0);

    const correction = await harness.service.refundByBusinessOrder(
      {
        orderNo: event.orderNo,
        transactionId: duplicateOrder.providerTransactionId!,
        deviceCode: event.deviceCode,
        refundNo: "duplicate-correction-request",
        amount: duplicateOrder.amount
      },
      actor
    );
    assert.equal(correction.status, "success");
    assert.equal(duplicateOrder.status, "refunded");
    assert.equal(primaryOrder.status, "paid");
    assert.equal(event.paymentNotifyStatus, "success");
    assert.equal(event.paymentTransactionId, "business-transaction-a");
    assert.equal(event.refundedAt, undefined);
    assert.equal(harness.inventoryRefunds.length, 0);

    const replay = await harness.service.refundByBusinessOrder(
      {
        orderNo: event.orderNo,
        transactionId: duplicateOrder.providerTransactionId!,
        deviceCode: event.deviceCode,
        refundNo: "duplicate-correction-request",
        amount: duplicateOrder.amount
      },
      actor
    );
    assert.equal(replay.id, correction.id);
    assert.equal(harness.store.paymentRefunds.length, 1);

    const businessRefund = await harness.service.refundByBusinessOrder(
      {
        orderNo: event.orderNo,
        transactionId: primaryOrder.providerTransactionId!,
        deviceCode: event.deviceCode,
        refundNo: "primary-refund-after-correction",
        amount: primaryOrder.amount
      },
      actor
    );
    assert.equal(businessRefund.status, "success");
    assert.equal(primaryOrder.status, "refunded");
    assert.equal(harness.inventoryRefunds.length, 1);
    assert.equal(
      harness.inventoryRefunds[0]?.transactionId,
      primaryOrder.providerTransactionId
    );
  });

  test("超额退款不会被静默截断，并发退款会串行复核余额", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness);
    const actor = { id: "admin-1", role: "admin" as const };

    await harness.refund({ paymentOrderId: order.id, amount: 400 }, actor);
    await assert.rejects(
      harness.refund({ paymentOrderId: order.id, amount: 601 }, actor),
      /超过当前可退余额 600 分/
    );

    const concurrentHarness = createPaymentHarness();
    const concurrentOrder = appendPaidOrder(concurrentHarness);
    const results = await Promise.allSettled([
      concurrentHarness.refund(
        { paymentOrderId: concurrentOrder.id, amount: 700 },
        actor
      ),
      concurrentHarness.refund(
        { paymentOrderId: concurrentOrder.id, amount: 700 },
        actor
      )
    ]);

    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(
      concurrentHarness.store.paymentRefunds.reduce((sum, entry) => sum + entry.amount, 0),
      700
    );
  });

  test("成功退款回调幂等，且终态不能回退为失败", () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness);
    const now = new Date().toISOString();
    const refund: PaymentRefundRecord = {
      id: "refund-callback-1",
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: "refund-no-1",
      provider: "wechat",
      status: "pending",
      amount: 400,
      createdAt: now,
      updatedAt: now
    };
    harness.store.paymentRefunds.push(refund);
    const applyCallback = (status: "pending" | "success" | "failed") =>
      (harness.service as unknown as {
        markRefundFromProvider(payload: unknown): PaymentRefundRecord;
      }).markRefundFromProvider({
        paymentNo: order.paymentNo,
        refundNo: refund.refundNo,
        providerRefundId: "provider-refund-1",
        providerTransactionId: order.providerTransactionId!,
        status,
        amount: refund.amount,
        totalAmount: order.amount,
        callbackPayload: { status }
      });

    applyCallback("success");
    const refundedAt = refund.refundedAt;
    applyCallback("success");
    assert.equal(refund.refundedAt, refundedAt);
    assert.throws(() => applyCallback("failed"), /拒绝状态回退或改写/);
    assert.equal(refund.status, "success");
  });

  test("退款失败或处理中回调会在应答渠道前持久化最新状态", () => {
    for (const status of ["failed", "pending"] as const) {
      const harness = createPaymentHarness();
      const order = appendPaidOrder(harness);
      const now = new Date().toISOString();
      const refund: PaymentRefundRecord = {
        id: `refund-callback-persist-${status}`,
        paymentOrderId: order.id,
        paymentNo: order.paymentNo,
        refundNo: `refund-no-persist-${status}`,
        provider: "wechat",
        status: "pending",
        amount: 400,
        createdAt: now,
        updatedAt: now
      };
      harness.store.paymentRefunds.push(refund);
      const persistCallsBefore = harness.persistCalls;

      (harness.service as unknown as {
        markRefundFromProvider(payload: unknown): PaymentRefundRecord;
      }).markRefundFromProvider({
        paymentNo: order.paymentNo,
        refundNo: refund.refundNo,
        providerRefundId: `provider-refund-persist-${status}`,
        providerTransactionId: order.providerTransactionId!,
        status,
        amount: refund.amount,
        totalAmount: order.amount,
        callbackPayload: { status }
      });

      assert.equal(refund.status, status);
      assert.equal(refund.providerOutcome, status);
      assert.ok(harness.persistCalls > persistCallsBefore);
    }
  });

  test("处理中退款会占用可退余额，失败前不能重复申请超额退款", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, { metadata: { simulated: false } });
    Object.assign(harness.service as object, {
      async createProviderRefund() {
        return {
          providerRefundId: "pending-provider-refund",
          status: "pending" as const
        };
      }
    });
    const actor = { id: "admin-1", role: "admin" as const };

    const pending = await harness.refund(
      { paymentOrderId: order.id, amount: 700 },
      actor
    );
    assert.equal(pending.status, "pending");
    await assert.rejects(
      harness.refund({ paymentOrderId: order.id, amount: 300, reason: "更换意图" }, actor),
      /退款结果待确认/
    );
    assert.equal(harness.store.paymentRefunds.length, 1);
  });

  test("真实退款响应丢失后保留退款意图，相同重试不得生成第二个退款号", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, { metadata: { simulated: false } });
    let providerCalls = 0;
    Object.assign(harness.service as object, {
      async createProviderRefund() {
        providerCalls += 1;
        throw new Error("退款渠道可能已受理，但本地响应丢失");
      }
    });
    const actor = { id: "admin-1", role: "admin" as const };
    const payload = {
      paymentOrderId: order.id,
      amount: 300,
      reason: "响应丢失测试"
    };
    const idempotencyKey = "refund-response-lost-001";

    await assert.rejects(
      harness.refund(payload, actor, idempotencyKey),
      /本地响应丢失/
    );
    const replay = await harness.refund(payload, actor, idempotencyKey);

    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);
    assert.equal(replay.id, harness.store.paymentRefunds[0]?.id);
    assert.equal(replay.status, "pending");
    assert.equal(replay.amount, 300);
    assert.match(replay.failReason ?? "", /结果待确认/);
    assert.ok(harness.persistCalls >= 1);

    for (const changedPayload of [
      { paymentOrderId: order.id, amount: 300 },
      { paymentOrderId: order.id, amount: 300, reason: "更换原因" },
      { paymentOrderId: order.id, amount: 301, reason: payload.reason }
    ]) {
      await assert.rejects(
        harness.refund(changedPayload, actor, idempotencyKey),
        /幂等键已绑定其他/
      );
    }
    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);
  });

  test("显式空值或非整数退款金额不得退化为默认全额", async () => {
    for (const amount of [null, "100", 1.5, 0, -1]) {
      const harness = createPaymentHarness();
      const order = appendPaidOrder(harness);
      const actor = { id: "admin-1", role: "admin" as const };

      await assert.rejects(
        harness.refund(
          {
            paymentOrderId: order.id,
            amount
          } as unknown as { paymentOrderId: string; amount: number },
          actor
        ),
        /退款金额必须是正整数分值/
      );
      assert.equal(harness.store.paymentRefunds.length, 0);
      assert.equal(harness.inventoryRefunds.length, 0);
    }
  });

  test("退款渠道已确认成功但库存回写失败时保持待确认并由同一意图补偿", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness);
    const actor = { id: "admin-1", role: "admin" as const };
    let inventoryCalls = 0;
    Object.assign(harness.service as object, {
      inventoryOrdersService: {
        markRefund() {
          inventoryCalls += 1;
          if (inventoryCalls === 1) {
            throw new Error("库存退款回写暂时失败");
          }
        }
      }
    });
    const payload = {
      paymentOrderId: order.id,
      amount: order.amount,
      reason: "补偿测试"
    };
    const idempotencyKey = "refund-business-compensation-001";

    await assert.rejects(
      harness.refund(payload, actor, idempotencyKey),
      /库存退款回写暂时失败/
    );
    const refund = harness.store.paymentRefunds[0]!;
    assert.equal(refund.status, "pending");
    assert.equal(
      (refund as PaymentRefundRecord & { providerOutcome?: string }).providerOutcome,
      "success"
    );
    assert.equal(order.status, "paid");

    const compensated = await harness.refund(payload, actor, idempotencyKey);
    assert.equal(compensated.status, "success");
    assert.equal(order.status, "refunded");
    assert.equal(inventoryCalls, 2);

    const replay = await harness.refund(payload, actor, idempotencyKey);
    assert.equal(replay.id, compensated.id);
    assert.equal(replay.status, "success");
    assert.equal(inventoryCalls, 2);
  });

  test("后台与 SmartVM 签名退款请求共用同一退款账本且不能交叉重复外呼", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, {
      metadata: { simulated: false },
      providerTransactionId: "provider-transaction-unified-refund"
    });
    let providerCalls = 0;
    Object.assign(harness.service as object, {
      async createProviderRefund() {
        providerCalls += 1;
        return {
          providerRefundId: "provider-refund-unified",
          status: "pending" as const
        };
      }
    });
    const smartVmPayload = {
      orderNo: order.orderNo!,
      transactionId: order.providerTransactionId!,
      deviceCode: order.deviceCode!,
      refundNo: "smartvm-refund-request-1",
      amount: order.amount
    };

    const first = await harness.service.refundFromSmartVm(smartVmPayload);
    const replay = await harness.service.refundFromSmartVm(smartVmPayload);
    assert.equal(replay.id, first.id);
    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);

    await assert.rejects(
      harness.service.refundByBusinessOrder(
        {
          orderNo: order.orderNo!,
          transactionId: order.providerTransactionId!,
          deviceCode: order.deviceCode!,
          refundNo: "backoffice-refund-request-2",
          amount: order.amount
        },
        { id: "admin-1", role: "admin" }
      ),
      /退款结果待确认/
    );
    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);

    const wrongTransactionHarness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const wrongOrder = appendPaidOrder(wrongTransactionHarness, {
      metadata: { simulated: false },
      providerTransactionId: "provider-transaction-correct"
    });
    let wrongProviderCalls = 0;
    Object.assign(wrongTransactionHarness.service as object, {
      async createProviderRefund() {
        wrongProviderCalls += 1;
        return { status: "pending" as const };
      }
    });
    await assert.rejects(
      wrongTransactionHarness.service.refundFromSmartVm({
        orderNo: wrongOrder.orderNo!,
        transactionId: "provider-transaction-wrong",
        deviceCode: wrongOrder.deviceCode!,
        refundNo: "smartvm-wrong-transaction",
        amount: wrongOrder.amount
      }),
      /原支付交易号/
    );
    assert.equal(wrongProviderCalls, 0);
    assert.equal(wrongTransactionHarness.store.paymentRefunds.length, 0);
  });

  test("SmartVM 退款缺少任一必填字段时在渠道外呼和退款记账前拒绝", async () => {
    const requiredFields = [
      "orderNo",
      "transactionId",
      "deviceCode",
      "refundNo",
      "amount"
    ] as const;

    for (const missingField of requiredFields) {
      const harness = createPaymentHarness({
        config: completeRealWechatConfig
      });
      const order = appendPaidOrder(harness, {
        metadata: { simulated: false },
        providerTransactionId: `provider-transaction-missing-${missingField}`
      });
      let providerCalls = 0;
      Object.assign(harness.service as object, {
        async createProviderRefund() {
          providerCalls += 1;
          return { status: "pending" as const };
        }
      });
      const payload: Partial<Parameters<PaymentsService["refundFromSmartVm"]>[0]> = {
        orderNo: order.orderNo!,
        transactionId: order.providerTransactionId!,
        deviceCode: order.deviceCode!,
        refundNo: `smartvm-missing-${missingField}`,
        amount: order.amount
      };
      delete payload[missingField];

      await assert.rejects(
        harness.service.refundFromSmartVm(
          payload as Parameters<PaymentsService["refundFromSmartVm"]>[0]
        ),
        /必须|不能为空/
      );
      assert.equal(providerCalls, 0, missingField);
      assert.equal(harness.store.paymentRefunds.length, 0, missingField);
      assert.equal(harness.inventoryRefunds.length, 0, missingField);
      assert.equal(order.refundNo, undefined, missingField);
    }
  });

  test("后台兼容退款携带来源请求号时必须同时绑定原交易号和柜机号", async () => {
    for (const missingField of ["transactionId", "deviceCode"] as const) {
      const harness = createPaymentHarness({
        config: completeRealWechatConfig
      });
      const order = appendPaidOrder(harness, {
        metadata: { simulated: false },
        providerTransactionId: `provider-transaction-backoffice-${missingField}`
      });
      let providerCalls = 0;
      Object.assign(harness.service as object, {
        async createProviderRefund() {
          providerCalls += 1;
          return { status: "pending" as const };
        }
      });
      const payload: Parameters<PaymentsService["refundByBusinessOrder"]>[0] = {
        orderNo: order.orderNo!,
        transactionId: order.providerTransactionId!,
        deviceCode: order.deviceCode!,
        refundNo: `backoffice-source-${missingField}`,
        amount: order.amount
      };
      delete payload[missingField];

      await assert.rejects(
        harness.service.refundByBusinessOrder(
          payload,
          { id: "admin-1", role: "admin" }
        ),
        /必须/
      );
      assert.equal(providerCalls, 0, missingField);
      assert.equal(harness.store.paymentRefunds.length, 0, missingField);
      assert.equal(harness.inventoryRefunds.length, 0, missingField);
      assert.equal(order.refundNo, undefined, missingField);
    }
  });

  test("后台兼容退款缺少明确金额或幂等操作请求号时零外呼拒绝", async () => {
    for (const invalidCase of [
      { label: "missing-amount", patch: { amount: undefined } },
      { label: "zero-amount", patch: { amount: 0 } },
      { label: "fractional-amount", patch: { amount: 1.5 } },
      { label: "missing-refund-no", patch: { refundNo: undefined } },
      { label: "blank-refund-no", patch: { refundNo: "   " } }
    ] as const) {
      const harness = createPaymentHarness({
        config: completeRealWechatConfig
      });
      const order = appendPaidOrder(harness, {
        metadata: { simulated: false },
        providerTransactionId: `provider-transaction-required-${invalidCase.label}`
      });
      let providerCalls = 0;
      Object.assign(harness.service as object, {
        async createProviderRefund() {
          providerCalls += 1;
          return { status: "pending" as const };
        }
      });
      const payload: Record<string, unknown> = {
        orderNo: order.orderNo,
        transactionId: order.providerTransactionId,
        deviceCode: order.deviceCode,
        refundNo: `backoffice-required-${invalidCase.label}`,
        amount: order.amount,
        ...invalidCase.patch
      };

      await assert.rejects(
        harness.service.refundByBusinessOrder(
          payload as Parameters<PaymentsService["refundByBusinessOrder"]>[0],
          { id: "admin-1", role: "admin" }
        ),
        /退款金额|上游退款请求号/
      );
      assert.equal(providerCalls, 0, invalidCase.label);
      assert.equal(harness.store.paymentRefunds.length, 0, invalidCase.label);
      assert.equal(harness.inventoryRefunds.length, 0, invalidCase.label);
    }
  });

  test("后台兼容退款幂等操作请求号严格绑定订单金额与原因", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, {
      metadata: { simulated: false },
      providerTransactionId: "provider-transaction-legacy-idempotency"
    });
    let providerCalls = 0;
    Object.assign(harness.service as object, {
      async createProviderRefund() {
        providerCalls += 1;
        return { status: "pending" as const };
      }
    });
    const payload = {
      orderNo: order.orderNo!,
      transactionId: order.providerTransactionId!,
      deviceCode: order.deviceCode!,
      refundNo: "backoffice-idempotency-strict",
      amount: order.amount,
      reason: "首次退款原因"
    };

    const first = await harness.service.refundByBusinessOrder(
      payload,
      { id: "admin-1", role: "admin" }
    );
    assert.equal(first.status, "pending");
    assert.equal(providerCalls, 1);

    for (const conflict of [
      { ...payload, amount: order.amount - 1 },
      { ...payload, reason: "更换退款原因" },
      { ...payload, orderNo: "other-business-order" }
    ]) {
      await assert.rejects(
        harness.service.refundByBusinessOrder(
          conflict,
          { id: "admin-1", role: "admin" }
        ),
        /幂等键已绑定其他|整单全额退款|退款请求号/
      );
    }
    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);
  });

  test("SmartVM 与后台兼容退款的原交易号和柜机号必须精确绑定本地支付单", async () => {
    const scenarios = [
      { entry: "smartvm", mismatch: "transactionId" },
      { entry: "smartvm", mismatch: "deviceCode" },
      { entry: "backoffice", mismatch: "transactionId" },
      { entry: "backoffice", mismatch: "deviceCode" }
    ] as const;

    for (const scenario of scenarios) {
      const harness = createPaymentHarness({
        config: completeRealWechatConfig
      });
      const order = appendPaidOrder(harness, {
        metadata: { simulated: false },
        providerTransactionId: `provider-transaction-${scenario.entry}-${scenario.mismatch}`
      });
      let providerCalls = 0;
      Object.assign(harness.service as object, {
        async createProviderRefund() {
          providerCalls += 1;
          return { status: "pending" as const };
        }
      });
      const payload = {
        orderNo: order.orderNo!,
        transactionId:
          scenario.mismatch === "transactionId"
            ? `${order.providerTransactionId}-wrong`
            : order.providerTransactionId!,
        deviceCode:
          scenario.mismatch === "deviceCode"
            ? `${order.deviceCode}-wrong`
            : order.deviceCode!,
        refundNo: `${scenario.entry}-${scenario.mismatch}-binding`,
        amount: order.amount
      };

      await assert.rejects(
        scenario.entry === "smartvm"
          ? harness.service.refundFromSmartVm(payload)
          : harness.service.refundByBusinessOrder(
              payload,
              { id: "admin-1", role: "admin" }
            ),
        /原支付交易号|柜机/
      );
      assert.equal(providerCalls, 0, `${scenario.entry}:${scenario.mismatch}`);
      assert.equal(
        harness.store.paymentRefunds.length,
        0,
        `${scenario.entry}:${scenario.mismatch}`
      );
      assert.equal(
        harness.inventoryRefunds.length,
        0,
        `${scenario.entry}:${scenario.mismatch}`
      );
      assert.equal(order.refundNo, undefined, `${scenario.entry}:${scenario.mismatch}`);
    }
  });

  test("SmartVM 兼容退款回调验签失败时不进入统一退款协调器", async () => {
    let refundCalls = 0;
    const payments = {
      async refundFromSmartVm() {
        refundCalls += 1;
      }
    };
    const payload = {
      orderNo: "order-signed-refund",
      transactionId: "transaction-signed-refund",
      deviceCode: "CAB-SIGNED-REFUND",
      refundNo: "source-refund-signed",
      amount: 1_000
    };
    const rejectedController = new LegacyRefundController(
      payments as unknown as PaymentsService,
      {
        verifySignedPayload() {
          return false;
        }
      } as unknown as SmartVmGateway
    );

    await assert.rejects(rejectedController.refundCallback(payload), /签名校验失败/);
    assert.equal(refundCalls, 0);

    const acceptedController = new LegacyRefundController(
      payments as unknown as PaymentsService,
      {
        verifySignedPayload() {
          return true;
        }
      } as unknown as SmartVmGateway
    );
    await acceptedController.refundCallback(payload);
    assert.equal(refundCalls, 1);
  });

  test("支付宝多笔部分退款使用各自退款请求号，不把原支付交易号误作退款唯一键", async () => {
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "real",
        ALIPAY_APP_ID: "alipay-app",
        ALIPAY_SELLER_ID: "alipay-seller",
        ALIPAY_APP_PRIVATE_KEY: "private-key",
        ALIPAY_PUBLIC_KEY: "public-key",
        ALIPAY_NOTIFY_URL: "https://payment.example.test/alipay"
      }
    });
    const order = appendPaidOrder(harness, {
      provider: "alipay",
      metadata: { simulated: false },
      providerTransactionId: "alipay-original-trade"
    });
    let alipayRefundCalls = 0;
    Object.assign(harness.service as object, {
      async callAlipayGateway(_method: string, params: { biz_content?: string }) {
        alipayRefundCalls += 1;
        const request = JSON.parse(params.biz_content ?? "{}") as {
          out_request_no?: string;
        };
        return {
          code: "10000",
          trade_no: order.providerTransactionId,
          out_trade_no: order.paymentNo,
          out_request_no: request.out_request_no,
          refund_fee: alipayRefundCalls === 1 ? "4.00" : "10.00",
          fund_change: "Y",
          buyer_user_id: "sensitive-alipay-buyer",
          buyer_logon_id: "sensitive@example.test"
        };
      }
    });
    const actor = { id: "admin-1", role: "admin" as const };

    const first = await harness.refund(
      { paymentOrderId: order.id, amount: 400, reason: "第一笔" },
      actor
    );
    const second = await harness.refund(
      { paymentOrderId: order.id, amount: 600, reason: "第二笔" },
      actor
    );

    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
    assert.notEqual(first.providerRefundId, second.providerRefundId);
    assert.equal(first.providerRefundId, first.refundNo);
    assert.equal(second.providerRefundId, second.refundNo);
    assert.equal(order.status, "refunded");
    assert.equal(harness.inventoryRefunds.length, 1);
    assert.equal(
      harness.inventoryRefunds[0]?.transactionId,
      order.providerTransactionId
    );
    assert.equal(
      JSON.stringify([first.callbackPayload, second.callbackPayload]).includes(
        "sensitive-alipay-buyer"
      ),
      false
    );
    assert.equal(
      JSON.stringify([first.callbackPayload, second.callbackPayload]).includes(
        "sensitive@example.test"
      ),
      false
    );
  });

  test("微信同步退款响应必须完整绑定原单、退款单、交易号、金额和币种", async () => {
    const harness = createPaymentHarness({
      config: {
        ...completeRealWechatConfig,
        PAYMENT_MODE: "real"
      }
    });
    const order = appendPaidOrder(harness, {
      metadata: { simulated: false },
      providerTransactionId: "wechat-original-transaction"
    });
    Object.assign(harness.service as object, {
      async callWechatApi() {
        return {
          refund_id: "wechat-provider-refund",
          out_refund_no: "wrong-local-refund-no",
          out_trade_no: order.paymentNo,
          transaction_id: order.providerTransactionId,
          status: "SUCCESS",
          amount: {
            refund: order.amount,
            total: order.amount,
            currency: "CNY"
          }
        };
      }
    });

    await assert.rejects(
      harness.refund(
        { paymentOrderId: order.id, amount: order.amount },
        { id: "admin-1", role: "admin" }
      ),
      /微信退款响应的商户退款单号不匹配/
    );
    assert.equal(order.status, "paid");
    assert.equal(harness.inventoryRefunds.length, 0);
    assert.equal(harness.store.paymentRefunds.length, 1);
    assert.equal(harness.store.paymentRefunds[0]?.status, "pending");
    assert.equal(harness.store.paymentRefunds[0]?.providerOutcome, "unknown");
  });

  test("支付宝同步退款响应缺失或错绑关键字段时保持退款意图待确认", async () => {
    const variants = [
      {
        name: "缺少原支付交易号",
        response: {
          out_trade_no: "alipay-response-order",
          refund_fee: "10.00",
          fund_change: "Y"
        },
        message: /缺少原支付交易号/
      },
      {
        name: "商户订单号错绑",
        response: {
          trade_no: "alipay-response-transaction",
          out_trade_no: "wrong-business-payment-no",
          refund_fee: "10.00",
          fund_change: "Y"
        },
        message: /商户订单号不匹配/
      },
      {
        name: "累计退款金额错绑",
        response: {
          trade_no: "alipay-response-transaction",
          out_trade_no: "alipay-response-order",
          refund_fee: "9.99",
          fund_change: "Y"
        },
        message: /退款金额不匹配/
      },
      {
        name: "资金变化字段缺失",
        response: {
          trade_no: "alipay-response-transaction",
          out_trade_no: "alipay-response-order",
          refund_fee: "10.00"
        },
        message: /资金变化状态/
      }
    ] as const;

    for (const variant of variants) {
      const harness = createPaymentHarness({
        config: {
          PAYMENT_MODE: "real",
          ALIPAY_APP_ID: "alipay-app",
          ALIPAY_SELLER_ID: "alipay-seller",
          ALIPAY_APP_PRIVATE_KEY: "private-key",
          ALIPAY_PUBLIC_KEY: "public-key",
          ALIPAY_NOTIFY_URL: "https://payment.example.test/alipay"
        }
      });
      const order = appendPaidOrder(harness, {
        paymentNo: "alipay-response-order",
        provider: "alipay",
        metadata: { simulated: false },
        providerTransactionId: "alipay-response-transaction"
      });
      Object.assign(harness.service as object, {
        async callAlipayGateway() {
          return {
            code: "10000",
            ...variant.response
          };
        }
      });

      await assert.rejects(
        harness.refund(
          { paymentOrderId: order.id, amount: order.amount },
          { id: "admin-1", role: "admin" }
        ),
        variant.message,
        variant.name
      );
      assert.equal(order.status, "paid", variant.name);
      assert.equal(harness.inventoryRefunds.length, 0, variant.name);
      assert.equal(harness.store.paymentRefunds[0]?.status, "pending", variant.name);
      assert.equal(
        harness.store.paymentRefunds[0]?.providerOutcome,
        "unknown",
        variant.name
      );
    }
  });

  test("支付宝同一退款请求的幂等响应 fund_change=N 在累计金额完全匹配时仍按成功处理", async () => {
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "real",
        ALIPAY_APP_ID: "alipay-app",
        ALIPAY_SELLER_ID: "alipay-seller",
        ALIPAY_APP_PRIVATE_KEY: "private-key",
        ALIPAY_PUBLIC_KEY: "public-key",
        ALIPAY_NOTIFY_URL: "https://payment.example.test/alipay"
      }
    });
    const order = appendPaidOrder(harness, {
      paymentNo: "alipay-idempotent-refund-order",
      provider: "alipay",
      metadata: { simulated: false },
      providerTransactionId: "alipay-idempotent-refund-transaction"
    });
    Object.assign(harness.service as object, {
      async callAlipayGateway() {
        return {
          code: "10000",
          trade_no: order.providerTransactionId,
          out_trade_no: order.paymentNo,
          refund_fee: "10.00",
          fund_change: "N"
        };
      }
    });

    const refund = await harness.refund(
      { paymentOrderId: order.id, amount: order.amount },
      { id: "admin-1", role: "admin" },
      "alipay-idempotent-refund-001"
    );

    assert.equal(refund.status, "success");
    assert.equal(refund.providerOutcome, "success");
    assert.equal(order.status, "refunded");
    assert.equal(harness.inventoryRefunds.length, 1);
  });

  test("退款成功回调先到时，迟到的渠道失败响应不得覆盖终态", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, { metadata: { simulated: false } });
    let resolveProvider!: (value: {
      providerRefundId: string;
      status: "failed";
      failReason: string;
    }) => void;
    const providerResponse = new Promise<{
      providerRefundId: string;
      status: "failed";
      failReason: string;
    }>((resolve) => {
      resolveProvider = resolve;
    });
    Object.assign(harness.service as object, {
      createProviderRefund() {
        return providerResponse;
      }
    });
    const actor = { id: "admin-1", role: "admin" as const };
    const request = harness.refund(
      { paymentOrderId: order.id, amount: 400, reason: "退款竞态测试" },
      actor
    );

    while (harness.store.paymentRefunds.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const refund = harness.store.paymentRefunds[0]!;
    (harness.service as unknown as {
      markRefundFromProvider(payload: unknown): PaymentRefundRecord;
    }).markRefundFromProvider({
      paymentNo: order.paymentNo,
      refundNo: refund.refundNo,
      providerRefundId: "provider-refund-race",
      providerTransactionId: order.providerTransactionId!,
      status: "success",
      amount: refund.amount,
      totalAmount: order.amount,
      callbackPayload: { refund_status: "SUCCESS" }
    });
    resolveProvider({
      providerRefundId: "provider-refund-race",
      status: "failed",
      failReason: "迟到的渠道响应"
    });

    const result = await request;
    assert.equal(result.status, "success");
    assert.ok(result.refundedAt);
    await assert.rejects(
      harness.refund(
        { paymentOrderId: order.id, amount: 601, reason: "不应释放已成功退款额度" },
        actor
      ),
      /超过当前可退余额 600 分/
    );
  });

  test("退款成功回调先到时，迟到的渠道异常也不得把成功终态降为未知", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, { metadata: { simulated: false } });
    let rejectProvider!: (reason: Error) => void;
    const providerResponse = new Promise<never>((_resolve, reject) => {
      rejectProvider = reject;
    });
    Object.assign(harness.service as object, {
      createProviderRefund() {
        return providerResponse;
      }
    });
    const request = harness.refund(
      { paymentOrderId: order.id, amount: order.amount, reason: "异常竞态测试" },
      { id: "admin-1", role: "admin" },
      "refund-callback-before-reject-001"
    );

    while (harness.store.paymentRefunds.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const refund = harness.store.paymentRefunds[0]!;
    (harness.service as unknown as {
      markRefundFromProvider(payload: unknown): PaymentRefundRecord;
    }).markRefundFromProvider({
      paymentNo: order.paymentNo,
      refundNo: refund.refundNo,
      providerRefundId: "provider-refund-reject-race",
      providerTransactionId: order.providerTransactionId!,
      status: "success",
      amount: refund.amount,
      totalAmount: order.amount,
      callbackPayload: { refund_status: "SUCCESS" }
    });
    rejectProvider(new Error("迟到的同步请求异常"));

    const result = await request;
    assert.equal(result.status, "success");
    assert.equal(result.providerOutcome, "success");
    assert.equal(result.businessApplyState, "completed");
    assert.ok(result.refundedAt);
    assert.equal(order.status, "refunded");
    assert.equal(harness.inventoryRefunds.length, 1);
  });

  test("微信退款缺失、未知或异常状态必须保持待核对并继续占用余额", async () => {
    for (const providerStatus of [undefined, "MYSTERY", "ABNORMAL"] as const) {
      const harness = createPaymentHarness({
        config: completeRealWechatConfig
      });
      const order = appendPaidOrder(harness, { metadata: { simulated: false } });
      Object.assign(harness.service as object, {
        async callWechatApi(
          _method: string,
          _path: string,
          body: {
            out_refund_no: string;
            amount: { refund: number; total: number; currency: string };
          }
        ) {
          return {
            refund_id: `provider-refund-${providerStatus ?? "missing"}`,
            out_refund_no: body.out_refund_no,
            out_trade_no: order.paymentNo,
            transaction_id: order.providerTransactionId,
            amount: body.amount,
            ...(providerStatus ? { status: providerStatus } : {})
          };
        }
      });
      const actor = { id: "admin-1", role: "admin" as const };
      const request = harness.refund(
        { paymentOrderId: order.id, amount: 400, reason: `状态 ${providerStatus ?? "missing"}` },
        actor
      );
      const refund =
        providerStatus === "ABNORMAL"
          ? await request
          : await assert.rejects(request, /微信退款响应的退款状态无效/).then(
              () => harness.store.paymentRefunds[0]!
            );

      assert.equal(refund.status, "pending");
      assert.match(refund.failReason ?? "", /待确认|人工核对|查询确认/);
      await assert.rejects(
        harness.refund(
          { paymentOrderId: order.id, amount: 601, reason: "不得释放待核对余额" },
          actor
        ),
        /退款结果待确认/
      );
    }
  });

  test("微信同步退款 SUCCESS 只表示受理，必须等待可信回调或查询后才应用业务退款", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, { metadata: { simulated: false } });
    Object.assign(harness.service as object, {
      async callWechatApi(
        _method: string,
        _path: string,
        body: {
          out_refund_no: string;
          amount: { refund: number; total: number; currency: string };
        }
      ) {
        return {
          refund_id: "wechat-accepted-refund",
          out_refund_no: body.out_refund_no,
          out_trade_no: order.paymentNo,
          transaction_id: order.providerTransactionId,
          status: "SUCCESS",
          amount: body.amount
        };
      }
    });

    const refund = await harness.refund(
      { paymentOrderId: order.id, amount: order.amount },
      { id: "admin-1", role: "admin" },
      "wechat-accepted-refund-001"
    );

    assert.equal(refund.status, "pending");
    assert.equal(refund.providerOutcome, "pending");
    assert.equal(order.status, "paid");
    assert.equal(harness.inventoryRefunds.length, 0);

    const confirmed = (
      harness.service as unknown as {
        markRefundFromProvider(payload: unknown): PaymentRefundRecord;
      }
    ).markRefundFromProvider({
      paymentNo: order.paymentNo,
      refundNo: refund.refundNo,
      providerRefundId: "wechat-accepted-refund",
      providerTransactionId: order.providerTransactionId,
      status: "success",
      amount: refund.amount,
      totalAmount: order.amount,
      callbackPayload: { refund_status: "SUCCESS" }
    });

    assert.equal(confirmed.status, "success");
    assert.equal(order.status, "refunded");
    assert.equal(harness.inventoryRefunds.length, 1);
  });
});

describe("真实与模拟支付边界", () => {
  test("支付宝授权仅返回 open_id 时拒绝签发 buyer_id 付款身份句柄", async () => {
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "real",
        ALIPAY_APP_ID: "alipay-app",
        ALIPAY_SELLER_ID: "alipay-seller",
        ALIPAY_APP_PRIVATE_KEY: "private-key",
        ALIPAY_PUBLIC_KEY: "public-key",
        ALIPAY_NOTIFY_URL: "https://payment.example.test/payments/callbacks/alipay"
      }
    });
    let issueCalls = 0;
    Object.assign(harness.service as object, {
      async callAlipayGateway() {
        return {
          code: "10000",
          open_id: "deprecated-open-id"
        };
      }
    });
    Object.assign(harness.payerIdentityHandles as object, {
      issue() {
        issueCalls += 1;
        throw new Error("不应为 open_id 签发支付宝 buyer_id 付款身份句柄");
      }
    });

    await assert.rejects(
      harness.service.resolvePayerIdentity(
        { provider: "alipay", authCode: "trusted-auth-code" },
        { id: harness.event.userId, role: "special" }
      ),
      /未返回 user_id/
    );
    assert.equal(issueCalls, 0);
  });

  test("支付宝创建交易同步响应必须回绑当前本地支付单号", async () => {
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "real",
        ALIPAY_APP_ID: "alipay-app",
        ALIPAY_SELLER_ID: "alipay-seller",
        ALIPAY_APP_PRIVATE_KEY: "private-key",
        ALIPAY_PUBLIC_KEY: "public-key",
        ALIPAY_NOTIFY_URL: "https://payment.example.test/alipay"
      }
    });
    const order = appendPaidOrder(harness, {
      provider: "alipay",
      status: "pending",
      providerTransactionId: undefined,
      paidAt: undefined,
      metadata: { simulated: false }
    });
    Object.assign(harness.service as object, {
      async callAlipayGateway() {
        return {
          code: "10000",
          trade_no: "alipay-created-trade",
          out_trade_no: "other-local-payment-no"
        };
      }
    });

    await assert.rejects(
      (
        harness.service as unknown as {
          createAlipayTradeOrder(
            paymentOrder: PaymentOrderRecord,
            payerIdentity: string
          ): Promise<unknown>;
        }
      ).createAlipayTradeOrder(order, "trusted-alipay-user-id"),
      /商户订单号与本地支付单不匹配/
    );
    assert.equal(order.providerOrderId, undefined);
    assert.equal(order.invokePayload, undefined);
  });

  test("真实支付仅接受服务端签发且绑定当前账号和渠道的一次性付款身份句柄", async () => {
    const harness = createPaymentHarness({
      config: {
        ...completeRealWechatConfig,
        ALIPAY_APP_ID: "alipay-app-id",
        ALIPAY_SELLER_ID: "alipay-seller-id",
        ALIPAY_APP_PRIVATE_KEY: "alipay-private-key",
        ALIPAY_PUBLIC_KEY: "alipay-public-key",
        ALIPAY_NOTIFY_URL: "https://payment.example.test/payments/callbacks/alipay"
      }
    });
    const actor = { id: harness.event.userId, role: "special" as const };
    const otherEvent = createEvent({
      eventId: "event-payment-other-actor",
      orderNo: "order-payment-other-actor",
      userId: "special-payment-2"
    });
    const replayEvent = createEvent({
      eventId: "event-payment-handle-replay",
      orderNo: "order-payment-handle-replay"
    });
    harness.store.events.push(otherEvent, replayEvent);
    let providerCalls = 0;
    let providerPayerIdentity: unknown;
    Object.assign(harness.service as object, {
      async callJsonEndpoint() {
        return { openid: "openid-from-trusted-exchange" };
      },
      async createProviderPaymentOrder(
        order: PaymentOrderRecord,
        _payload: PaymentOrderCreatePayload,
        payerIdentity: unknown
      ) {
        providerCalls += 1;
        providerPayerIdentity = payerIdentity;
        return {
          providerOrderId: `provider-${order.paymentNo}`,
          invokePayload: { provider: order.provider, simulated: false }
        };
      }
    });

    const identity = await harness.service.resolvePayerIdentity(
      { provider: "wechat", authCode: "trusted-auth-code" },
      actor
    ) as unknown as {
      provider: "wechat";
      simulated: boolean;
      payerIdentityHandle?: string;
      payerOpenId?: string;
    };
    assert.equal(identity.simulated, false);
    assert.ok(identity.payerIdentityHandle);
    assert.equal(identity.payerOpenId, undefined);

    await assert.rejects(
      harness.service.createOrder(
        ({
          ...defaultCreatePayload(harness.event),
          payerOpenId: "client-replaced-openid"
        } as unknown as PaymentOrderCreatePayload),
        actor
      ),
      /不支持的字段/
    );
    assert.equal(providerCalls, 0);

    await assert.rejects(
      harness.service.createOrder(
        {
          ...defaultCreatePayload(otherEvent),
          payerIdentityHandle: identity.payerIdentityHandle
        } as PaymentOrderCreatePayload,
        { id: otherEvent.userId, role: "special" as const }
      ),
      /付款身份句柄/
    );
    await assert.rejects(
      harness.service.createOrder(
        {
          ...defaultCreatePayload(harness.event),
          provider: "alipay",
          payerIdentityHandle: identity.payerIdentityHandle
        } as PaymentOrderCreatePayload,
        actor
      ),
      /付款身份句柄/
    );
    assert.equal(providerCalls, 0);

    const created = await harness.service.createOrder(
      {
        ...defaultCreatePayload(harness.event),
        payerIdentityHandle: identity.payerIdentityHandle
      } as PaymentOrderCreatePayload,
      actor
    );
    assert.equal(providerCalls, 1);
    assert.equal(providerPayerIdentity, "openid-from-trusted-exchange");
    assert.equal(created.order.metadata?.payerOpenId, undefined);
    assert.equal(created.order.metadata?.payerAlipayUserId, undefined);

    await assert.rejects(
      harness.service.createOrder(
        {
          ...defaultCreatePayload(replayEvent),
          payerIdentityHandle: identity.payerIdentityHandle
        } as PaymentOrderCreatePayload,
        actor
      ),
      /付款身份句柄/
    );
    assert.equal(providerCalls, 1);
  });

  test("真实来源支付单不因当前配置切换为 mock 而被模拟完成或模拟退款", async () => {
    const harness = createPaymentHarness({
      config: {
        ...completeRealWechatConfig,
        PAYMENT_MODE: "mock"
      }
    });
    const pendingOrder = appendPaidOrder(harness, {
      id: "real-pending-order",
      paymentNo: "real-pending-payment",
      status: "pending",
      paidAt: undefined,
      metadata: { simulated: false }
    });
    const specialActor = { id: harness.event.userId, role: "special" as const };

    await assert.rejects(
      harness.service.markMockPaid(pendingOrder.id, specialActor),
      /不属于模拟支付/
    );
    assert.equal(pendingOrder.status, "pending");

    const paidOrder = appendPaidOrder(harness, {
      id: "real-paid-order",
      paymentNo: "real-paid-payment",
      metadata: { simulated: false }
    });
    let providerRefundCalls = 0;
    Object.assign(harness.service as object, {
      async createProviderRefund() {
        providerRefundCalls += 1;
        return {
          providerRefundId: "real-provider-refund",
          status: "pending" as const
        };
      }
    });
    const refund = await harness.refund(
      { paymentOrderId: paidOrder.id, amount: 100 },
      { id: "admin-1", role: "admin" }
    );

    assert.equal(providerRefundCalls, 1);
    assert.equal(refund.status, "pending");
    assert.equal(paidOrder.status, "paid");
  });

  test("生产运行时拒绝完成或退款任何持久化模拟支付单", async () => {
    const harness = createPaymentHarness();
    const pendingOrder = appendPaidOrder(harness, {
      id: "persisted-mock-pending",
      status: "pending",
      providerTransactionId: undefined,
      paidAt: undefined,
      metadata: { simulated: true }
    });
    const paidOrder = appendPaidOrder(harness, {
      id: "persisted-mock-paid",
      metadata: { simulated: true }
    });
    const previousAppEnv = process.env.APP_ENV;

    process.env.APP_ENV = "production";
    try {
      await assert.rejects(
        harness.service.markMockPaid(pendingOrder.id, {
          id: harness.event.userId,
          role: "special"
        }),
        /生产环境禁止模拟支付/
      );
      await assert.rejects(
        harness.refund(
          { paymentOrderId: paidOrder.id, amount: paidOrder.amount },
          { id: "admin-1", role: "admin" }
        ),
        /生产环境禁止处理模拟支付单退款/
      );
    } finally {
      if (previousAppEnv === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = previousAppEnv;
      }
    }

    assert.equal(pendingOrder.status, "pending");
    assert.equal(paidOrder.status, "paid");
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
    assert.equal(harness.store.paymentRefunds.length, 0);
    assert.equal(harness.inventoryRefunds.length, 0);
  });

  test("auto 缺少回调地址时诊断与执行都回落模拟且不产生未知真实单", async () => {
    const harness = createPaymentHarness({
      config: {
        ...completeRealWechatConfig,
        PAYMENT_MODE: "auto",
        WECHAT_PAY_NOTIFY_URL: "",
        WECHAT_PAY_REFUND_NOTIFY_URL: ""
      }
    });
    const actor = { id: harness.event.userId, role: "special" as const };
    const diagnostics = harness.service.getPaymentDiagnostics();
    const provider = diagnostics.providers.find((entry) => entry.provider === "wechat");

    assert.equal(provider?.effectiveMode, "mock");
    const result = await harness.service.createOrder(
      defaultCreatePayload(harness.event),
      actor
    );
    assert.equal(result.order.metadata?.simulated, true);
    assert.equal(result.order.metadata?.providerCreateOutcome, "ready");
    assert.equal(result.invokePayload.simulated, true);
    assert.equal("invokePayload" in result.order, false);
    assert.equal("callbackPayload" in result.order, false);
    assert.equal("providerTransactionId" in result.order, false);
    assert.equal(harness.store.paymentOrders.length, 1);
  });

  test("real 缺少回调地址时必须在写入支付意图前拒绝", async () => {
    const harness = createPaymentHarness({
      config: {
        ...completeRealWechatConfig,
        WECHAT_PAY_NOTIFY_URL: "",
        WECHAT_PAY_REFUND_NOTIFY_URL: ""
      }
    });
    const actor = { id: harness.event.userId, role: "special" as const };

    await assert.rejects(
      harness.service.createOrder(
        defaultCreatePayload(harness.event),
        actor
      ),
      /真实微信支付缺少配置/
    );
    assert.equal(harness.store.paymentOrders.length, 0);
  });
});

describe("支付输入与权限边界", () => {
  test("渠道金额解析拒绝四舍五入、指数写法、非有限值和超过两位小数", () => {
    const harness = createPaymentHarness();
    const parsers = harness.service as unknown as {
      readAmount(value: unknown): number | undefined;
      readYuanAmount(value: unknown): number | undefined;
    };

    assert.equal(parsers.readAmount(500), 500);
    assert.equal(parsers.readAmount("500"), 500);
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "5.00", "1e3", "-1"]) {
      assert.equal(parsers.readAmount(value), undefined);
    }

    assert.equal(parsers.readYuanAmount("5"), 500);
    assert.equal(parsers.readYuanAmount("5.00"), 500);
    assert.equal(parsers.readYuanAmount(5.5), 550);
    for (const value of ["5.005", "1e3", "-1.00", "+1.00", Number.POSITIVE_INFINITY]) {
      assert.equal(parsers.readYuanAmount(value), undefined);
    }
  });

  test("支付标题与退款原因按渠道 UTF-8 字节上限校验且拒绝控制字符", async () => {
    for (const [provider, subject, message] of [
      ["wechat", "支".repeat(43), /微信支付商品描述最多允许 127 个 UTF-8 字节/],
      ["alipay", "支".repeat(86), /支付宝订单标题最多允许 256 个 UTF-8 字节/]
    ] as const) {
      const harness = createPaymentHarness();
      await assert.rejects(
        harness.service.createOrder(
          defaultCreatePayload(harness.event, {
            provider,
            subject
          }),
          { id: harness.event.userId, role: "special" }
        ),
        message
      );
      assert.equal(harness.store.paymentOrders.length, 0);
    }

    for (const [reason, message] of [
      ["退".repeat(27), /微信退款原因最多允许 80 个 UTF-8 字节/],
      ["😀".repeat(21), /微信退款原因最多允许 80 个 UTF-8 字节/],
      ["退款\n换行", /微信退款原因不能包含控制字符或换行/]
    ] as const) {
      const harness = createPaymentHarness();
      const order = appendPaidOrder(harness);
      await assert.rejects(
        harness.service.refund(
          {
            paymentOrderId: order.id,
            amount: 100,
            reason
          },
          { id: "admin-1", role: "admin" },
          `provider-text-${harness.store.paymentOrders.length}-${reason.length}`
        ),
        message
      );
      assert.equal(harness.store.paymentRefunds.length, 0);
      assert.equal(harness.inventoryRefunds.length, 0);
    }
  });

  test("退款原因规范化后统一用于幂等记录与渠道外呼", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, { metadata: { simulated: false } });
    let providerReason: string | undefined;
    Object.assign(harness.service as object, {
      async createProviderRefund(
        _order: PaymentOrderRecord,
        _amount: number,
        _refundNo: string,
        reason?: string
      ) {
        providerReason = reason;
        return {
          providerRefundId: "provider-refund-normalized-reason",
          status: "success" as const
        };
      }
    });

    const refund = await harness.refund(
      {
        paymentOrderId: order.id,
        amount: 100,
        reason: "  售后退款  \r\n"
      },
      { id: "admin-1", role: "admin" },
      "normalized-refund-reason"
    );

    assert.equal(providerReason, "售后退款");
    assert.equal(refund.reason, "售后退款");
  });

  test("支付与退款请求体不是普通对象时统一返回参数错误且零副作用", async () => {
    const harness = createPaymentHarness();
    const actor = { id: harness.event.userId, role: "special" as const };

    await assert.rejects(
      harness.service.createOrder(
        null as unknown as PaymentOrderCreatePayload,
        actor
      ),
      /支付请求体必须是对象/
    );

    const paidOrder = appendPaidOrder(harness);
    await assert.rejects(
      harness.refund(
        null as unknown as { paymentOrderId: string; amount: number },
        { id: "admin-1", role: "admin" }
      ),
      /退款请求体必须是对象/
    );

    assert.equal(harness.store.paymentOrders.length, 1);
    assert.equal(harness.store.paymentRefunds.length, 0);
    assert.equal(paidOrder.status, "paid");
  });

  test("正式退款必须提供幂等键、明确金额和支付单，成功响应丢失后可精确重放", async () => {
    const harness = createPaymentHarness({
      config: completeRealWechatConfig
    });
    const order = appendPaidOrder(harness, {
      metadata: { simulated: false }
    });
    const actor = { id: "admin-1", role: "admin" as const };
    const payload = {
      paymentOrderId: order.id,
      amount: 400,
      reason: "正式端点幂等测试"
    };
    let providerCalls = 0;
    Object.assign(harness.service as object, {
      async createProviderRefund() {
        providerCalls += 1;
        return {
          providerRefundId: "formal-idempotent-refund",
          status: "success" as const
        };
      }
    });

    await assert.rejects(
      harness.service.refund(payload, actor),
      /Idempotency-Key/
    );
    await assert.rejects(
      harness.service.refund(
        { paymentOrderId: order.id } as { paymentOrderId: string; amount: number },
        actor,
        "formal-refund-missing-amount"
      ),
      /退款金额必须明确提供/
    );
    await assert.rejects(
      harness.service.refund(
        { amount: 100 } as { paymentOrderId: string; amount: number },
        actor,
        "formal-refund-missing-order"
      ),
      /支付单标识不能为空/
    );
    await assert.rejects(
      harness.service.refund(payload, actor, " contains spaces "),
      /Idempotency-Key/
    );
    assert.equal(providerCalls, 0);
    assert.equal(harness.store.paymentRefunds.length, 0);

    const idempotencyKey = "formal-refund-lost-response-001";
    const first = await harness.service.refund(payload, actor, idempotencyKey);
    const replay = await harness.service.refund(payload, actor, idempotencyKey);

    assert.equal(first.id, replay.id);
    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);

    await assert.rejects(
      harness.service.refund(
        { ...payload, amount: 401 },
        actor,
        idempotencyKey
      ),
      /幂等键已绑定其他/
    );
    await assert.rejects(
      harness.service.refund(
        { ...payload, reason: "冲突原因" },
        actor,
        idempotencyKey
      ),
      /幂等键已绑定其他/
    );
    assert.equal(providerCalls, 1);
    assert.equal(harness.store.paymentRefunds.length, 1);
  });

  test("支付未知字段和超长金融文本被拒绝且不写入业务状态", async () => {
    const harness = createPaymentHarness();
    const actor = { id: harness.event.userId, role: "special" as const };
    const basePayload = defaultCreatePayload(harness.event);

    await assert.rejects(
      harness.service.createOrder(
        {
          ...basePayload,
          unexpected: true
        } as PaymentOrderCreatePayload,
        actor
      ),
      /包含不支持的字段：unexpected/
    );
    await assert.rejects(
      harness.service.createOrder(
        {
          ...basePayload,
          subject: "支".repeat(257)
        },
        actor
      ),
      /支付主题最多 256 个字符/
    );
    assert.equal(harness.store.paymentOrders.length, 0);

    const paidOrder = appendPaidOrder(harness);
    await assert.rejects(
      harness.refund(
        {
          paymentOrderId: paidOrder.id,
          amount: 100,
          reason: "退".repeat(201)
        },
        { id: "admin-1", role: "admin" }
      ),
      /退款原因最多 200 个字符/
    );
    assert.equal(harness.store.paymentRefunds.length, 0);
    assert.equal(paidOrder.status, "paid");
  });

  test("退款服务层同时校验角色和商户归属，不能仅凭相同用户编号越权", async () => {
    const merchantEvent = createEvent({
      role: "merchant",
      userId: "merchant-payment-owner"
    });
    const harness = createPaymentHarness({ event: merchantEvent });
    const order = appendPaidOrder(harness, {
      payerUserId: merchantEvent.userId,
      merchantUserId: merchantEvent.userId
    });

    await assert.rejects(
      harness.refund(
        { paymentOrderId: order.id, amount: 100 },
        { id: merchantEvent.userId, role: "special" }
      ),
      /无权退款/
    );
    assert.equal(harness.store.paymentRefunds.length, 0);

    const refund = await harness.refund(
      { paymentOrderId: order.id, amount: 100 },
      { id: merchantEvent.userId, role: "merchant" }
    );
    assert.equal(refund.status, "success");
  });
});

const signAlipayPayload = (body: Record<string, unknown>, privateKey: string) => {
  const unsigned = Object.entries(body)
    .filter(
      ([key, value]) =>
        key !== "sign" &&
        key !== "sign_type" &&
        value !== undefined &&
        value !== null &&
        String(value) !== ""
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned, "utf8");
  signer.end();
  return { ...body, sign: signer.sign(privateKey, "base64") };
};

const signWechatPayload = (rawBody: string, privateKey: string) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = "payment-integrity-nonce";
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8");
  signer.end();
  return {
    "wechatpay-signature": signer.sign(privateKey, "base64"),
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": nonce,
    "wechatpay-serial": "platform-serial"
  };
};

const encryptWechatResource = (
  payload: Record<string, unknown>,
  apiV3Key: string,
  originalType: "transaction" | "refund"
) => {
  const nonce = "notify-nonce";
  const associatedData = "payment-integrity";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    Buffer.from(nonce, "utf8")
  );
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  return {
    algorithm: "AEAD_AES_256_GCM",
    original_type: originalType,
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"),
    nonce,
    associated_data: associatedData
  };
};

describe("支付供应商回调", () => {
  test("支付宝回调交易号必须与创建交易时绑定的渠道交易号完全一致", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness, {
      provider: "alipay",
      status: "pending",
      providerOrderId: "alipay-created-trade",
      providerTransactionId: undefined,
      paidAt: undefined,
      metadata: { simulated: false }
    });

    await assert.rejects(
      (
        harness.service as unknown as {
          markPaid(payload: unknown): Promise<PaymentOrderRecord>;
        }
      ).markPaid({
        provider: "alipay",
        paymentNo: order.paymentNo,
        providerTransactionId: "alipay-callback-other-trade",
        amount: order.amount,
        callbackPayload: { trade_status: "TRADE_SUCCESS" }
      }),
      /与创建交易返回的渠道交易号不一致/
    );

    assert.equal(order.status, "pending");
    assert.equal(order.providerTransactionId, undefined);
    assert.equal(order.metadata?.reconciliationState, "provider_transaction_mismatch");
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
  });

  test("微信和支付宝同步接口响应必须验签后才能驱动金融状态", () => {
    const wechatKeys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const alipayKeys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "platform-serial",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: wechatKeys.publicKey,
        ALIPAY_PUBLIC_KEY: alipayKeys.publicKey
      }
    });
    const privateService = harness.service as unknown as {
      verifyWechatProviderResponse(response: Response, rawBody: string): void;
      verifyAlipayProviderResponse(
        rawBody: string,
        parsed: Record<string, unknown>,
        responseKey: string
      ): void;
    };
    const wechatBody = JSON.stringify({ refund_id: "wechat-refund-verified", status: "SUCCESS" });
    const wechatTimestamp = Math.floor(Date.now() / 1_000).toString();
    const wechatNonce = "wechat-response-nonce";
    const wechatSigner = createSign("RSA-SHA256");
    wechatSigner.update(
      `${wechatTimestamp}\n${wechatNonce}\n${wechatBody}\n`,
      "utf8"
    );
    wechatSigner.end();
    const wechatResponse = new Response(wechatBody, {
      headers: {
        "wechatpay-signature": wechatSigner.sign(wechatKeys.privateKey, "base64"),
        "wechatpay-timestamp": wechatTimestamp,
        "wechatpay-nonce": wechatNonce,
        "wechatpay-serial": "platform-serial"
      }
    });
    privateService.verifyWechatProviderResponse(wechatResponse, wechatBody);
    assert.throws(
      () => privateService.verifyWechatProviderResponse(wechatResponse, `${wechatBody}tampered`),
      /验签失败/
    );
    assert.throws(
      () => privateService.verifyWechatProviderResponse(new Response(wechatBody), wechatBody),
      /缺少平台签名头/
    );

    const responseKey = "alipay_trade_refund_response";
    const alipayContent = JSON.stringify({
      code: "10000",
      trade_no: "alipay-original-trade"
    });
    const alipaySigner = createSign("RSA-SHA256");
    alipaySigner.update(alipayContent, "utf8");
    alipaySigner.end();
    const alipayParsed = {
      [responseKey]: JSON.parse(alipayContent),
      sign: alipaySigner.sign(alipayKeys.privateKey, "base64")
    };
    const alipayBody = `{"${responseKey}":${alipayContent},"sign":"${alipayParsed.sign}"}`;
    privateService.verifyAlipayProviderResponse(alipayBody, alipayParsed, responseKey);
    assert.throws(
      () =>
        privateService.verifyAlipayProviderResponse(
          alipayBody.replace("alipay-original-trade", "tampered-trade"),
          alipayParsed,
          responseKey
        ),
      /验签失败/
    );
    assert.throws(
      () =>
        privateService.verifyAlipayProviderResponse(
          `{"${responseKey}":${alipayContent}}`,
          { [responseKey]: JSON.parse(alipayContent) },
          responseKey
        ),
      /缺少有效签名/
    );
  });

  test("支付宝回调校验时效、交易号幂等和支付状态单向迁移", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        ALIPAY_APP_ID: "payment-integrity-app",
        ALIPAY_SELLER_ID: "payment-integrity-seller",
        ALIPAY_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      provider: "alipay",
      paymentNo: "alipay-payment-1",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const fresh = signAlipayPayload({
      app_id: "payment-integrity-app",
      seller_id: "payment-integrity-seller",
      out_trade_no: order.paymentNo,
      trade_no: "alipay-transaction-1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "5.00",
      notify_time: new Date().toISOString(),
      optional_empty_field: "",
      buyer_id: "sensitive-buyer-id",
      buyer_logon_id: "sensitive@example.test"
    }, privateKey);

    await harness.service.handleAlipayCallback(fresh, {});
    await harness.service.handleAlipayCallback(fresh, {});
    assert.equal(order.status, "paid");
    assert.equal(order.providerTransactionId, "alipay-transaction-1");
    assert.equal(
      JSON.stringify(order.callbackPayload).includes("sensitive-buyer"),
      false
    );
    assert.equal(harness.cabinetPaymentNotifications.length, 1);
    assert.equal(
      (harness.service as unknown as {
        formatAlipayTimestamp(date: Date): string;
      }).formatAlipayTimestamp(new Date("2026-01-01T00:00:00.000Z")),
      "2026-01-01 08:00:00"
    );

    const staleOrder = appendPaidOrder(harness, {
      id: "alipay-stale-order",
      provider: "alipay",
      paymentNo: "alipay-payment-stale",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const stale = signAlipayPayload({
      app_id: "payment-integrity-app",
      seller_id: "payment-integrity-seller",
      out_trade_no: staleOrder.paymentNo,
      trade_no: "alipay-transaction-stale",
      trade_status: "TRADE_SUCCESS",
      total_amount: "5.00",
      notify_time: "2020-01-01T00:00:00.000Z"
    }, privateKey);
    await harness.service.handleAlipayCallback(stale, {});
    await harness.service.handleAlipayCallback(stale, {});
    assert.equal(staleOrder.status, "paid");
    assert.equal(staleOrder.providerTransactionId, "alipay-transaction-stale");

    const closedOrder = appendPaidOrder(harness, {
      id: "closed-order",
      paymentNo: "closed-payment",
      status: "closed",
      paidAt: undefined
    });
    await assert.rejects(
      (harness.service as unknown as {
        markPaid(payload: unknown): Promise<PaymentOrderRecord>;
      }).markPaid({
        provider: closedOrder.provider,
        paymentNo: closedOrder.paymentNo,
        providerTransactionId: "late-transaction",
        amount: closedOrder.amount
      }),
      /不能再标记为已支付/
    );
    assert.equal(closedOrder.status, "closed");
  });

  test("支付宝回调缺少明确成功状态时拒绝入账且保持零副作用", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        ALIPAY_APP_ID: "payment-integrity-app",
        ALIPAY_SELLER_ID: "payment-integrity-seller",
        ALIPAY_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      provider: "alipay",
      paymentNo: "alipay-payment-missing-status",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const callback = signAlipayPayload(
      {
        app_id: "payment-integrity-app",
        seller_id: "payment-integrity-seller",
        out_trade_no: order.paymentNo,
        trade_no: "alipay-transaction-missing-status",
        total_amount: "5.00",
        notify_time: new Date().toISOString()
      },
      privateKey
    );

    await assert.rejects(
      harness.service.handleAlipayCallback(callback, {}),
      /交易状态不是成功/
    );
    assert.equal(order.status, "pending");
    assert.equal(order.providerTransactionId, undefined);
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
  });

  test("微信回调缺少明确成功状态时拒绝入账且保持零副作用", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_APP_ID: "payment-integrity-wechat-app",
        WECHAT_PAY_MCH_ID: "payment-integrity-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      paymentNo: "wechat-payment-missing-status",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const body = {
      appid: "payment-integrity-wechat-app",
      mchid: "payment-integrity-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: "wechat-transaction-missing-status",
      amount: { total: order.amount, currency: "CNY" }
    };
    const rawBody = JSON.stringify(body);

    await assert.rejects(
      harness.service.handleWechatCallback(
        body,
        signWechatPayload(rawBody, privateKey),
        rawBody
      ),
      /支付状态不是 SUCCESS/
    );
    assert.equal(order.status, "pending");
    assert.equal(order.providerTransactionId, undefined);
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
  });

  test("微信官方加密信封、平台证书序列号和付款方金额必须完整绑定", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const apiV3Key = "12345678901234567890123456789012";
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_APP_ID: "payment-integrity-wechat-app",
        WECHAT_PAY_MCH_ID: "payment-integrity-wechat-merchant",
        WECHAT_PAY_API_V3_KEY: apiV3Key,
        WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "platform-serial",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      paymentNo: "wechat-payment-official-envelope",
      status: "pending",
      amount: 500,
      paidAt: undefined,
      providerTransactionId: undefined
    });
    const decrypted = {
      appid: "payment-integrity-wechat-app",
      mchid: "payment-integrity-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: "wechat-transaction-official-envelope",
      trade_state: "SUCCESS",
      amount: {
        total: order.amount,
        payer_total: 450,
        currency: "CNY",
        payer_currency: "CNY"
      }
    };
    const body = {
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptWechatResource(decrypted, apiV3Key, "transaction")
    };
    const rawBody = JSON.stringify(body);

    await harness.service.handleWechatCallback(
      body,
      signWechatPayload(rawBody, privateKey),
      rawBody
    );
    assert.equal(order.status, "paid");
    assert.equal(order.providerTransactionId, "wechat-transaction-official-envelope");

    const rejectedHarness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_APP_ID: "payment-integrity-wechat-app",
        WECHAT_PAY_MCH_ID: "payment-integrity-wechat-merchant",
        WECHAT_PAY_API_V3_KEY: apiV3Key,
        WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "expected-platform-serial",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const rejectedOrder = appendPaidOrder(rejectedHarness, {
      paymentNo: "wechat-payment-wrong-serial",
      status: "pending",
      amount: 500,
      paidAt: undefined,
      providerTransactionId: undefined
    });
    const rejectedDecrypted = {
      ...decrypted,
      out_trade_no: rejectedOrder.paymentNo,
      transaction_id: "wechat-transaction-wrong-serial"
    };
    const rejectedBody = {
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptWechatResource(rejectedDecrypted, apiV3Key, "transaction")
    };
    const rejectedRawBody = JSON.stringify(rejectedBody);

    await assert.rejects(
      rejectedHarness.service.handleWechatCallback(
        rejectedBody,
        signWechatPayload(rejectedRawBody, privateKey),
        rejectedRawBody
      ),
      /平台证书序列号/
    );
    assert.equal(rejectedOrder.status, "pending");
    assert.equal(rejectedHarness.cabinetPaymentNotifications.length, 0);

    const wrongEnvelope = {
      ...rejectedBody,
      event_type: "REFUND.SUCCESS"
    };
    const wrongEnvelopeBody = JSON.stringify(wrongEnvelope);
    await assert.rejects(
      harness.service.handleWechatCallback(
        wrongEnvelope,
        signWechatPayload(wrongEnvelopeBody, privateKey),
        wrongEnvelopeBody
      ),
      /event_type/
    );
  });

  test("微信官方退款信封绑定事件状态和付款方退款金额", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const apiV3Key = "12345678901234567890123456789012";
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_MCH_ID: "payment-integrity-wechat-merchant",
        WECHAT_PAY_API_V3_KEY: apiV3Key,
        WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "platform-serial",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      paymentNo: "wechat-payment-refund-envelope",
      amount: 500,
      providerTransactionId: "wechat-transaction-refund-envelope"
    });
    const now = new Date().toISOString();
    const refund: PaymentRefundRecord = {
      id: "refund-official-envelope",
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: "wechat-refund-official-envelope",
      provider: "wechat",
      status: "pending",
      providerOutcome: "pending",
      businessApplyState: "pending",
      amount: 400,
      createdAt: now,
      updatedAt: now
    };
    harness.store.paymentRefunds.push(refund);
    const decrypted = {
      mchid: "payment-integrity-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: order.providerTransactionId,
      out_refund_no: refund.refundNo,
      refund_id: "wechat-provider-refund-envelope",
      refund_status: "SUCCESS",
      amount: {
        total: order.amount,
        refund: refund.amount,
        payer_total: 450,
        payer_refund: 350,
        currency: "CNY",
        payer_currency: "CNY"
      }
    };
    const body = {
      event_type: "REFUND.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptWechatResource(decrypted, apiV3Key, "refund")
    };
    const rawBody = JSON.stringify(body);

    await harness.service.handleWechatRefundCallback(
      body,
      signWechatPayload(rawBody, privateKey),
      rawBody
    );
    assert.equal(refund.status, "success");
    assert.equal(refund.businessApplyState, "completed");

    const invalidBody = {
      ...body,
      event_type: "REFUND.CLOSED"
    };
    const invalidRawBody = JSON.stringify(invalidBody);
    await assert.rejects(
      harness.service.handleWechatRefundCallback(
        invalidBody,
        signWechatPayload(invalidRawBody, privateKey),
        invalidRawBody
      ),
      /event_type 与 refund_status/
    );
  });

  test("支付宝回调必须绑定本地应用标识，错应用回调保持零副作用", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        ALIPAY_APP_ID: "expected-alipay-app",
        ALIPAY_SELLER_ID: "expected-alipay-seller",
        ALIPAY_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      provider: "alipay",
      paymentNo: "alipay-payment-wrong-app",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const callback = signAlipayPayload(
      {
        app_id: "other-alipay-app",
        seller_id: "expected-alipay-seller",
        out_trade_no: order.paymentNo,
        trade_no: "alipay-transaction-wrong-app",
        trade_status: "TRADE_SUCCESS",
        total_amount: "5.00",
        notify_time: new Date().toISOString()
      },
      privateKey
    );

    await assert.rejects(
      harness.service.handleAlipayCallback(callback, {}),
      /应用标识与本地配置不一致/
    );
    assert.equal(order.status, "pending");
    assert.equal(order.providerTransactionId, undefined);
    assert.equal(harness.cabinetPaymentNotifications.length, 0);

    for (const sellerId of [undefined, "other-alipay-seller"] as const) {
      const sellerCallback = signAlipayPayload(
        {
          app_id: "expected-alipay-app",
          ...(sellerId ? { seller_id: sellerId } : {}),
          out_trade_no: order.paymentNo,
          trade_no: `alipay-transaction-${sellerId ?? "missing-seller"}`,
          trade_status: "TRADE_SUCCESS",
          total_amount: "5.00",
          notify_time: new Date().toISOString()
        },
        privateKey
      );
      await assert.rejects(
        harness.service.handleAlipayCallback(sellerCallback, {}),
        /seller_id|商户标识/
      );
    }
    assert.equal(order.status, "pending");
    assert.equal(order.providerTransactionId, undefined);
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
  });

  test("微信回调必须绑定本地商户与应用，错商户回调保持零副作用", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_APP_ID: "expected-wechat-app",
        WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      paymentNo: "wechat-payment-wrong-merchant",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const body = {
      appid: "expected-wechat-app",
      mchid: "other-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: "wechat-transaction-wrong-merchant",
      trade_state: "SUCCESS",
      amount: { total: order.amount, currency: "CNY" }
    };
    const rawBody = JSON.stringify(body);

    await assert.rejects(
      harness.service.handleWechatCallback(
        body,
        signWechatPayload(rawBody, privateKey),
        rawBody
      ),
      /商户标识与本地配置不一致/
    );
    assert.equal(order.status, "pending");
    assert.equal(order.providerTransactionId, undefined);
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
  });

  test("支付已入账但柜机回写失败时，渠道重放只补偿回写且不重复入账", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness, {
      paymentNo: "payment-smartvm-retry",
      status: "pending",
      amount: 500,
      paidAt: undefined,
      metadata: { simulated: false }
    });
    let notificationCalls = 0;
    Object.assign(harness.service as object, {
      cabinetEventsService: {
        async notifyConfirmedPaymentSuccess() {
          notificationCalls += 1;
          if (notificationCalls === 1) {
            throw new Error("柜机平台暂时不可用");
          }
        }
      }
    });
    const markPaid = (harness.service as unknown as {
      markPaid(payload: unknown): Promise<PaymentOrderRecord>;
    }).markPaid.bind(harness.service);
    const callback = {
      provider: order.provider,
      paymentNo: order.paymentNo,
      providerTransactionId: "transaction-smartvm-retry",
      amount: order.amount
    };

    await assert.rejects(
      markPaid(callback),
      /支付已安全入账.*回写尚未完成/
    );
    assert.equal(order.status, "paid");
    assert.equal(notificationCalls, 1);
    assert.equal(order.metadata?.smartVmForwardState, "pending");

    await markPaid(callback);
    assert.equal(notificationCalls, 2);
    assert.equal(order.metadata?.smartVmForwardState, "completed");
    assert.equal(order.metadata?.smartVmForwardError, undefined);

    await markPaid(callback);
    assert.equal(notificationCalls, 2);
  });

  test("付款成功回写进行中时，同一业务订单的退款必须等待回写完成", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness, {
      id: "payment-refund-forward-race",
      paymentNo: "payment-refund-forward-race-no",
      status: "pending",
      providerTransactionId: "payment-refund-forward-race-transaction",
      paidAt: undefined,
      metadata: { simulated: true }
    });
    let releaseForward!: () => void;
    const forwardGate = new Promise<void>((resolve) => {
      releaseForward = resolve;
    });
    let forwardStarted = false;
    Object.assign(harness.service as object, {
      cabinetEventsService: {
        async notifyConfirmedPaymentSuccess() {
          forwardStarted = true;
          await forwardGate;
        }
      }
    });

    const payment = harness.service.markMockPaid(order.id, {
      id: harness.event.userId,
      role: "special"
    });
    while (!forwardStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    let refundSettled = false;
    const refund = harness
      .refund(
        { paymentOrderId: order.id, amount: order.amount },
        { id: "admin-1", role: "admin" },
        "refund-after-payment-forward-001"
      )
      .finally(() => {
        refundSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(refundSettled, false);
    assert.equal(harness.store.paymentRefunds.length, 0);

    releaseForward();
    await payment;
    await refund;
    assert.equal(order.status, "refunded");
    assert.equal(harness.store.paymentRefunds.length, 1);
  });

  test("同一业务订单的两笔支付成功交错时，后到款项进入重复收款核对且不重复回写", async () => {
    const harness = createPaymentHarness();
    const firstOrder = appendPaidOrder(harness, {
      id: "overlap-payment-first",
      paymentNo: "overlap-payment-first-no",
      status: "pending",
      providerTransactionId: "overlap-payment-first-transaction",
      paidAt: undefined,
      metadata: { simulated: true }
    });
    const secondOrder = appendPaidOrder(harness, {
      id: "overlap-payment-second",
      paymentNo: "overlap-payment-second-no",
      status: "pending",
      providerTransactionId: "overlap-payment-second-transaction",
      paidAt: undefined,
      metadata: { simulated: true }
    });
    let releaseFirstForward!: () => void;
    const firstForwardGate = new Promise<void>((resolve) => {
      releaseFirstForward = resolve;
    });
    let forwardCalls = 0;
    Object.assign(harness.service as object, {
      cabinetEventsService: {
        async notifyConfirmedPaymentSuccess(payload: { transactionId: string }) {
          forwardCalls += 1;
          if (forwardCalls === 1) {
            await firstForwardGate;
            harness.event.paymentNotifyStatus = "success";
            harness.event.paymentTransactionId = payload.transactionId;
          }
        }
      }
    });
    const actor = { id: harness.event.userId, role: "special" as const };

    const firstPayment = harness.service.markMockPaid(firstOrder.id, actor);
    while (forwardCalls === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const secondPayment = harness.service.markMockPaid(secondOrder.id, actor);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(forwardCalls, 1);

    releaseFirstForward();
    await firstPayment;
    const duplicate = await secondPayment;

    assert.equal(duplicate.metadata?.reconciliationState, "duplicate_payment");
    assert.equal(duplicate.metadata?.smartVmForwardState, "blocked");
    assert.equal(forwardCalls, 1);
    assert.equal(harness.paymentAlerts.length, 1);
  });

  test("业务订单已绑定其他交易号时记录重复收款告警并阻止自动覆盖", async () => {
    const event = createEvent({
      paymentNotifyStatus: "success",
      paymentTransactionId: "existing-business-transaction"
    });
    const harness = createPaymentHarness({ event });
    const order = appendPaidOrder(harness, {
      status: "pending",
      providerTransactionId: undefined,
      paidAt: undefined,
      metadata: { simulated: false }
    });

    await (harness.service as unknown as {
      markPaid(payload: unknown): Promise<PaymentOrderRecord>;
    }).markPaid({
      provider: order.provider,
      paymentNo: order.paymentNo,
      providerTransactionId: "second-provider-transaction",
      amount: order.amount
    });

    assert.equal(order.status, "paid");
    assert.equal(order.providerTransactionId, "second-provider-transaction");
    assert.equal(order.metadata?.reconciliationState, "duplicate_payment");
    assert.equal(order.metadata?.smartVmForwardState, "blocked");
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
    assert.equal(harness.paymentAlerts.length, 1);
    assert.equal(event.paymentTransactionId, "existing-business-transaction");
  });

  test("模拟支付回写失败后重试复用原交易号并只补偿柜机回写", async () => {
    const harness = createPaymentHarness();
    const order = appendPaidOrder(harness, {
      id: "mock-forward-retry",
      paymentNo: "mock-forward-retry-payment",
      status: "pending",
      providerTransactionId: undefined,
      paidAt: undefined,
      metadata: { simulated: true }
    });
    let notificationCalls = 0;
    Object.assign(harness.service as object, {
      cabinetEventsService: {
        async notifyConfirmedPaymentSuccess() {
          notificationCalls += 1;
          if (notificationCalls === 1) {
            throw new Error("柜机平台暂时不可用");
          }
        }
      }
    });
    const actor = { id: harness.event.userId, role: "special" as const };

    await assert.rejects(
      harness.service.markMockPaid(order.id, actor),
      /回写尚未完成/
    );
    const originalTransactionId = order.providerTransactionId;
    assert.ok(originalTransactionId);
    await harness.service.markMockPaid(order.id, actor);
    assert.equal(order.providerTransactionId, originalTransactionId);
    assert.equal(order.metadata?.smartVmForwardState, "completed");
    assert.equal(notificationCalls, 2);
  });

  test("微信支付回调币种不是人民币时拒绝入账", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_APP_ID: "expected-wechat-app",
        WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      paymentNo: "wechat-payment-wrong-currency",
      status: "pending",
      amount: 500,
      paidAt: undefined
    });
    const body = {
      appid: "expected-wechat-app",
      mchid: "expected-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: "wechat-transaction-wrong-currency",
      trade_state: "SUCCESS",
      amount: { total: order.amount, currency: "USD" }
    };
    const rawBody = JSON.stringify(body);

    await assert.rejects(
      harness.service.handleWechatCallback(
        body,
        signWechatPayload(rawBody, privateKey),
        rawBody
      ),
      /币种必须为 CNY/
    );
    assert.equal(order.status, "pending");
    assert.equal(harness.cabinetPaymentNotifications.length, 0);
  });

  test("微信退款回调必须绑定本地商户，错商户回调不得改变退款状态", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness);
    const now = new Date().toISOString();
    const refund: PaymentRefundRecord = {
      id: "wechat-refund-wrong-merchant",
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: "wechat-refund-no-wrong-merchant",
      provider: "wechat",
      status: "pending",
      amount: 400,
      createdAt: now,
      updatedAt: now
    };
    harness.store.paymentRefunds.push(refund);
    const body = {
      mchid: "other-wechat-merchant",
      out_trade_no: order.paymentNo,
      out_refund_no: refund.refundNo,
      refund_id: "provider-refund-wrong-merchant",
      refund_status: "SUCCESS",
      amount: {
        total: order.amount,
        refund: refund.amount,
        currency: "CNY"
      }
    };
    const rawBody = JSON.stringify(body);

    await assert.rejects(
      harness.service.handleWechatRefundCallback(
        body,
        signWechatPayload(rawBody, privateKey),
        rawBody
      ),
      /退款回调商户标识与本地配置不一致/
    );
    assert.equal(refund.status, "pending");
    assert.equal(refund.providerRefundId, undefined);
    assert.equal(order.status, "paid");
  });

  test("微信退款回调币种不是人民币时拒绝应用退款且零业务副作用", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness);
    const now = new Date().toISOString();
    const refund: PaymentRefundRecord = {
      id: "wechat-refund-wrong-currency",
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: "wechat-refund-no-wrong-currency",
      provider: "wechat",
      status: "pending",
      amount: 400,
      createdAt: now,
      updatedAt: now
    };
    harness.store.paymentRefunds.push(refund);
    const body = {
      mchid: "expected-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: order.providerTransactionId,
      out_refund_no: refund.refundNo,
      refund_id: "provider-refund-wrong-currency",
      refund_status: "SUCCESS",
      amount: {
        total: order.amount,
        refund: refund.amount,
        currency: "USD"
      }
    };
    const rawBody = JSON.stringify(body);

    await assert.rejects(
      harness.service.handleWechatRefundCallback(
        body,
        signWechatPayload(rawBody, privateKey),
        rawBody
      ),
      /退款回调币种必须为 CNY/
    );
    assert.equal(refund.status, "pending");
    assert.equal(refund.providerRefundId, undefined);
    assert.equal(order.status, "paid");
    assert.equal(harness.inventoryRefunds.length, 0);
  });

  test("微信退款回调必须完整绑定原交易、订单总额和供应商退款号", async () => {
    const variants = [
      {
        name: "原交易号错绑",
        patch: { transaction_id: "wrong-provider-transaction" },
        message: /原支付交易号不匹配/
      },
      {
        name: "订单总额错绑",
        patch: { amount: { total: 999, refund: 400, currency: "CNY" } },
        message: /订单总额不匹配/
      },
      {
        name: "供应商退款号缺失",
        patch: { refund_id: undefined },
        message: /缺少 refund_id/
      }
    ] as const;

    for (const variant of variants) {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
      });
      const harness = createPaymentHarness({
        config: {
          PAYMENT_MODE: "mock",
          WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
          WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
        }
      });
      const order = appendPaidOrder(harness, {
        providerTransactionId: "wechat-refund-original-transaction"
      });
      const now = new Date().toISOString();
      const refund: PaymentRefundRecord = {
        id: `wechat-refund-binding-${variant.name}`,
        paymentOrderId: order.id,
        paymentNo: order.paymentNo,
        refundNo: `wechat-refund-no-binding-${variant.name}`,
        provider: "wechat",
        status: "pending",
        amount: 400,
        createdAt: now,
        updatedAt: now
      };
      harness.store.paymentRefunds.push(refund);
      const body = {
        mchid: "expected-wechat-merchant",
        out_trade_no: order.paymentNo,
        transaction_id: order.providerTransactionId,
        out_refund_no: refund.refundNo,
        refund_id: "provider-refund-binding",
        refund_status: "SUCCESS",
        amount: {
          total: order.amount,
          refund: refund.amount,
          currency: "CNY"
        },
        ...variant.patch
      };
      const rawBody = JSON.stringify(body);

      await assert.rejects(
        harness.service.handleWechatRefundCallback(
          body,
          signWechatPayload(rawBody, privateKey),
          rawBody
        ),
        variant.message,
        variant.name
      );
      assert.equal(refund.status, "pending", variant.name);
      assert.equal(refund.providerRefundId, undefined, variant.name);
      assert.equal(order.status, "paid", variant.name);
      assert.equal(harness.inventoryRefunds.length, 0, variant.name);
    }
  });

  test("微信官方退款回调未携带 currency 时仍可按完整账本绑定成功处理", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness, {
      providerTransactionId: "wechat-official-refund-transaction"
    });
    const now = new Date().toISOString();
    const refund: PaymentRefundRecord = {
      id: "wechat-official-refund-callback",
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: "wechat-official-refund-no",
      provider: "wechat",
      status: "pending",
      amount: 400,
      createdAt: now,
      updatedAt: now
    };
    harness.store.paymentRefunds.push(refund);
    const body = {
      mchid: "expected-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: order.providerTransactionId,
      out_refund_no: refund.refundNo,
      refund_id: "wechat-official-provider-refund",
      refund_status: "SUCCESS",
      amount: {
        total: order.amount,
        refund: refund.amount,
        payer_total: order.amount,
        payer_refund: refund.amount
      }
    };
    const rawBody = JSON.stringify(body);

    await harness.service.handleWechatRefundCallback(
      body,
      signWechatPayload(rawBody, privateKey),
      rawBody
    );
    assert.equal(refund.status, "success");
    assert.equal(refund.providerRefundId, "wechat-official-provider-refund");
    assert.equal(order.status, "paid");
    assert.equal(harness.inventoryRefunds.length, 0);
  });

  test("微信退款回调状态缺失或未知时拒绝改写本地退款单", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const harness = createPaymentHarness({
      config: {
        PAYMENT_MODE: "mock",
        WECHAT_PAY_MCH_ID: "expected-wechat-merchant",
        WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey
      }
    });
    const order = appendPaidOrder(harness);
    const now = new Date().toISOString();
    const refund: PaymentRefundRecord = {
      id: "wechat-refund-unknown-status",
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: "wechat-refund-no-unknown-status",
      provider: "wechat",
      status: "pending",
      amount: 400,
      createdAt: now,
      updatedAt: now
    };
    harness.store.paymentRefunds.push(refund);
    const body = {
      mchid: "expected-wechat-merchant",
      out_trade_no: order.paymentNo,
      transaction_id: order.providerTransactionId,
      out_refund_no: refund.refundNo,
      refund_id: "provider-refund-unknown-status",
      refund_status: "MYSTERY",
      amount: {
        total: order.amount,
        refund: refund.amount,
        currency: "CNY"
      }
    };
    const rawBody = JSON.stringify(body);

    await assert.rejects(
      harness.service.handleWechatRefundCallback(
        body,
        signWechatPayload(rawBody, privateKey),
        rawBody
      ),
      /退款状态无效/
    );
    assert.equal(refund.status, "pending");
    assert.equal(refund.providerRefundId, undefined);
  });
});

const createCabinetHarness = (options?: {
  event?: CabinetEventRecord;
  mockTransport?: boolean;
  signatureValid?: boolean;
  config?: Record<string, string>;
  financialOperations?: FinancialOperationCoordinator;
  quotaSummary?: {
    remainingToday: Record<string, number>;
    remainingByGoods: Record<string, number>;
    remainingDaily: number;
  };
}) => {
  let sequence = 0;
  const event = options?.event ?? createEvent({ role: "merchant", userId: "merchant-1" });
  const callbackLog: Array<{ id: string; type: string; receivedAt: string; payload: unknown }> = [];
  const inventory: InventoryMovement[] = [];
  const operations: unknown[] = [];
  const alerts: unknown[] = [];
  const deviceRuntime = { doorState: "closed", openedAfterLastCommand: false };
  const fulfilledReservations: Array<{ reservationId?: string; eventId: string }> = [];
  const store = {
    events: [event],
    callbackLog,
    inventory,
    users: [],
    devices: [],
    goodsCatalog: [],
    paymentOrders: [] as PaymentOrderRecord[],
    paymentRefunds: [] as PaymentRefundRecord[],
    createId(prefix: string) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
    createReference(prefix: string) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
    logCallback(type: string, payload: unknown) {
      const record = {
        id: `callback-${++sequence}`,
        type,
        receivedAt: new Date().toISOString(),
        payload
      };
      callbackLog.unshift(record);
      return record;
    },
    logOperation(entry: unknown) {
      operations.push(entry);
      return entry;
    },
    updateDeviceRuntime(_deviceCode: string, patch: Record<string, unknown>) {
      Object.assign(deviceRuntime, patch);
      return deviceRuntime;
    },
    getDeviceRuntime() {
      return deviceRuntime;
    }
  };
  let settlementCalls = 0;
  const inventoryOrders = {
    validateSettlementPayload() {
      return undefined;
    },
    validateAdjustmentPayload() {
      return undefined;
    },
    recordSettlement(recordEvent: CabinetEventRecord, payload: { orderNo: string; amount: number }) {
      settlementCalls += 1;
      const existing = inventory.filter(
        (entry) => entry.orderNo === payload.orderNo && entry.type === "pickup"
      );

      if (existing.length) {
        return { movements: existing, duplicated: true };
      }

      const movement: InventoryMovement = {
        id: `movement-${++sequence}`,
        orderNo: payload.orderNo,
        eventId: recordEvent.eventId,
        userId: recordEvent.userId,
        deviceCode: recordEvent.deviceCode,
        goodsId: "goods-1",
        goodsName: "测试商品",
        category: "daily",
        quantity: 1,
        unitPrice: payload.amount,
        type: "pickup",
        happenedAt: new Date().toISOString()
      };
      inventory.unshift(movement);
      return { movements: [movement], duplicated: false };
    },
    recordAdjustment() {
      return { movements: [], duplicated: false };
    }
  };
  let paymentNotifyCalls = 0;
  const gateway = {
    verifySignedPayload() {
      return options?.signatureValid ?? true;
    },
    isUsingMockTransport() {
      return options?.mockTransport ?? false;
    },
    async notifyPaymentSuccess() {
      paymentNotifyCalls += 1;
      return { smartVmExchange: undefined };
    },
    extractErrorMessage(error: unknown) {
      return error instanceof Error ? error.message : "error";
    },
    extractExchangeTrace() {
      return undefined;
    }
  };
  const service = new CabinetEventsService(
    store as unknown as InMemoryStoreService,
    {
      getQuotaSummaryForUser() {
        return (
          options?.quotaSummary ?? {
            remainingToday: {},
            remainingByGoods: {},
            remainingDaily: 0
          }
        );
      }
    } as unknown as AccessRulesService,
    gateway as unknown as SmartVmGateway,
    inventoryOrders as unknown as InventoryOrdersService,
    { create(entry: unknown) { alerts.push(entry); return entry; } } as unknown as AlertsService,
    {
      markFulfilled(reservationId: string | undefined, eventId: string) {
        fulfilledReservations.push({ reservationId, eventId });
      }
    } as unknown as ReservationsService,
    new ConfigService({
      SMARTVM_CALLBACK_MAX_AGE_SECONDS: "300",
      SMARTVM_CALLBACK_EVENT_MAX_AGE_SECONDS: "604800",
      ...options?.config
    }),
    undefined,
    undefined,
    options?.financialOperations
  );

  return {
    event,
    store,
    service,
    operations,
    alerts,
    deviceRuntime,
    fulfilledReservations,
    bindPaidPayment(
      transactionId: string,
      businessOrderNo = event.orderNo,
      amount = event.amount
    ) {
      const now = new Date().toISOString();
      const paymentOrder: PaymentOrderRecord = {
        id: `cabinet-payment-${++sequence}`,
        paymentNo: `cabinet-payment-no-${sequence}`,
        provider: "wechat",
        phase: "post_settlement",
        status: "paid",
        amount,
        currency: "CNY",
        subject: "柜机回写测试支付单",
        eventId: event.eventId,
        orderNo: event.orderNo,
        adjustmentOrderNo:
          businessOrderNo === event.orderNo ? undefined : businessOrderNo,
        deviceCode: event.deviceCode,
        payerUserId: event.userId,
        providerTransactionId: transactionId,
        metadata: { simulated: false },
        createdAt: now,
        updatedAt: now,
        paidAt: now
      };
      store.paymentOrders.push(paymentOrder);
      return paymentOrder;
    },
    get settlementCalls() {
      return settlementCalls;
    },
    get paymentNotifyCalls() {
      return paymentNotifyCalls;
    }
  };
};

describe("SmartVM 回调完整性", () => {
  test("门状态只允许向前迁移，历史回调不会把已关门事件改回开门", () => {
    const harness = createCabinetHarness({
      event: createEvent({ status: "created", role: "merchant", userId: "merchant-1" })
    });
    const base = {
      eventId: harness.event.eventId,
      deviceCode: harness.event.deviceCode,
      clientId: "smartvm-client",
      timestamp: Math.floor(Date.now() / 1000),
      sign: "verified"
    };

    harness.service.handleDoorStatus({ ...base, nonceStr: "nonce-open", status: "SUCCESS" });
    assert.equal(harness.event.status, "opened");
    harness.service.handleDoorStatus({ ...base, nonceStr: "nonce-opening", status: "OPENDING" });
    assert.equal(harness.event.status, "opened");
    harness.service.handleDoorStatus({ ...base, nonceStr: "nonce-closed", status: "CLOSED" });
    assert.equal(harness.event.status, "closed");
    harness.service.handleDoorStatus({ ...base, nonceStr: "nonce-open-replay", status: "SUCCESS" });
    assert.equal(harness.event.status, "closed");
  });

  test("结算先到后可信开门成功仍更新物理状态和预约，但不覆盖结算终态", () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "created",
        amount: 0,
        role: "merchant",
        userId: "merchant-1",
        reservationId: "reservation-late-success"
      })
    });
    const callbackBase = {
      eventId: harness.event.eventId,
      phone: harness.event.phone,
      deviceCode: harness.event.deviceCode,
      clientId: "smartvm-client",
      timestamp: Math.floor(Date.now() / 1000),
      sign: "verified"
    };

    harness.service.handleSettlement({
      ...callbackBase,
      orderNo: harness.event.orderNo,
      amount: 500,
      notifyUrl: "http://127.0.0.1/mock-payment-notify",
      detail: [
        {
          goodsId: "goods-1",
          goodsName: "测试商品",
          quantity: 1,
          unitPrice: 500
        }
      ],
      nonceStr: "nonce-settlement-before-success"
    });
    assert.equal(harness.event.status, "settled");

    const result = harness.service.handleDoorStatus({
      ...callbackBase,
      nonceStr: "nonce-success-after-settlement",
      status: "SUCCESS"
    });

    assert.equal("ignored" in result && result.ignored === true, false);
    assert.equal(harness.event.status, "settled");
    assert.equal(harness.deviceRuntime.doorState, "open");
    assert.equal(harness.deviceRuntime.openedAfterLastCommand, true);
    assert.deepEqual(harness.fulfilledReservations, [
      {
        reservationId: "reservation-late-success",
        eventId: harness.event.eventId
      }
    ]);

    harness.service.handleDoorStatus({
      ...callbackBase,
      nonceStr: "nonce-close-after-late-success",
      status: "CLOSED",
      doorIsOpen: "N"
    });
    const historicalSuccess = harness.service.handleDoorStatus({
      ...callbackBase,
      nonceStr: "nonce-success-after-close",
      status: "SUCCESS"
    });
    assert.equal(
      ("ignored" in historicalSuccess && historicalSuccess.ignored === true) ||
        ("duplicated" in historicalSuccess && historicalSuccess.duplicated === true),
      true
    );
    assert.equal(harness.event.status, "settled");
    assert.equal(harness.deviceRuntime.doorState, "closed");
  });

  test("结算回调精确去重，冲突重放不会覆盖金额或重复库存副作用", () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "closed",
        amount: 0,
        role: "merchant",
        userId: "merchant-1"
      })
    });
    const payload = {
      orderNo: harness.event.orderNo,
      eventId: harness.event.eventId,
      phone: harness.event.phone,
      deviceCode: harness.event.deviceCode,
      amount: 500,
      notifyUrl: "http://127.0.0.1/mock-payment-notify",
      detail: [
        {
          goodsId: "goods-1",
          goodsName: "测试商品",
          quantity: 1,
          unitPrice: 500
        }
      ],
      clientId: "smartvm-client",
      nonceStr: "nonce-settlement-1",
      timestamp: Math.floor(Date.now() / 1000),
      sign: "verified"
    };

    const first = harness.service.handleSettlement(payload);
    const duplicate = harness.service.handleSettlement({
      ...payload,
      nonceStr: "nonce-settlement-2",
      sign: "verified-again"
    });
    assert.equal(first.duplicated, false);
    assert.equal(duplicate.duplicated, true);
    assert.equal(harness.settlementCalls, 1);
    assert.equal(harness.store.inventory.length, 1);
    assert.equal(harness.event.platformAmount, 500);

    assert.throws(
      () => harness.service.handleSettlement({
        ...payload,
        amount: 600,
        nonceStr: "nonce-settlement-conflict"
      }),
      /同一柜机业务回调携带了冲突内容/
    );
    assert.equal(harness.event.platformAmount, 500);
    assert.equal(harness.store.inventory.length, 1);
  });

  test("同商品同数量的回调涨价只触发差异核对，用户金额仍锁定开柜报价", () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "closed",
        amount: 500,
        billingStatus: "pending",
        intentItems: [
          {
            goodsId: "goods-1",
            goodsName: "测试商品",
            category: "daily",
            quantity: 1
          }
        ],
        preSettlement: {
          deviceCode: "CAB-PAYMENT-1",
          doorNum: "1",
          createdAt: new Date().toISOString(),
          totalQuantity: 1,
          freeQuantity: 0,
          paidQuantity: 1,
          originalAmount: 500,
          freeAmount: 0,
          payableAmount: 500,
          chargeRequired: true,
          summary: "预计支付 ￥5.00",
          items: [
            {
              goodsId: "goods-1",
              goodsName: "测试商品",
              category: "daily",
              quantity: 1,
              freeQuantity: 0,
              paidQuantity: 1,
              unitPrice: 500,
              originalAmount: 500,
              freeAmount: 0,
              paidAmount: 500
            }
          ]
        }
      }),
      quotaSummary: {
        remainingToday: {},
        remainingByGoods: {},
        remainingDaily: 0
      }
    });
    const payload = {
      orderNo: harness.event.orderNo,
      eventId: harness.event.eventId,
      phone: harness.event.phone,
      deviceCode: harness.event.deviceCode,
      amount: 600,
      notifyUrl: "http://127.0.0.1/mock-payment-notify",
      detail: [
        {
          goodsId: "goods-1",
          goodsName: "测试商品",
          quantity: 1,
          unitPrice: 600
        }
      ],
      clientId: "smartvm-client",
      nonceStr: "nonce-price-drift",
      timestamp: Math.floor(Date.now() / 1000),
      sign: "verified"
    };

    harness.service.handleSettlement(payload);
    assert.equal(harness.event.platformAmount, 600);
    assert.equal(harness.event.amount, 500);
    assert.equal(harness.event.billingActualAmount, 500);
    assert.equal(harness.event.billingDeltaAmount, 0);
    assert.equal(harness.event.billingStatus, "mismatch");
    assert.equal(harness.event.settlementComparison?.matched, false);
    assert.deepEqual(harness.event.settlementComparison?.priceMismatches, [
      {
        goodsId: "goods-1",
        goodsName: "测试商品",
        quantity: 1,
        quotedUnitPrice: 500,
        platformUnitPrice: 600
      }
    ]);
    assert.match(harness.event.settlementComparison?.summary ?? "", /仍按开柜前确认的报价计算/);
  });

  test("管理员不能在物理流程或账务状态未满足时提前解除用户阻断", () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "opened",
        physicalDoorState: "open",
        billingStatus: "pending"
      })
    });

    assert.throws(
      () => harness.service.confirmBillingResolution(harness.event.eventId, "admin-1"),
      /只有已结算且存在待处理费用或差异/
    );
    assert.equal(harness.event.billingResolvedAt, undefined);

    harness.event.status = "settled";
    harness.event.billingStatus = "mismatch";
    harness.service.confirmBillingResolution(harness.event.eventId, "admin-1", {
      note: "已核对平台价差"
    });
    assert.equal(harness.event.billingStatus, "admin_confirmed");
    assert.ok(harness.event.billingResolvedAt);
  });

  test("真实回调受时效窗口约束，但本地 mock 旧事件仍可联调", () => {
    const oldCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const realHarness = createCabinetHarness({
      event: createEvent({
        status: "created",
        role: "merchant",
        userId: "merchant-1",
        createdAt: oldCreatedAt
      })
    });
    const callback = {
      eventId: realHarness.event.eventId,
      deviceCode: realHarness.event.deviceCode,
      status: "SUCCESS" as const,
      clientId: "smartvm-client",
      nonceStr: "old-real-callback",
      sign: "verified"
    };
    assert.throws(
      () => realHarness.service.handleDoorStatus(callback),
      /超过允许的回调处理窗口/
    );

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const mockHarness = createCabinetHarness({
        event: createEvent({
          orderNo: "mock-order-old",
          status: "created",
          role: "merchant",
          userId: "merchant-1",
          createdAt: oldCreatedAt
        }),
        mockTransport: true,
        signatureValid: false
      });
      mockHarness.service.handleDoorStatus({
        eventId: mockHarness.event.eventId,
        deviceCode: mockHarness.event.deviceCode,
        status: "SUCCESS"
      });
      assert.equal(mockHarness.event.status, "opened");
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  test("付款回写使用服务端金额，同一交易只向 SmartVM 转发一次", async () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "settled",
        amount: 500,
        paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
        role: "special"
      })
    });
    const payload = {
      orderNo: harness.event.orderNo,
      eventId: harness.event.eventId,
      transactionId: "payment-transaction-1",
      deviceCode: harness.event.deviceCode,
      amount: 500
    };
    harness.bindPaidPayment(payload.transactionId);

    const first = await harness.service.notifyPaymentSuccess(payload, "admin-1");
    const duplicate = await harness.service.notifyPaymentSuccess(payload, "admin-1");
    assert.equal(first.forwarded, true);
    assert.equal(duplicate.duplicated, true);
    assert.equal(harness.paymentNotifyCalls, 1);

    await assert.rejects(
      harness.service.notifyPaymentSuccess({ ...payload, amount: 499 }, "admin-1"),
      /付款成功金额与服务端业务金额不一致/
    );
    await assert.rejects(
      harness.service.notifyPaymentSuccess(
        {
          ...payload,
          transactionId: "payment-transaction-conflict"
        },
        "admin-1"
      ),
      /已由其他交易号完成付款回写/
    );
    assert.equal(harness.paymentNotifyCalls, 1);
  });

  test("即使误开自动转发开关，正金额结算也不能生成伪付款成功回写", () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "closed",
        role: "special",
        amount: 500,
        intentItems: [
          {
            goodsId: "goods-1",
            goodsName: "测试商品",
            category: "daily",
            quantity: 1
          }
        ],
        preSettlement: {
          deviceCode: "CAB-PAYMENT-1",
          doorNum: "1",
          createdAt: new Date().toISOString(),
          totalQuantity: 1,
          freeQuantity: 0,
          paidQuantity: 1,
          originalAmount: 500,
          freeAmount: 0,
          payableAmount: 500,
          chargeRequired: true,
          summary: "预计支付 ￥5.00",
          items: [
            {
              goodsId: "goods-1",
              goodsName: "测试商品",
              category: "daily",
              quantity: 1,
              freeQuantity: 0,
              paidQuantity: 1,
              unitPrice: 500,
              originalAmount: 500,
              freeAmount: 0,
              paidAmount: 500
            }
          ]
        }
      }),
      config: {
        SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "true"
      }
    });

    harness.service.handleSettlement({
      orderNo: harness.event.orderNo,
      eventId: harness.event.eventId,
      phone: harness.event.phone,
      deviceCode: harness.event.deviceCode,
      amount: 500,
      notifyUrl: "http://127.0.0.1/mock-payment-notify",
      detail: [
        {
          goodsId: "goods-1",
          goodsName: "测试商品",
          quantity: 1,
          unitPrice: 500
        }
      ],
      clientId: "smartvm-client",
      nonceStr: "positive-settlement-auto-forward-disabled",
      timestamp: Math.floor(Date.now() / 1000),
      sign: "verified"
    });

    assert.equal(harness.event.paymentNotifyStatus, "pending");
    assert.match(harness.event.paymentNotifyMessage ?? "", /等待用户支付成功/);
    assert.equal(harness.paymentNotifyCalls, 0);
  });

  test("生产运行时即使配置允许也绝不接受未签名 SmartVM 回调", () => {
    const previousAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = "production";

    try {
      const gateway = new SmartVmGateway(
        new ConfigService({
          SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "true"
        })
      );
      assert.equal(
        gateway.verifySignedPayload({
          orderNo: "unsigned-production-callback"
        }),
        false
      );
    } finally {
      if (previousAppEnv === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = previousAppEnv;
      }
    }
  });

  test("自动与手工付款回写并发时，同一业务订单只外呼一次", async () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "settled",
        amount: 500,
        paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
        role: "special"
      })
    });
    const payload = {
      orderNo: harness.event.orderNo,
      eventId: harness.event.eventId,
      transactionId: "payment-transaction-concurrent",
      deviceCode: harness.event.deviceCode,
      amount: 500
    };
    const paymentOrder = harness.bindPaidPayment(payload.transactionId);
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    let notifyCalls = 0;
    Object.assign(harness.service as object, {
      smartVmGateway: {
        async notifyPaymentSuccess() {
          notifyCalls += 1;
          await notifyGate;
          return { smartVmExchange: undefined };
        }
      }
    });

    const automatic = harness.service.notifyConfirmedPaymentSuccess(
      payload,
      paymentOrder.id
    );
    while (notifyCalls === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const manual = harness.service.notifyPaymentSuccess(payload, "admin-1");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(notifyCalls, 1);

    releaseNotify();
    const [automaticResult, manualResult] = await Promise.all([automatic, manual]);
    assert.equal(automaticResult.forwarded, true);
    assert.equal(manualResult.duplicated, true);
    assert.equal(notifyCalls, 1);
  });

  test("手工付款回写进行中时，正式退款与其共用业务协调锁", async () => {
    const financialOperations = new FinancialOperationCoordinator();
    const event = createEvent({
      status: "settled",
      amount: 500,
      paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
      role: "special"
    });
    const cabinetHarness = createCabinetHarness({
      event,
      financialOperations
    });
    const paymentHarness = createPaymentHarness({
      event,
      financialOperations
    });
    const order = appendPaidOrder(paymentHarness, {
      id: "manual-forward-refund-race",
      paymentNo: "manual-forward-refund-race-no",
      amount: event.amount,
      providerTransactionId: "manual-forward-refund-race-transaction",
      metadata: { simulated: true }
    });
    cabinetHarness.store.paymentOrders.push(order);
    Object.assign(paymentHarness.service as object, {
      inventoryOrdersService: {
        markRefund() {
          event.status = "refunded";
          event.refundedAt = new Date().toISOString();
        }
      }
    });
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    let notifyStarted = false;
    Object.assign(cabinetHarness.service as object, {
      smartVmGateway: {
        async notifyPaymentSuccess() {
          notifyStarted = true;
          await notifyGate;
          return { smartVmExchange: undefined };
        }
      }
    });
    const payload = {
      orderNo: event.orderNo,
      eventId: event.eventId,
      transactionId: order.providerTransactionId!,
      deviceCode: event.deviceCode,
      amount: event.amount
    };

    const manualForward = cabinetHarness.service.notifyPaymentSuccess(
      payload,
      "admin-1"
    );
    while (!notifyStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let refundSettled = false;
    const refund = paymentHarness
      .refund(
        { paymentOrderId: order.id, amount: order.amount },
        { id: "admin-1", role: "admin" },
        "manual-forward-refund-race-001"
      )
      .finally(() => {
        refundSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(refundSettled, false);
    assert.equal(paymentHarness.store.paymentRefunds.length, 0);

    releaseNotify();
    await manualForward;
    await refund;
    assert.equal(order.status, "refunded");
    assert.equal(event.status, "refunded");
  });

  test("支付服务与柜机服务共享协调器时，自动付款回写不会重复获取同一业务锁", async () => {
    const financialOperations = new FinancialOperationCoordinator();
    const event = createEvent({
      status: "settled",
      amount: 500,
      paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
      role: "special"
    });
    const cabinetHarness = createCabinetHarness({
      event,
      financialOperations
    });
    const paymentHarness = createPaymentHarness({
      event,
      financialOperations
    });
    const order = appendPaidOrder(paymentHarness, {
      id: "shared-coordinator-auto-forward",
      paymentNo: "shared-coordinator-auto-forward-no",
      status: "pending",
      amount: event.amount,
      providerTransactionId: "shared-coordinator-auto-forward-transaction",
      paidAt: undefined,
      metadata: { simulated: true }
    });
    cabinetHarness.store.paymentOrders.push(order);
    Object.assign(paymentHarness.service as object, {
      cabinetEventsService: cabinetHarness.service
    });

    const completed = await Promise.race([
      paymentHarness.service
        .markMockPaid(order.id, {
          id: event.userId,
          role: "special"
        })
        .then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 200);
      })
    ]);

    assert.equal(completed, true);
    assert.equal(order.status, "paid");
    assert.equal(order.metadata?.smartVmForwardState, "completed");
    assert.equal(cabinetHarness.paymentNotifyCalls, 1);
  });

  test("柜机内部回写只接受协调器当前签发且精确绑定业务的租约", async () => {
    const financialOperations = new FinancialOperationCoordinator();
    const event = createEvent({
      status: "settled",
      amount: 500,
      paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
      role: "special"
    });
    const harness = createCabinetHarness({
      event,
      financialOperations
    });
    const paymentOrder = harness.bindPaidPayment("lease-bound-transaction");
    const payload = {
      orderNo: event.orderNo,
      eventId: event.eventId,
      transactionId: "lease-bound-transaction",
      deviceCode: event.deviceCode,
      amount: event.amount
    };
    const forgedLease: FinancialOperationLease = {
      eventId: event.eventId,
      businessOrderNo: event.orderNo
    };

    await assert.rejects(
      harness.service.notifyConfirmedPaymentSuccess(
        payload,
        paymentOrder.id,
        forgedLease
      ),
      /金融操作租约无效/
    );

    let expiredLease: FinancialOperationLease | undefined;
    await financialOperations.run(
      event.eventId,
      event.orderNo,
      async (lease) => {
        expiredLease = lease;
      }
    );
    await assert.rejects(
      harness.service.notifyConfirmedPaymentSuccess(
        payload,
        paymentOrder.id,
        expiredLease
      ),
      /金融操作租约无效/
    );
    assert.equal(harness.paymentNotifyCalls, 0);
  });

  test("伪入站付款成功回调已停用，不能凭 SmartVM 签名创建支付事实", async () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "settled",
        amount: 500,
        paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
        role: "special"
      })
    });

    await assert.rejects(
      harness.service.handlePaymentSuccess({
        orderNo: harness.event.orderNo,
        eventId: harness.event.eventId,
        transactionId: "untrusted-smartvm-transaction",
        deviceCode: harness.event.deviceCode,
        amount: 500,
        clientId: "smartvm-client",
        nonceStr: "payment-success-inbound-disabled",
        timestamp: Math.floor(Date.now() / 1000),
        sign: "verified"
      }),
      /付款成功通知是本系统.*出站能力.*入站兼容路由已停用/
    );
    assert.equal(harness.store.paymentOrders.length, 0);
    assert.equal(harness.event.paymentNotifyStatus, undefined);
    assert.equal(harness.event.paymentTransactionId, undefined);
    assert.equal(harness.paymentNotifyCalls, 0);
    assert.equal(harness.store.callbackLog.length, 0);
  });

  test("支付服务自动回写使用系统身份并绑定精确支付单，不冒用管理员身份", async () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "settled",
        amount: 500,
        paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
        role: "special"
      })
    });
    const paymentOrder = harness.bindPaidPayment("confirmed-payment-transaction");

    await harness.service.notifyConfirmedPaymentSuccess(
      {
        orderNo: harness.event.orderNo,
        eventId: harness.event.eventId,
        transactionId: "confirmed-payment-transaction",
        deviceCode: harness.event.deviceCode,
        amount: 500
      },
      paymentOrder.id
    );

    const operation = harness.operations.find(
      (entry) =>
        (entry as { type?: string }).type === "payment-service-payment-success"
    ) as
      | {
          actor?: { type?: string; id?: string };
          metadata?: { paymentOrderId?: string };
        }
      | undefined;
    assert.equal(operation?.actor?.type, "system");
    assert.equal(operation?.actor?.id, undefined);
    assert.equal(operation?.metadata?.paymentOrderId, paymentOrder.id);
    assert.equal(harness.paymentNotifyCalls, 1);
  });

  test("已全额退款的支付单不能重新向柜机平台回写付款成功", async () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "settled",
        amount: 500,
        paymentNotifyUrl: "http://127.0.0.1/mock-payment-notify",
        role: "special"
      })
    });
    const paymentOrder = harness.bindPaidPayment("refunded-payment-transaction");
    paymentOrder.status = "refunded";

    await assert.rejects(
      harness.service.notifyPaymentSuccess(
        {
          orderNo: harness.event.orderNo,
          eventId: harness.event.eventId,
          transactionId: "refunded-payment-transaction",
          deviceCode: harness.event.deviceCode,
          amount: 500
        },
        "admin-1"
      ),
      /未找到与指定支付单及交易号匹配的已支付记录/
    );
    assert.equal(harness.paymentNotifyCalls, 0);
    assert.equal(harness.event.paymentNotifyStatus, undefined);
    assert.equal(harness.event.paymentTransactionId, undefined);
  });

  test("补扣回调重放不会把已成功的付款回写状态降回待处理", async () => {
    const harness = createCabinetHarness({
      event: createEvent({
        status: "settled",
        role: "special",
        amount: 500
      })
    });
    const callback = {
      orgOrderNo: harness.event.orderNo,
      orderNo: "adjustment-payment-1",
      eventId: harness.event.eventId,
      phone: harness.event.phone,
      deviceCode: harness.event.deviceCode,
      amount: 200,
      noticeUrl: "http://127.0.0.1/mock-adjustment-notify",
      detail: [],
      clientId: "smartvm-client",
      nonceStr: "adjustment-nonce-1",
      timestamp: Math.floor(Date.now() / 1000),
      sign: "verified"
    };

    harness.service.handleAdjustment(callback);
    harness.bindPaidPayment(
      "adjustment-transaction-1",
      callback.orderNo,
      callback.amount
    );
    await harness.service.notifyPaymentSuccess(
      {
        orderNo: callback.orderNo,
        eventId: callback.eventId,
        transactionId: "adjustment-transaction-1",
        deviceCode: callback.deviceCode,
        amount: callback.amount
      },
      "admin-1"
    );
    assert.equal(harness.event.adjustments?.[0]?.paymentNotifyStatus, "success");

    const replay = harness.service.handleAdjustment({
      ...callback,
      nonceStr: "adjustment-nonce-2",
      sign: "verified-again"
    });
    assert.equal(replay.duplicated, true);
    assert.equal(harness.event.adjustments?.[0]?.paymentNotifyStatus, "success");
    assert.equal(harness.paymentNotifyCalls, 1);
  });
});
