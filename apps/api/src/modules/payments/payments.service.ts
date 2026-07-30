import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDecipheriv, createHash, createSign, createVerify, randomBytes } from "node:crypto";

import type {
  CabinetEventRecord,
  FinancialReconciliationState,
  PaymentDiagnosticsResult,
  PaymentEffectiveMode,
  PaymentOrderCreatePayload,
  PaymentOrderCreateResult,
  PaymentOrderReconciliationRequestResult,
  PaymentOrderRecord,
  PaymentOrderRecoverySummary,
  PaymentPayerIdentityPayload,
  PaymentPayerIdentityResult,
  PaymentProviderDiagnostics,
  PaymentProvider,
  PaymentRefundRecord,
  PaymentRefundStatus,
  PaymentRuntimeMode,
  UserRole
} from "@vm/shared-types";

import {
  FinancialOperationCoordinator,
  type FinancialOperationLease
} from "../../common/coordination/financial-operation-coordinator";
import { FinancialSingleWriterService } from "../../common/coordination/financial-single-writer.service";
import { resolveFullSimulationExternalMode } from "../../common/config/full-simulation-mode";
import { isReservationOnlyPickup } from "../../common/config/reservation-only-pickup";
import { assertConfiguredRuntimeDataPlanePaymentPolicy } from "../../common/config/runtime-data-plane-policy";
import { isProductionRuntime } from "../../common/config/runtime-environment";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";
import { CabinetEventsService } from "../cabinet-events/cabinet-events.service";
import { InventoryOrdersService } from "../inventory-orders/inventory-orders.service";
import { PaymentPayerIdentityHandleService } from "./payment-payer-identity-handle.service";

type Actor = { id: string; role: UserRole } | undefined;
type PaymentModeSettingSource =
  | "PAYMENT_MODE"
  | "PAYMENT_MOCK_ENABLED"
  | "VM_FULL_SIMULATION_PAYMENT_MODE"
  | "default";

interface PaymentModeSetting {
  mode: PaymentRuntimeMode;
  source: PaymentModeSettingSource;
  paymentModeRaw?: string;
  legacyPaymentMockEnabled?: string;
}

interface ProviderPaidPayload {
  provider: PaymentProvider;
  paymentNo: string;
  providerTransactionId?: string;
  amount?: number;
  callbackPayload?: unknown;
}

interface PaymentMode {
  simulated: boolean;
  forcedReal: boolean;
  requestedMode: PaymentRuntimeMode;
  simulatedReason?: string;
}

interface ProviderOrderResult {
  providerOrderId: string;
  invokePayload: Record<string, unknown>;
  providerResponse?: unknown;
}

interface ProviderPaymentQueryResult {
  state: "paid" | "pending" | "closed" | "failed";
  providerTransactionId?: string;
  closable: boolean;
  summary: Record<string, unknown>;
  failReason?: string;
}

interface ProviderRefundResult {
  providerRefundId?: string;
  status: PaymentRefundStatus;
  callbackPayload?: unknown;
  failReason?: string;
}

interface AutomaticReconciliationCycleSummary {
  scanned: number;
  attempted: number;
  completed: number;
  pending: number;
  failed: number;
}

type RefundActor =
  | { source: "backoffice" | "merchant"; id: string; role: UserRole }
  | { source: "smartvm" };

interface PaymentOrderContext {
  event: CabinetEventRecord;
  adjustment?: NonNullable<CabinetEventRecord["adjustments"]>[number];
  amount: number;
  businessOrderNo: string;
}

interface WechatRefundCallbackPayload {
  provider?: PaymentProvider;
  paymentNo: string;
  refundNo: string;
  providerRefundId: string;
  providerTransactionId: string;
  status: PaymentRefundStatus;
  amount?: number;
  totalAmount: number;
  callbackPayload: unknown;
  failReason?: string;
}

type AutomaticReconciliationRuntimeSafetyAssertion = () => void;

const providerLabels: Record<PaymentProvider, string> = {
  wechat: "微信支付",
  alipay: "支付宝"
};

const wechatRequiredPaymentKeys = [
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_MERCHANT_PRIVATE_KEY",
  "WECHAT_PAY_MERCHANT_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_PUBLIC_KEY"
] as const;

const alipayRequiredPaymentKeys = [
  "ALIPAY_APP_ID",
  "ALIPAY_SELLER_ID",
  "ALIPAY_APP_PRIVATE_KEY",
  "ALIPAY_PUBLIC_KEY"
] as const;

const paymentProviders = ["wechat", "alipay"] as const satisfies readonly PaymentProvider[];
const paymentOrderCreateKeys = new Set([
  "provider",
  "phase",
  "amount",
  "subject",
  "eventId",
  "orderNo",
  "adjustmentOrderNo",
  "deviceCode",
  "payerUserId",
  "merchantUserId",
  "payerIdentityHandle",
  "openRequest",
  "intentItems"
]);
const paymentRefundKeys = new Set([
  "paymentOrderId",
  "amount",
  "reason"
]);
const businessRefundKeys = new Set([
  "orderNo",
  "transactionId",
  "deviceCode",
  "refundNo",
  "amount",
  "reason"
]);
const paymentPayerIdentityKeys = new Set([
  "provider",
  "authCode"
]);

@Injectable()
export class PaymentsService {
  private readonly createOrderInFlight = new Map<
    string,
    { provider: PaymentProvider; promise: Promise<PaymentOrderCreateResult> }
  >();
  private readonly refundLocks = new Map<string, Promise<void>>();
  private readonly paymentForwardInFlight = new Map<string, Promise<boolean>>();
  private readonly financialOperations: FinancialOperationCoordinator;
  private readonly financialSingleWriter?: FinancialSingleWriterService;
  private automaticReconciliationRuntime: {
    lastStartedAt?: string;
    lastSuccessAt?: string;
    lastErrorAt?: string;
    lastError?: string;
    lastSummary?: AutomaticReconciliationCycleSummary;
  } = {};

  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(CabinetEventsService) private readonly cabinetEventsService: CabinetEventsService,
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService,
    @Inject(PaymentPayerIdentityHandleService)
    private readonly payerIdentityHandles: PaymentPayerIdentityHandleService =
      new PaymentPayerIdentityHandleService(configService),
    @Inject(AlertsService)
    private readonly alertsService: AlertsService = new AlertsService(store),
    @Optional()
    @Inject(FinancialOperationCoordinator)
    financialOperations?: FinancialOperationCoordinator,
    @Optional()
    @Inject(FinancialSingleWriterService)
    financialSingleWriter?: FinancialSingleWriterService
  ) {
    this.financialOperations =
      financialOperations ?? new FinancialOperationCoordinator();
    this.financialSingleWriter = financialSingleWriter;
  }

  async createOrder(
    payload: PaymentOrderCreatePayload,
    actor?: Actor
  ): Promise<PaymentOrderCreateResult> {
    this.assertPaymentCreationEnabled();
    this.assertFinancialWriter();
    this.assertRequestObject(payload, "支付请求体");
    this.validatePaymentOrderCreatePayload(payload);
    const context = this.resolvePaymentOrderContext(payload);
    this.assertCanCreateOrder(context.event, payload, actor);
    const idempotencyKey = this.buildPaymentIdempotencyKey(payload, context);
    const inFlight = this.createOrderInFlight.get(idempotencyKey);

    if (inFlight) {
      if (inFlight.provider !== payload.provider) {
        throw new BadRequestException("当前业务正在通过其他支付渠道创建支付单，请稍后查询原支付单。");
      }

      return inFlight.promise;
    }

    const existing = this.findIdempotentPaymentOrder(payload, context);

    if (existing) {
      if (existing.provider !== payload.provider) {
        throw new BadRequestException("当前业务已有其他支付渠道的有效支付单，请继续原支付单。");
      }

      return this.toCreateResult(existing);
    }

    const creation = this.createOrderForContext(payload, actor, context);
    const inFlightEntry = { provider: payload.provider, promise: creation };
    this.createOrderInFlight.set(idempotencyKey, inFlightEntry);

    try {
      return await creation;
    } finally {
      if (this.createOrderInFlight.get(idempotencyKey) === inFlightEntry) {
        this.createOrderInFlight.delete(idempotencyKey);
      }
    }
  }

  private async createOrderForContext(
    payload: PaymentOrderCreatePayload,
    actor: Actor,
    context: PaymentOrderContext
  ): Promise<PaymentOrderCreateResult> {
    const { event, adjustment, amount } = context;

    const payerIdentityHandle = this.readString(payload.payerIdentityHandle);
    const paymentMode = this.resolveCreatePaymentMode(
      payload.provider,
      Boolean(payerIdentityHandle)
    );
    const subject =
      payload.subject ?? this.buildSubject(payload, event, adjustment?.orderNo);
    this.assertProviderPaymentSubject(payload.provider, subject);
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }
    const payerIdentity = paymentMode.simulated
      ? undefined
      : this.payerIdentityHandles.consume(
          payerIdentityHandle ?? "",
          payload.provider,
          actor
        );
    const now = new Date().toISOString();
    const paymentNo = this.createPaymentNo(payload.provider);
    const order: PaymentOrderRecord = {
      id: this.store.createId("payment"),
      paymentNo,
      provider: payload.provider,
      phase: payload.phase,
      status: "pending",
      amount,
      currency: "CNY",
      subject,
      eventId: event.eventId,
      orderNo: event.orderNo,
      adjustmentOrderNo: adjustment?.orderNo,
      deviceCode: event.deviceCode,
      payerUserId: event.userId,
      merchantUserId: event.role === "merchant" ? event.userId : undefined,
      metadata: {
        idempotencyKey: this.buildPaymentIdempotencyKey(payload, context),
        openRequest: payload.openRequest,
        intentItems: payload.intentItems,
        payerIdentityBound: Boolean(payerIdentity),
        paymentMode: paymentMode.requestedMode,
        forcedReal: paymentMode.forcedReal,
        simulated: paymentMode.simulated,
        simulatedReason: paymentMode.simulatedReason,
        providerCreateOutcome: paymentMode.simulated ? "ready" : "submitting"
      },
      createdAt: now,
      updatedAt: now
    };

    if (paymentMode.simulated) {
      order.providerOrderId = this.createProviderOrderId(order);
      order.invokePayload = this.buildMockInvokePayload(order, paymentMode.simulatedReason);
      this.store.paymentOrders.unshift(order);
    } else {
      this.store.paymentOrders.unshift(order);

      try {
        this.store.persist();
      } catch (error) {
        this.store.paymentOrders.splice(this.store.paymentOrders.indexOf(order), 1);
        throw error;
      }

      try {
        const providerOrder = await this.createProviderPaymentOrder(
          order,
          payload,
          payerIdentity
        );
        this.assertFinancialWriter();
        order.providerOrderId = providerOrder.providerOrderId;
        order.invokePayload = providerOrder.invokePayload;
        order.metadata = {
          ...(order.metadata ?? {}),
          providerCreateOutcome: "ready",
          providerResponse: providerOrder.providerResponse
        };
        order.updatedAt = new Date().toISOString();
      } catch (error) {
        this.assertFinancialWriter();
        order.metadata = {
          ...(order.metadata ?? {}),
          providerCreateOutcome: "unknown",
          providerCreateError: this.summarizeProviderError(error)
        };
        order.updatedAt = new Date().toISOString();
        this.store.persist();
        throw error;
      }
    }

    this.store.logOperation({
      category: "inventory",
      type: "create-payment-order",
      status: "pending",
      actor: actor
        ? {
            type: actor.role,
            id: actor.id,
            name: this.store.users.find((entry) => entry.id === actor.id)?.name ?? actor.id,
            role: actor.role
          }
        : {
            type: "system",
            name: "支付系统"
          },
      primarySubject: {
        type: "event",
        id: order.eventId ?? order.id,
        label: order.orderNo ?? order.paymentNo
      },
      relatedEventId: order.eventId,
      relatedOrderNo: order.orderNo,
      metadata: {
        paymentOrderId: order.id,
        paymentNo: order.paymentNo,
        provider: order.provider,
        phase: order.phase,
        amount: order.amount,
        simulated: paymentMode.simulated,
        simulatedReason: paymentMode.simulatedReason,
        undoState: "not_undoable"
      }
    });

    return this.toCreateResult(order);
  }

  async resolvePayerIdentity(
    payload: PaymentPayerIdentityPayload,
    actor?: Actor
  ): Promise<PaymentPayerIdentityResult> {
    this.assertPaymentCreationEnabled();
    this.assertFinancialWriter();
    this.assertRequestObject(payload, "付款人身份请求体");
    this.assertOnlyRequestKeys(
      payload,
      paymentPayerIdentityKeys,
      "付款人身份请求体"
    );
    this.assertOptionalText(payload.authCode, "付款授权码", 512);
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (payload.provider !== "wechat" && payload.provider !== "alipay") {
      throw new BadRequestException("不支持的支付方式。");
    }

    if (payload.provider === "wechat") {
      return this.resolveWechatPayerIdentity(payload.authCode, actor);
    }

    return this.resolveAlipayPayerIdentity(payload.authCode, actor);
  }

  detail(id: string, actor?: Actor) {
    const order = this.findOrder(id);
    this.assertCanReadOrder(order, actor);
    return actor?.role === "special"
      ? this.toPaymentOrderRecoverySummary(order)
      : order;
  }

  requestOwnOrderReconciliation(
    id: string,
    actor?: Actor
  ): PaymentOrderReconciliationRequestResult {
    this.assertFinancialWriter();
    const order = this.findOrder(id);
    this.assertCanReadOrder(order, actor);

    if (actor?.role !== "special") {
      throw new ForbiddenException("该入口仅用于付款人本人请求安全核对。");
    }
    if (this.isSimulatedPaymentOrder(order)) {
      throw new BadRequestException("模拟支付单不需要访问真实渠道核对。");
    }
    if (order.status !== "pending") {
      throw new ConflictException("该支付单已有明确结果，无需再次核对。");
    }

    const current = this.readOrderReconciliationState(order);
    const now = new Date();
    const requestedAtMs = current.requestedByUserAt
      ? Date.parse(current.requestedByUserAt)
      : Number.NaN;
    const cooldownMs = this.readPositiveIntegerConfig(
      "PAYMENT_RECONCILIATION_USER_REQUEST_COOLDOWN_MS",
      15_000
    );
    const withinCooldown =
      Number.isFinite(requestedAtMs) &&
      now.getTime() - requestedAtMs < cooldownMs;

    if (!withinCooldown && current.state !== "manual_review") {
      const requestedAt = now.toISOString();
      this.writeOrderReconciliationState(order, {
        ...current,
        state: "scheduled",
        requestedByUserAt: requestedAt,
        nextAttemptAt: requestedAt
      });
      this.store.persist();
    }

    const state = this.readOrderReconciliationState(order);
    return {
      order: {
        ...this.toPaymentOrderRecoverySummary(order)
      },
      reconciliation: {
        state: state.state,
        nextAttemptAt: state.nextAttemptAt,
        requestedByUserAt: state.requestedByUserAt
      }
    };
  }

  async reconcileOrder(
    id: string,
    actor?: Actor,
    financialOperationLease?: FinancialOperationLease,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ): Promise<PaymentOrderRecord> {
    const order = this.findOrder(id);
    this.assertCanManagePayment(order, actor);
    if (!financialOperationLease) {
      return this.withBusinessPaymentLock(order, (lease) =>
        this.reconcileOrder(id, actor, lease, assertRuntimeSafety)
      );
    }
    this.assertBusinessPaymentLease(order, financialOperationLease);

    if (this.isSimulatedPaymentOrder(order)) {
      throw new BadRequestException("模拟支付单不调用真实支付渠道主动核对。");
    }

    if (order.status === "paid") {
      if (this.requiresSmartVmForwardRecovery(order)) {
        const providerTransactionId =
          this.readString(order.providerTransactionId) ??
          this.resolveBusinessPaymentTransactionId(order);
        if (!providerTransactionId) {
          throw new ConflictException(
            "支付已入账但原交易号缺失，无法安全补回写，必须人工核对。"
          );
        }
        return this.markPaid(
          {
            provider: order.provider,
            paymentNo: order.paymentNo,
            providerTransactionId,
            amount: order.amount,
            callbackPayload: order.callbackPayload
          },
          financialOperationLease,
          assertRuntimeSafety
        );
      }
      return order;
    }
    if (order.status === "refunded") {
      return order;
    }
    const terminalStatusBeforeQuery =
      order.status === "closed" || order.status === "failed"
        ? order.status
        : undefined;

    let queried: ProviderPaymentQueryResult;
    try {
      queried = await this.queryProviderPayment(order);
    } catch (error) {
      this.assertFinancialWriter();
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      if (terminalStatusBeforeQuery) {
        throw error;
      }
      return this.handlePaymentQueryError(order, error);
    }
    this.assertFinancialWriter();
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    this.clearProviderNotFoundEvidence(order);
    if (queried.state === "pending") {
      if (terminalStatusBeforeQuery) {
        return order;
      }
      order.status = "pending";
      order.callbackPayload = queried.summary;
      order.failReason = undefined;
      order.updatedAt = new Date().toISOString();
      this.store.persist();
      return order;
    }
    if (queried.state === "closed" || queried.state === "failed") {
      if (terminalStatusBeforeQuery) {
        return order;
      }
      const now = new Date().toISOString();
      order.status = queried.state;
      order.callbackPayload = queried.summary;
      order.failReason = queried.failReason;
      order.closedAt = queried.state === "closed" ? now : undefined;
      order.updatedAt = now;
      this.store.persist();
      return order;
    }
    if (queried.state !== "paid") {
      throw new BadGatewayException("支付渠道尚未返回可安全应用的终态。");
    }

    return this.markPaid(
      {
        provider: order.provider,
        paymentNo: order.paymentNo,
        providerTransactionId: queried.providerTransactionId,
        amount: order.amount,
        callbackPayload: queried.summary
      },
      financialOperationLease,
      assertRuntimeSafety
    );
  }

  async reconcileRefund(
    id: string,
    actor?: Actor,
    financialOperationLease?: FinancialOperationLease,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ): Promise<PaymentRefundRecord> {
    const refund = this.findRefund(id);
    const order = this.findOrder(refund.paymentOrderId);
    this.assertCanManagePayment(order, actor);
    if (!financialOperationLease) {
      return this.withBusinessPaymentLock(order, (lease) =>
        this.withRefundLock(order.id, () =>
          this.reconcileRefund(id, actor, lease, assertRuntimeSafety)
        )
      );
    }
    this.assertBusinessPaymentLease(order, financialOperationLease);

    if (this.isSimulatedPaymentOrder(order)) {
      throw new BadRequestException("模拟支付单退款不调用真实支付渠道主动核对。");
    }

    if (refund.status !== "pending") {
      return refund;
    }
    if (refund.providerOutcome === "success") {
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      this.applyRefundSuccess(order, refund, assertRuntimeSafety);
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      this.store.persist();
      return refund;
    }

    if (refund.provider === "alipay") {
      try {
        const reconciled = await this.reconcileAlipayRefund(
          order,
          refund,
          assertRuntimeSafety
        );
        this.assertFinancialWriter();
        this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
        return reconciled;
      } catch (error) {
        this.assertFinancialWriter();
        this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
        return this.handleRefundQueryError(order, refund, error);
      }
    }

    let response: Record<string, unknown>;
    try {
      response = await this.callWechatApi(
        "GET",
        `/v3/refund/domestic/refunds/${encodeURIComponent(refund.refundNo)}`
      );
    } catch (error) {
      this.assertFinancialWriter();
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      return this.handleRefundQueryError(order, refund, error);
    }
    this.assertFinancialWriter();
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    const amount =
      response.amount && typeof response.amount === "object"
        ? (response.amount as Record<string, unknown>)
        : undefined;
    const providerRefundId = this.readString(response.refund_id);
    const providerTransactionId = this.readString(response.transaction_id);
    const status = this.readString(response.status);

    if (!providerRefundId) {
      throw new BadGatewayException("微信退款查询响应缺少供应商退款号，结果保持待确认。");
    }
    if (this.readString(response.out_refund_no) !== refund.refundNo) {
      throw new BadGatewayException("微信退款查询响应的商户退款单号不匹配，结果保持待确认。");
    }
    if (this.readString(response.out_trade_no) !== order.paymentNo) {
      throw new BadGatewayException("微信退款查询响应的商户订单号不匹配，结果保持待确认。");
    }
    if (
      !providerTransactionId ||
      providerTransactionId !== this.readString(order.providerTransactionId)
    ) {
      throw new BadGatewayException("微信退款查询响应的原支付交易号不匹配，结果保持待确认。");
    }
    if (this.readAmount(amount?.refund) !== refund.amount) {
      throw new BadGatewayException("微信退款查询响应的退款金额不匹配，结果保持待确认。");
    }
    if (this.readAmount(amount?.total) !== order.amount) {
      throw new BadGatewayException("微信退款查询响应的订单总额不匹配，结果保持待确认。");
    }
    const refundCurrency = this.readString(amount?.currency);
    if (refundCurrency && refundCurrency !== order.currency) {
      throw new BadGatewayException("微信退款查询响应的币种不匹配，结果保持待确认。");
    }
    const statusMap: Record<string, PaymentRefundStatus> = {
      SUCCESS: "success",
      PROCESSING: "pending",
      ABNORMAL: "pending",
      CLOSED: "failed"
    };
    const refundStatus = status ? statusMap[status] : undefined;
    if (!refundStatus) {
      throw new BadGatewayException("微信退款查询返回了无法识别的退款状态。");
    }

    const result = this.markRefundFromProvider(
      {
        paymentNo: order.paymentNo,
        refundNo: refund.refundNo,
        providerRefundId,
        providerTransactionId,
        status: refundStatus,
        amount: refund.amount,
        totalAmount: order.amount,
        callbackPayload: {
          source: "active-query",
          refund_id: providerRefundId,
          out_refund_no: refund.refundNo,
          transaction_id: providerTransactionId,
          out_trade_no: order.paymentNo,
          status,
          amount: {
            total: order.amount,
            refund: refund.amount,
            currency: order.currency
          }
        },
        failReason:
          status === "ABNORMAL"
            ? "微信退款查询确认退款异常，保持待人工处理。"
            : status === "CLOSED"
              ? "微信退款查询确认退款已关闭。"
              : undefined
      },
      assertRuntimeSafety
    );
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    this.store.persist();
    return result;
  }

  async closeUnpaidOrder(
    id: string,
    actor?: Actor,
    financialOperationLease?: FinancialOperationLease
  ): Promise<PaymentOrderRecord> {
    const order = this.findOrder(id);
    this.assertCanManagePayment(order, actor);
    if (!financialOperationLease) {
      return this.withBusinessPaymentLock(order, (lease) =>
        this.closeUnpaidOrder(id, actor, lease)
      );
    }
    this.assertBusinessPaymentLease(order, financialOperationLease);

    if (this.isSimulatedPaymentOrder(order)) {
      throw new BadRequestException("模拟支付单不调用真实支付渠道关单。");
    }
    if (order.status === "paid" || order.status === "refunded") {
      throw new ConflictException("支付单已经支付，绝不执行关单。");
    }
    if (order.status === "closed" || order.status === "failed") {
      return order;
    }

    let beforeClose: ProviderPaymentQueryResult;
    try {
      beforeClose = await this.queryProviderPayment(order);
      this.assertFinancialWriter();
    } catch (error) {
      this.assertFinancialWriter();
      return this.handlePaymentQueryError(order, error);
    }
    this.clearProviderNotFoundEvidence(order);
    if (beforeClose.state === "paid") {
      return this.markPaid(
        {
          provider: order.provider,
          paymentNo: order.paymentNo,
          providerTransactionId: beforeClose.providerTransactionId,
          amount: order.amount,
          callbackPayload: beforeClose.summary
        },
        financialOperationLease
      );
    }
    if (beforeClose.state === "closed" || beforeClose.state === "failed") {
      return this.applyProviderPaymentTerminal(order, beforeClose);
    }
    if (!beforeClose.closable) {
      order.status = "pending";
      order.callbackPayload = beforeClose.summary;
      order.updatedAt = new Date().toISOString();
      this.store.persist();
      throw new ConflictException("支付渠道仍在处理中，当前不能安全关单。");
    }

    if (order.provider === "wechat") {
      const mchId = this.requireConfig("WECHAT_PAY_MCH_ID");
      await this.callWechatApi(
        "POST",
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.paymentNo)}/close`,
        { mchid: mchId }
      );
      this.assertFinancialWriter();
      const afterClose = await this.queryProviderPayment(order);
      this.assertFinancialWriter();
      if (afterClose.state !== "closed") {
        throw new BadGatewayException("微信关单响应无包体且复查未确认关闭，本地状态保持待确认。");
      }
      return this.applyProviderPaymentTerminal(order, afterClose);
    }

    const response = await this.callAlipayGateway("alipay.trade.close", {
      biz_content: JSON.stringify({
        out_trade_no: order.paymentNo
      })
    });
    this.assertFinancialWriter();
    const paymentNo = this.readString(response.out_trade_no);
    const tradeNo = this.readString(response.trade_no);
    const expectedTradeNo =
      this.readString(order.providerTransactionId) ??
      this.readString(order.providerOrderId);
    if (paymentNo !== order.paymentNo) {
      throw new BadGatewayException("支付宝关单响应的商户订单号不匹配，本地状态保持待确认。");
    }
    if (!tradeNo || (expectedTradeNo && tradeNo !== expectedTradeNo)) {
      throw new BadGatewayException("支付宝关单响应的交易号不匹配，本地状态保持待确认。");
    }

    return this.applyProviderPaymentTerminal(order, {
      state: "closed",
      closable: false,
      summary: {
        source: "active-close",
        seller_id: this.requireConfig("ALIPAY_SELLER_ID"),
        out_trade_no: paymentNo,
        trade_no: tradeNo,
        trade_status: "TRADE_CLOSED",
        total_amount: this.formatYuan(order.amount),
        currency: order.currency
      }
    });
  }

  recordAutomaticReconciliationStarted(at = new Date()) {
    this.automaticReconciliationRuntime = {
      ...this.automaticReconciliationRuntime,
      lastStartedAt: at.toISOString()
    };
  }

  recordAutomaticReconciliationSuccess(
    summary: AutomaticReconciliationCycleSummary,
    at = new Date()
  ) {
    this.automaticReconciliationRuntime = {
      ...this.automaticReconciliationRuntime,
      lastSuccessAt: at.toISOString(),
      lastErrorAt: undefined,
      lastError: undefined,
      lastSummary: structuredClone(summary)
    };
  }

  recordAutomaticReconciliationFailure(error: unknown, at = new Date()) {
    this.automaticReconciliationRuntime = {
      ...this.automaticReconciliationRuntime,
      lastErrorAt: at.toISOString(),
      lastError: this.summarizeProviderError(error)
    };
  }

  getPaymentDiagnostics(): PaymentDiagnosticsResult {
    const setting = this.resolvePaymentModeSetting();
    const providers = paymentProviders.map((provider) => this.buildProviderDiagnostics(provider, setting));
    const effectiveModes = new Set(providers.map((provider) => provider.effectiveMode));
    const warnings: string[] = [];
    const now = new Date();
    const paymentRecoveryCandidates = this.store.paymentOrders.filter(
      (order) => this.isPaymentOrderReconciliationCandidate(order)
    );
    const pendingPayments = paymentRecoveryCandidates.filter(
      (order) => order.status === "pending"
    );
    const pendingSmartVmForwards = paymentRecoveryCandidates.filter(
      (order) => this.requiresSmartVmForwardRecovery(order)
    );
    const pendingRefunds = this.store.paymentRefunds.filter((refund) => {
      if (refund.status !== "pending") {
        return false;
      }
      const order = this.store.paymentOrders.find(
        (entry) => entry.id === refund.paymentOrderId
      );
      return Boolean(order && !this.isSimulatedPaymentOrder(order));
    });
    const reconciliationStates = [
      ...paymentRecoveryCandidates.map((order) => ({
        state: this.readOrderReconciliationState(order),
        updatedAt: order.updatedAt
      })),
      ...pendingRefunds.map((refund) => ({
        state: this.readRefundReconciliationState(refund),
        updatedAt: refund.updatedAt
      }))
    ];
    const singleWriterStatus = this.financialSingleWriter?.getStatus() ?? {
      enabled: false,
      held: false
    };
    const automaticEnabled = ["1", "true", "yes", "on"].includes(
      this.getConfigValue("PAYMENT_RECONCILIATION_ENABLED")
        ?.trim()
        .toLowerCase() ?? ""
    );
    const reconciliation = {
      automaticEnabled,
      singleWriterEnabled: singleWriterStatus.enabled,
      singleWriterHeld: singleWriterStatus.held,
      pendingPayments: pendingPayments.length,
      pendingSmartVmForwards: pendingSmartVmForwards.length,
      pendingRefunds: pendingRefunds.length,
      dueNow: reconciliationStates.filter(({ state, updatedAt }) =>
        this.isReconciliationDue(state, updatedAt, now)
      ).length,
      manualReview: reconciliationStates.filter(
        ({ state }) => state.state === "manual_review"
      ).length,
      alerted: reconciliationStates.filter(({ state }) => Boolean(state.alertedAt))
        .length,
      ...this.automaticReconciliationRuntime
    };

    if (setting.mode === "auto") {
      warnings.push("当前为自动模式：商户配置或付款人身份不完整时，订单会进入本地模拟支付。");
    }

    if (providers.some((provider) => provider.effectiveMode === "mock")) {
      warnings.push("存在模拟支付通道：模拟订单不会调用微信或支付宝真实扣款。");
    }

    if (setting.source === "PAYMENT_MOCK_ENABLED") {
      warnings.push("当前使用旧版 PAYMENT_MOCK_ENABLED 推导支付模式；建议改用 PAYMENT_MODE=auto、mock 或 real。");
    }

    if (setting.mode === "real" && !reconciliation.automaticEnabled) {
      warnings.push("严格真实支付尚未启用后台自动对账，长期待确认状态不会自动收敛。");
    }

    if (
      setting.mode === "real" &&
      (!reconciliation.singleWriterEnabled || !reconciliation.singleWriterHeld)
    ) {
      warnings.push("当前实例未持有金融单写者租约，金融操作应保持关闭式阻断。");
    }

    return {
      generatedAt: new Date().toISOString(),
      requestedMode: setting.mode,
      requestedModeSource: setting.source,
      paymentModeRaw: setting.paymentModeRaw,
      legacyPaymentMockEnabled: setting.legacyPaymentMockEnabled,
      summary: {
        effectiveMode: effectiveModes.size === 1 ? [...effectiveModes][0]! : "mixed",
        allProvidersReadyForReal: providers.every((provider) => provider.readyForRealPayment),
        strictRealEnabled: setting.mode === "real",
        mockPaymentEndpointEnabled: providers.some((provider) => provider.mockPaymentEnabled)
      },
      reconciliation,
      providers,
      warnings
    };
  }

  formatPaymentDiagnosticsForLog(diagnostics = this.getPaymentDiagnostics()) {
    const modeLabels: Record<PaymentRuntimeMode | "mixed", string> = {
      auto: "自动",
      mock: "强制模拟",
      real: "严格真实",
      disabled: "已关闭",
      mixed: "混合"
    };
    const effectiveModeLabels: Record<PaymentEffectiveMode | "mixed", string> = {
      mock: "模拟支付",
      real: "真实支付",
      disabled: "不启用支付",
      mixed: "混合"
    };
    const lines = [
      `[支付自检] 请求模式=${modeLabels[diagnostics.requestedMode]}（来源 ${diagnostics.requestedModeSource}）；总体=${effectiveModeLabels[diagnostics.summary.effectiveMode]}；真实配置=${diagnostics.summary.allProvidersReadyForReal ? "完整" : "不完整"}；严格真实支付=${diagnostics.summary.strictRealEnabled ? "是" : "否"}；模拟完成接口=${diagnostics.summary.mockPaymentEndpointEnabled ? "可用" : "关闭"}`
    ];

    for (const provider of diagnostics.providers) {
      const missing = provider.missingRequiredKeys.length
        ? `；缺少 ${provider.missingRequiredKeys.join("、")}`
        : "";
      const reason = provider.simulatedReason ? `；原因：${provider.simulatedReason}` : "";
      const blockers = provider.blockers.length ? `；阻断：${provider.blockers.join("；")}` : "";
      lines.push(
        `[支付自检] ${provider.label}=${effectiveModeLabels[provider.effectiveMode]}；真实配置=${provider.readyForRealPayment ? "完整" : "不完整"}${missing}${reason}${blockers}`
      );
    }

    for (const warning of diagnostics.warnings) {
      lines.push(`[支付自检] 警告：${warning}`);
    }

    return lines;
  }

  async markMockPaid(id: string, actor?: Actor) {
    const order = this.findOrder(id);
    this.assertCanReadOrder(order, actor);

    if (isProductionRuntime() || this.isLiveDataPlane()) {
      throw new ForbiddenException(
        "生产环境禁止模拟支付；真实数据平面禁止通过模拟接口完成支付单。"
      );
    }

    if (!this.isSimulatedPaymentOrder(order)) {
      throw new BadRequestException("该支付单不属于模拟支付，不能通过模拟接口完成。");
    }

    return this.markPaid({
      provider: order.provider,
      paymentNo: order.paymentNo,
      providerTransactionId:
        order.providerTransactionId ?? `${order.provider}-mock-${Date.now().toString(36)}`,
      amount: order.amount,
      callbackPayload: {
        mock: true,
        actor
      }
    });
  }

  async handleWechatCallback(
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    rawBody?: string
  ) {
    this.assertFinancialWriter();
    const paid = this.parseWechatPaidPayload(body, headers, rawBody);
    await this.markPaid(paid);
  }

  async handleAlipayCallback(
    body: Record<string, unknown>,
    _headers: Record<string, string | undefined>
  ) {
    const paid = this.parseAlipayPaidPayload(body);
    await this.markPaid(paid);
  }

  async handleWechatRefundCallback(
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    rawBody?: string
  ) {
    const payload = this.parseWechatRefundPayload(body, headers, rawBody);
    const refund = this.store.paymentRefunds.find(
      (entry) => entry.provider === "wechat" && entry.refundNo === payload.refundNo
    );
    if (!refund) {
      throw new BadRequestException("未找到对应退款单。");
    }
    const order = this.findOrder(refund.paymentOrderId);

    await this.withBusinessPaymentLock(order, () =>
      this.withRefundLock(order.id, async () => {
        this.markRefundFromProvider(payload);
      })
    );
  }

  async refund(
    payload: {
      paymentOrderId: string;
      amount: number;
      reason?: string;
    },
    actor?: Actor,
    idempotencyKey?: string
  ) {
    this.assertRequestObject(payload, "退款请求体");
    this.assertOnlyRequestKeys(payload, paymentRefundKeys, "退款请求体");
    this.assertOptionalText(payload.reason, "退款原因", 200);
    this.assertRequiredRefundAmount(payload.amount);

    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const sourceRequestId = this.createClientRefundSourceRequestId(
      actor,
      idempotencyKey
    );
    const order = this.findOrder(payload.paymentOrderId);

    if (
      actor.role !== "admin" &&
      (actor.role !== "merchant" || order.merchantUserId !== actor.id)
    ) {
      throw new ForbiddenException("当前账号无权退款该支付单。");
    }

    return this.startRefund(
      order,
      {
        ...payload,
        sourceRequestId
      },
      {
        source: actor.role === "merchant" ? "merchant" : "backoffice",
        id: actor.id,
        role: actor.role
      }
    );
  }

  async refundByBusinessOrder(
    payload: {
      orderNo: string;
      transactionId: string;
      deviceCode: string;
      refundNo: string;
      amount: number;
      reason?: string;
    },
    actor?: Actor
  ) {
    this.assertRequestObject(payload, "业务订单退款请求体");
    this.assertOnlyRequestKeys(payload, businessRefundKeys, "业务订单退款请求体");
    this.assertRequiredText(payload.orderNo, "业务订单号", 128);
    this.assertRequiredText(payload.transactionId, "原支付交易号", 128);
    this.assertRequiredText(payload.deviceCode, "柜机编号", 128);
    this.assertRequiredText(payload.refundNo, "上游退款请求号", 128);
    this.assertOptionalText(payload.reason, "退款原因", 200);
    this.assertRequiredRefundAmount(payload.amount);
    const sourceRequestId = this.readString(payload.refundNo)!;
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const order = this.resolveRefundOrderByBusinessContext(payload);
    if (
      actor.role !== "admin" &&
      (actor.role !== "merchant" || order.merchantUserId !== actor.id)
    ) {
      throw new ForbiddenException("当前账号无权退款该支付单。");
    }

    return this.startRefund(
      order,
      {
        paymentOrderId: order.id,
        amount: payload.amount,
        reason: payload.reason ?? "后台整单退款",
        sourceRequestId
      },
      {
        source: actor.role === "merchant" ? "merchant" : "backoffice",
        id: actor.id,
        role: actor.role
      }
    );
  }

  async refundFromSmartVm(payload: {
    orderNo: string;
    transactionId: string;
    deviceCode: string;
    refundNo: string;
    amount: number;
  }) {
    this.assertRequestObject(payload, "柜机平台退款请求体");
    this.store.logCallback?.("refund-request", payload);
    this.assertRequiredText(payload.orderNo, "业务订单号", 128);
    this.assertRequiredText(payload.transactionId, "原支付交易号", 128);
    this.assertRequiredText(payload.deviceCode, "柜机编号", 128);
    this.assertRequiredText(payload.refundNo, "上游退款请求号", 128);
    this.assertRequiredRefundAmount(payload.amount);
    const order = this.resolveRefundOrderByBusinessContext(payload);

    return this.startRefund(
      order,
      {
        paymentOrderId: order.id,
        amount: payload.amount,
        reason: "柜机平台签名退款请求",
        sourceRequestId: payload.refundNo.trim()
      },
      { source: "smartvm" }
    );
  }

  private startRefund(
    order: PaymentOrderRecord,
    payload: {
      paymentOrderId: string;
      amount: number;
      reason?: string;
      sourceRequestId?: string;
    },
    actor: RefundActor
  ) {
    return this.withBusinessPaymentLock(order, () =>
      this.withRefundLock(order.id, () =>
        this.refundLocked(order.id, payload, actor)
      )
    );
  }

  private async refundLocked(
    paymentOrderId: string,
    payload: {
      paymentOrderId: string;
      amount: number;
      reason?: string;
      sourceRequestId?: string;
    },
    actor: RefundActor
  ) {
    const order = this.findOrder(paymentOrderId);
    this.assertRequiredRefundAmount(payload.amount);
    const normalizedReason = this.readString(payload.reason);
    this.assertProviderRefundReason(order.provider, normalizedReason);

    if ((isProductionRuntime() || this.isLiveDataPlane()) && this.isSimulatedPaymentOrder(order)) {
      throw new ForbiddenException(
        "生产环境禁止处理模拟支付单退款；真实数据平面同样禁止，请先隔离并清理测试数据。"
      );
    }

    const sourceReplay = this.findSourceRequestRefundReplay(
      order,
      payload.sourceRequestId,
      payload.amount,
      normalizedReason
    );
    if (sourceReplay) {
      if (
        sourceReplay.status === "pending" &&
        sourceReplay.providerOutcome === "success"
      ) {
        this.applyRefundSuccess(order, sourceReplay);
      }
      return sourceReplay;
    }

    if (order.status !== "paid") {
      throw new BadRequestException(
        order.status === "refunded" ? "该支付单已全额退款。" : "只有已支付的订单可以退款。"
      );
    }

    const replay = this.findPendingRefundReplay(order.id, {
      ...payload,
      reason: normalizedReason
    });

    if (replay) {
      if (replay.providerOutcome === "success") {
        this.applyRefundSuccess(order, replay);
      }
      return replay;
    }

    if (
      this.store.paymentRefunds.some(
        (entry) => entry.paymentOrderId === order.id && entry.status === "pending"
      )
    ) {
      throw new ConflictException(
        "该支付单已有退款结果待确认；确认前不能更改金额、原因或请求编号再次提交。"
      );
    }

    this.assertNoLegacyRefundConflict(order);
    this.assertNoOutstandingBusinessPaymentConflict(order);

    const totals = this.getRefundTotals(order.id);
    const availableAmount = order.amount - totals.success - totals.pending;

    if (availableAmount <= 0) {
      throw new BadRequestException("该支付单没有可继续退款的余额。");
    }

    const amount = payload.amount;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException("退款金额必须是正整数分值。");
    }

    if (amount > availableAmount) {
      throw new BadRequestException(`退款金额超过当前可退余额 ${availableAmount} 分。`);
    }

    const providerTransactionId = this.readString(order.providerTransactionId);
    if (!providerTransactionId) {
      throw new ConflictException("原支付交易号缺失，无法安全绑定退款，请先人工核对支付单。");
    }

    if (!this.isSimulatedPaymentOrder(order)) {
      const missingSettings = this.getMissingProviderOperationalSettings(order.provider);

      if (missingSettings.length) {
        throw new BadRequestException(
          `真实${providerLabels[order.provider]}退款缺少配置：${missingSettings.join("、")}。`
        );
      }
    }

    const now = new Date().toISOString();
    const refundNo = this.createRefundNo(order.provider);
    const refund: PaymentRefundRecord = {
      id: this.store.createId("payment-refund"),
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo,
      provider: order.provider,
      status: "pending",
      amount,
      reason: normalizedReason,
      requestSource: actor.source,
      businessOrderNo: order.adjustmentOrderNo ?? order.orderNo,
      sourceRequestId: payload.sourceRequestId,
      requestedByUserId: actor.source === "smartvm" ? undefined : actor.id,
      requestedByRole: actor.source === "smartvm" ? undefined : actor.role,
      providerOutcome: "unknown",
      businessApplyState: "pending",
      createdAt: now,
      updatedAt: now
    };
    const previousRefundNo = order.refundNo;
    const previousOrderUpdatedAt = order.updatedAt;

    this.store.paymentRefunds.unshift(refund);
    order.refundNo = refund.refundNo;
    order.updatedAt = now;

    try {
      this.store.persist();
    } catch (error) {
      this.store.paymentRefunds.splice(this.store.paymentRefunds.indexOf(refund), 1);
      order.refundNo = previousRefundNo;
      order.updatedAt = previousOrderUpdatedAt;
      throw error;
    }

    let providerRefund: ProviderRefundResult;

    try {
      providerRefund = this.isSimulatedPaymentOrder(order)
        ? {
            providerRefundId: `${order.provider}-refund-${refundNo}`,
            status: "success",
            callbackPayload: {
              mock: true,
              actor
            }
          }
        : await this.createProviderRefund(order, amount, refundNo, normalizedReason);
      this.assertFinancialWriter();
    } catch (error) {
      this.assertFinancialWriter();
      if (
        refund.status === "success" ||
        refund.refundedAt ||
        refund.providerOutcome === "success"
      ) {
        if (refund.status === "pending") {
          this.applyRefundSuccess(order, refund);
        }
        return refund;
      }

      refund.providerOutcome = "unknown";
      refund.failReason = `退款渠道结果待确认：${this.summarizeProviderError(error)}`;
      refund.updatedAt = new Date().toISOString();
      this.store.persist();
      throw error;
    }

    this.applyProviderRefundResponse(order, refund, providerRefund);

    this.store.logOperation({
      category: "inventory",
      type: "payment-refund",
      status: refund.status === "failed" ? "failed" : refund.status === "pending" ? "pending" : "success",
      actor: {
        type: actor.source === "smartvm" ? "system" : actor.role,
        ...(actor.source === "smartvm"
          ? { name: "柜机平台退款请求" }
          : {
              id: actor.id,
              name: this.store.users.find((entry) => entry.id === actor.id)?.name ?? actor.id,
              role: actor.role
            })
      },
      primarySubject: {
        type: "event",
        id: order.eventId ?? order.id,
        label: order.orderNo ?? order.paymentNo
      },
      relatedEventId: order.eventId,
      relatedOrderNo: order.orderNo,
      metadata: {
        paymentOrderId: order.id,
        paymentNo: order.paymentNo,
        refundNo: refund.refundNo,
        providerRefundId: refund.providerRefundId,
        amount,
        undoState: "not_undoable"
      }
    });

    return refund;
  }

  private findPendingRefundReplay(
    paymentOrderId: string,
    payload: {
      amount: number;
      reason?: string;
      sourceRequestId?: string;
    }
  ) {
    return this.store.paymentRefunds.find(
      (entry) =>
        entry.paymentOrderId === paymentOrderId &&
        entry.status === "pending" &&
        entry.amount === payload.amount &&
        (entry.reason ?? "") === (this.readString(payload.reason) ?? "") &&
        (entry.sourceRequestId ?? "") === (payload.sourceRequestId ?? "")
    );
  }

  private findSourceRequestRefundReplay(
    order: PaymentOrderRecord,
    sourceRequestId: string | undefined,
    amount: number,
    reason: string | undefined
  ) {
    if (!sourceRequestId) {
      return undefined;
    }

    const existing = this.store.paymentRefunds.find(
      (entry) => entry.sourceRequestId === sourceRequestId
    );
    if (!existing) {
      return undefined;
    }

    if (
      existing.paymentOrderId !== order.id ||
      existing.amount !== amount ||
      (existing.reason ?? "") !== (this.readString(reason) ?? "")
    ) {
      throw new ConflictException("退款幂等键已绑定其他订单、金额或原因，拒绝冲突重放。");
    }

    return existing;
  }

  private resolveRefundOrderByBusinessContext(payload: {
    orderNo: string;
    transactionId?: string;
    deviceCode?: string;
    refundNo?: string;
    amount?: number;
  }) {
    const orderNo = this.readString(payload.orderNo);
    if (!orderNo) {
      throw new BadRequestException("业务订单号不能为空。");
    }

    const sourceRequestId = this.readString(payload.refundNo);
    const replayRefund = sourceRequestId
      ? this.store.paymentRefunds.find((entry) => entry.sourceRequestId === sourceRequestId)
      : undefined;
    if (replayRefund) {
      const replayOrder = this.store.paymentOrders.find(
        (entry) => entry.id === replayRefund.paymentOrderId
      );
      if (!replayOrder || (replayOrder.adjustmentOrderNo ?? replayOrder.orderNo) !== orderNo) {
        throw new ConflictException("上游退款请求号已绑定其他业务订单，拒绝冲突重放。");
      }

      this.assertRefundOrderBusinessContext(replayOrder, payload);
      return replayOrder;
    }

    const activePaidOrders = this.store.paymentOrders.filter(
      (entry) =>
        (entry.adjustmentOrderNo ?? entry.orderNo) === orderNo &&
        entry.status === "paid"
    );
    const requestedTransactionId = this.readString(payload.transactionId);
    let candidates: PaymentOrderRecord[];

    if (requestedTransactionId) {
      const exactMatches = activePaidOrders.filter(
        (entry) => this.readString(entry.providerTransactionId) === requestedTransactionId
      );
      candidates =
        exactMatches.length > 0
          ? exactMatches
          : activePaidOrders.length === 1
            ? activePaidOrders
            : [];
    } else {
      const primaryOrders = activePaidOrders.filter(
        (entry) => !this.isDuplicatePaymentOrder(entry)
      );
      candidates = primaryOrders.length > 0 ? primaryOrders : activePaidOrders;
    }

    if (candidates.length !== 1) {
      throw new ConflictException(
        candidates.length
          ? "业务订单关联到多个有效支付单，必须先人工核对。"
          : "未找到业务订单对应的有效支付单，不能发起退款。"
      );
    }

    const order = candidates[0]!;
    this.assertRefundOrderBusinessContext(order, payload);
    return order;
  }

  async runAutomaticReconciliationCycle(options: {
    now?: Date;
    limit?: number;
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion;
  } = {}) {
    this.assertFinancialWriter();
    this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
    const now = options.now ?? new Date();
    const limit = Math.max(
      1,
      Math.min(
        options.limit ??
          this.readPositiveCountConfig("PAYMENT_RECONCILIATION_BATCH_SIZE", 20),
        100
      )
    );
    const allDueOrders = this.store.paymentOrders
      .filter(
        (order) =>
          this.isPaymentOrderReconciliationCandidate(order) &&
          this.isReconciliationDue(
            this.readOrderReconciliationState(order),
            order.updatedAt,
            now
          )
      )
      .sort((left, right) =>
        this.readReconciliationDueAt(
          this.readOrderReconciliationState(left),
          left.updatedAt
        ).localeCompare(
          this.readReconciliationDueAt(
            this.readOrderReconciliationState(right),
            right.updatedAt
          )
        )
      );
    const allDueRefunds = this.store.paymentRefunds
      .filter((refund) => {
        if (refund.status !== "pending") {
          return false;
        }

        const order = this.store.paymentOrders.find(
          (entry) => entry.id === refund.paymentOrderId
        );
        return Boolean(
          order &&
          !this.isSimulatedPaymentOrder(order) &&
          this.isReconciliationDue(
            this.readRefundReconciliationState(refund),
            refund.updatedAt,
            now
          )
        );
      })
      .sort((left, right) =>
        this.readReconciliationDueAt(
          this.readRefundReconciliationState(left),
          left.updatedAt
        ).localeCompare(
          this.readReconciliationDueAt(
            this.readRefundReconciliationState(right),
            right.updatedAt
          )
        )
      );
    // 同一批次至少为到期退款保留一半配额，避免支付积压长期饿死退款核对。
    // 单槽批次无法同时预留两类：此时选择最早到期项；完全同刻先处理退款，
    // 其退避时间随后前移，下一轮仍到期的支付项即可获得槽位。
    const singleSlotRefundWins =
      limit === 1 &&
      allDueOrders.length > 0 &&
      allDueRefunds.length > 0 &&
      this.readReconciliationDueAt(
        this.readRefundReconciliationState(allDueRefunds[0]!),
        allDueRefunds[0]!.updatedAt
      ) <=
        this.readReconciliationDueAt(
          this.readOrderReconciliationState(allDueOrders[0]!),
          allDueOrders[0]!.updatedAt
        );
    const reservedRefundSlots =
      allDueRefunds.length > 0
        ? limit === 1 && allDueOrders.length > 0 && !singleSlotRefundWins
          ? 0
          : Math.min(allDueRefunds.length, Math.max(1, Math.floor(limit / 2)))
        : 0;
    const dueRefunds = allDueRefunds.slice(0, reservedRefundSlots);
    const dueOrders = allDueOrders.slice(
      0,
      Math.max(0, limit - dueRefunds.length)
    );
    let remainingSlots = limit - dueOrders.length - dueRefunds.length;
    if (remainingSlots > 0) {
      dueRefunds.push(
        ...allDueRefunds.slice(
          dueRefunds.length,
          dueRefunds.length + remainingSlots
        )
      );
      remainingSlots = limit - dueOrders.length - dueRefunds.length;
    }
    if (remainingSlots > 0) {
      dueOrders.push(
        ...allDueOrders.slice(
          dueOrders.length,
          dueOrders.length + remainingSlots
        )
      );
    }
    const summary = {
      scanned: this.store.paymentOrders.length + this.store.paymentRefunds.length,
      attempted: 0,
      completed: 0,
      pending: 0,
      failed: 0
    };
    const systemActor = {
      id: "system-payment-reconciliation",
      role: "admin" as const
    };

    for (const order of dueOrders) {
      this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
      summary.attempted += 1;
      try {
        const reconciled = await this.reconcileOrder(
          order.id,
          systemActor,
          undefined,
          options.assertRuntimeSafety
        );
        this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
        if (
          reconciled.status === "paid" ||
          reconciled.status === "refunded" ||
          reconciled.status === "closed" ||
          reconciled.status === "failed"
        ) {
          this.writeOrderReconciliationState(order, {
            state: "completed",
            attemptCount:
              this.readOrderReconciliationState(order).attemptCount + 1,
            lastAttemptAt: now.toISOString(),
            lastCompletedAt: now.toISOString(),
            lastResult: reconciled.status
          });
          summary.completed += 1;
        } else {
          this.scheduleNextOrderReconciliation(order, now, "pending");
          summary.pending += 1;
        }
      } catch (error) {
        this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
        this.scheduleNextOrderReconciliation(
          order,
          now,
          "error",
          this.summarizeProviderError(error)
        );
        summary.failed += 1;
      }
      this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
      this.store.persist();
    }

    for (const refund of dueRefunds) {
      this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
      summary.attempted += 1;
      try {
        const reconciled = await this.reconcileRefund(
          refund.id,
          systemActor,
          undefined,
          options.assertRuntimeSafety
        );
        this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
        if (reconciled.status === "success" || reconciled.status === "failed") {
          this.writeRefundReconciliationState(refund, {
            state: "completed",
            attemptCount:
              this.readRefundReconciliationState(refund).attemptCount + 1,
            lastAttemptAt: now.toISOString(),
            lastCompletedAt: now.toISOString(),
            lastResult: reconciled.status
          });
          summary.completed += 1;
        } else {
          this.scheduleNextRefundReconciliation(refund, now, "pending");
          summary.pending += 1;
        }
      } catch (error) {
        this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
        this.scheduleNextRefundReconciliation(
          refund,
          now,
          "error",
          this.summarizeProviderError(error)
        );
        summary.failed += 1;
      }
      this.assertAutomaticReconciliationRuntimeSafety(options.assertRuntimeSafety);
      this.store.persist();
    }

    return summary;
  }

  private assertRefundOrderBusinessContext(
    order: PaymentOrderRecord,
    payload: {
      transactionId?: string;
      deviceCode?: string;
      amount?: number;
    }
  ) {
    const providerTransactionId = this.readString(order.providerTransactionId);
    if (!providerTransactionId) {
      throw new ConflictException("支付单缺少原支付交易号，不能发起退款。");
    }

    const requestedTransactionId = this.readString(payload.transactionId);
    if (requestedTransactionId && requestedTransactionId !== providerTransactionId) {
      throw new BadRequestException("原支付交易号与服务端支付单不一致。");
    }

    const requestedDeviceCode = this.readString(payload.deviceCode);
    if (requestedDeviceCode && requestedDeviceCode !== order.deviceCode) {
      throw new BadRequestException("退款业务订单与柜机不匹配。");
    }

    if (payload.amount !== undefined && payload.amount !== order.amount) {
      throw new BadRequestException(
        `兼容业务订单入口仅支持整单全额退款，本单应退 ${order.amount} 分。`
      );
    }
  }

  private assertNoOutstandingBusinessPaymentConflict(order: PaymentOrderRecord) {
    if (this.isDuplicatePaymentOrder(order)) {
      return;
    }

    const businessOrderNo = order.adjustmentOrderNo ?? order.orderNo;
    if (!businessOrderNo) {
      return;
    }

    const otherPaidOrder = this.store.paymentOrders.find(
      (entry) =>
        entry.id !== order.id &&
        (entry.adjustmentOrderNo ?? entry.orderNo) === businessOrderNo &&
        entry.status === "paid"
    );
    if (otherPaidOrder) {
      throw new ConflictException(
        "该业务订单仍有其他已支付款项待处理；请先完成重复扣款纠错，再退款承载业务的主交易。"
      );
    }
  }

  private assertNoLegacyRefundConflict(order: PaymentOrderRecord) {
    const businessOrderNo = order.adjustmentOrderNo ?? order.orderNo;
    if (!businessOrderNo) {
      throw new ConflictException("支付单缺少业务订单号，无法安全核对退款状态。");
    }

    const pendingLegacyIntent = this.store.logs?.some(
      (entry) =>
        entry.type === "manual-refund-intent" &&
        entry.relatedOrderNo === businessOrderNo &&
        entry.status === "pending"
    );
    if (pendingLegacyIntent) {
      throw new ConflictException(
        "该订单存在旧版退款结果待确认记录；迁移或人工核对完成前不能再次退款。"
      );
    }

    const legacyRefundMovement = this.store.inventory?.some(
      (entry) => entry.type === "refund" && entry.orderNo === businessOrderNo
    );
    const event = order.eventId
      ? this.store.events.find((entry) => entry.eventId === order.eventId)
      : undefined;
    const targetAlreadyRefunded = order.adjustmentOrderNo
      ? event?.adjustments?.some(
          (entry) => entry.orderNo === order.adjustmentOrderNo && Boolean(entry.refundedAt)
        )
      : Boolean(event?.refundedAt);

    if (legacyRefundMovement || targetAlreadyRefunded) {
      throw new ConflictException(
        "业务订单已存在退款副作用但支付退款账本不完整，请先人工核对，不能再次退款。"
      );
    }
  }

  private assertOptionalRefundAmount(amount: unknown) {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || Number(amount) <= 0)) {
      throw new BadRequestException("退款金额必须是正整数分值。");
    }
  }

  private assertRequiredRefundAmount(amount: unknown) {
    if (amount === undefined) {
      throw new BadRequestException("退款金额必须明确提供，且必须使用正整数分值。");
    }

    this.assertOptionalRefundAmount(amount);
  }

  private assertProviderPaymentSubject(
    provider: PaymentProvider,
    subject: string
  ) {
    this.assertProviderTextBytes(
      subject,
      provider === "wechat" ? "微信支付商品描述" : "支付宝订单标题",
      provider === "wechat" ? 127 : 256
    );
  }

  private assertProviderRefundReason(
    provider: PaymentProvider,
    reason: string | undefined
  ) {
    const normalized = this.readString(reason);
    if (!normalized) {
      return;
    }

    this.assertProviderTextBytes(
      normalized,
      provider === "wechat" ? "微信退款原因" : "支付宝退款原因",
      provider === "wechat" ? 80 : 200
    );
  }

  private assertProviderTextBytes(
    value: string,
    label: string,
    maxBytes: number
  ) {
    if (/[\u0000-\u001F\u007F]/.test(value)) {
      throw new BadRequestException(`${label}不能包含控制字符或换行。`);
    }

    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      throw new BadRequestException(`${label}最多允许 ${maxBytes} 个 UTF-8 字节。`);
    }
  }

  private createClientRefundSourceRequestId(
    actor: Exclude<Actor, undefined>,
    idempotencyKey: unknown
  ) {
    const normalizedKey = this.readString(idempotencyKey);

    if (
      !normalizedKey ||
      normalizedKey.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalizedKey)
    ) {
      throw new BadRequestException(
        "正式退款必须提供有效的 Idempotency-Key（1-128 位字母、数字、点、下划线、冒号或连字符）。"
      );
    }

    const digest = createHash("sha256")
      .update(`${actor.role}\0${actor.id}\0${normalizedKey}`, "utf8")
      .digest("hex");
    return `client-refund:${digest}`;
  }

  private async withRefundLock<T>(paymentOrderId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.refundLocks.get(paymentOrderId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.refundLocks.set(paymentOrderId, tail);

    await previous;

    try {
      return await action();
    } finally {
      release();

      if (this.refundLocks.get(paymentOrderId) === tail) {
        this.refundLocks.delete(paymentOrderId);
      }
    }
  }

  private async withBusinessPaymentLock<T>(
    order: PaymentOrderRecord,
    action: (lease: FinancialOperationLease) => Promise<T>
  ): Promise<T> {
    this.assertFinancialWriter();
    const { eventId, businessOrderNo } = this.resolveBusinessPaymentLockKey(order);
    return this.financialOperations.run(eventId, businessOrderNo, action);
  }

  private assertFinancialWriter() {
    this.financialSingleWriter?.assertHeld();
  }

  private assertAutomaticReconciliationRuntimeSafety(
    assertion: AutomaticReconciliationRuntimeSafetyAssertion | undefined
  ) {
    assertion?.();
  }

  private assertBusinessPaymentLease(
    order: PaymentOrderRecord,
    lease: FinancialOperationLease | undefined
  ): asserts lease is FinancialOperationLease {
    const { eventId, businessOrderNo } = this.resolveBusinessPaymentLockKey(order);
    this.financialOperations.assertActiveLease(lease, eventId, businessOrderNo);
  }

  private resolveBusinessPaymentLockKey(order: PaymentOrderRecord) {
    return {
      eventId: this.readString(order.eventId) ?? `payment:${order.id}`,
      businessOrderNo:
        this.readString(order.adjustmentOrderNo) ??
        this.readString(order.orderNo) ??
        order.id
    };
  }

  private getRefundTotals(paymentOrderId: string, excludedRefundId?: string) {
    return this.store.paymentRefunds
      .filter(
        (entry) =>
          entry.paymentOrderId === paymentOrderId && entry.id !== excludedRefundId
      )
      .reduce(
        (totals, entry) => {
          if (this.isRefundRecordedAsSuccessful(entry)) {
            totals.success += entry.amount;
          } else if (
            entry.status !== "failed" ||
            entry.providerOutcome !== "failed"
          ) {
            // 只有“本地失败 + 渠道明确失败”才能释放余额。未识别状态、
            // 缺失渠道结论或待确认结论均按在途退款占用额度；生产加载会拒绝
            // 这些矛盾快照，这里仍为运行中被篡改的内存状态保留防御层。
            totals.pending += entry.amount;
          }

          return totals;
        },
        { success: 0, pending: 0 }
      );
  }

  private isRefundRecordedAsSuccessful(refund: PaymentRefundRecord) {
    return (
      refund.status === "success" ||
      refund.providerOutcome === "success" ||
      refund.refundedAt !== undefined ||
      refund.businessApplyState === "completed"
    );
  }

  private applyProviderRefundResponse(
    order: PaymentOrderRecord,
    refund: PaymentRefundRecord,
    providerRefund: ProviderRefundResult
  ) {
    this.assertProviderRefundIdAvailable(refund, providerRefund.providerRefundId);

    if (refund.status !== "pending" || refund.refundedAt) {
      refund.providerRefundId = refund.providerRefundId ?? providerRefund.providerRefundId;
      return refund;
    }

    if (refund.providerOutcome === "success" && providerRefund.status !== "success") {
      this.applyRefundSuccess(order, refund);
      return refund;
    }

    refund.providerRefundId = providerRefund.providerRefundId ?? refund.providerRefundId;
    refund.callbackPayload = providerRefund.callbackPayload;
    refund.failReason = providerRefund.failReason;
    refund.updatedAt = new Date().toISOString();

    if (providerRefund.status === "success") {
      refund.providerOutcome = "success";
      refund.businessApplyState = "pending";
      this.store.persist();
      this.applyRefundSuccess(order, refund);
    } else {
      refund.providerOutcome = providerRefund.status;
      refund.status = providerRefund.status;
    }

    return refund;
  }

  private async createProviderPaymentOrder(
    order: PaymentOrderRecord,
    _payload: PaymentOrderCreatePayload,
    payerIdentity?: string
  ): Promise<ProviderOrderResult> {
    if (order.provider === "wechat") {
      return this.createWechatPrepayOrder(order, payerIdentity);
    }

    return this.createAlipayTradeOrder(order, payerIdentity);
  }

  private handlePaymentQueryError(
    order: PaymentOrderRecord,
    error: unknown
  ): PaymentOrderRecord {
    const providerCode = this.readProviderErrorCode(error);
    const notFoundCodes =
      order.provider === "wechat"
        ? new Set(["ORDER_NOT_EXIST"])
        : new Set(["ACQ.TRADE_NOT_EXIST", "TRADE_NOT_EXIST"]);
    if (!providerCode || !notFoundCodes.has(providerCode)) {
      throw error;
    }

    const now = new Date();
    const previousCount = order.metadata?.providerNotFoundCount;
    const count =
      (typeof previousCount === "number" &&
      Number.isSafeInteger(previousCount) &&
      previousCount >= 0
        ? previousCount
        : 0) + 1;
    const existingFirstAt = this.readString(
      order.metadata?.providerNotFoundFirstAt
    );
    const firstAt =
      existingFirstAt && Number.isFinite(Date.parse(existingFirstAt))
        ? existingFirstAt
        : now.toISOString();
    const graceSeconds = this.readPositiveIntegerConfig(
      "PAYMENT_NOT_FOUND_GRACE_SECONDS",
      300
    );
    const requiredConfirmations = this.readPositiveCountConfig(
      "PAYMENT_NOT_FOUND_CONFIRMATIONS",
      2
    );
    const graceElapsed =
      now.getTime() - Date.parse(firstAt) >= graceSeconds * 1_000;

    order.metadata = {
      ...(order.metadata ?? {}),
      providerNotFoundCode: providerCode,
      providerNotFoundCount: count,
      providerNotFoundFirstAt: firstAt,
      providerNotFoundLastAt: now.toISOString()
    };
    order.updatedAt = now.toISOString();

    if (count >= requiredConfirmations && graceElapsed) {
      order.status = "failed";
      order.failReason =
        "支付渠道已跨宽限期多次确认订单不存在；本支付意图已安全释放，可重新创建支付单。";
      order.metadata = {
        ...(order.metadata ?? {}),
        providerCreateOutcome: "not_found_confirmed"
      };
      this.store.persist();
      return order;
    }

    order.status = "pending";
    this.store.persist();
    throw error;
  }

  private readOrderReconciliationState(
    order: PaymentOrderRecord
  ): FinancialReconciliationState {
    const value = order.metadata?.reconciliation;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        state: "scheduled",
        attemptCount: 0
      } as const;
    }

    const record = value as Record<string, unknown>;
    return {
      state:
        record.state === "completed" || record.state === "manual_review"
          ? record.state
          : "scheduled",
      attemptCount:
        typeof record.attemptCount === "number" &&
        Number.isSafeInteger(record.attemptCount) &&
        record.attemptCount >= 0
          ? record.attemptCount
          : 0,
      nextAttemptAt: this.readString(record.nextAttemptAt),
      lastAttemptAt: this.readString(record.lastAttemptAt),
      lastCompletedAt: this.readString(record.lastCompletedAt),
      lastResult: this.readString(record.lastResult),
      lastError: this.readString(record.lastError),
      alertedAt: this.readString(record.alertedAt),
      requestedByUserAt: this.readString(record.requestedByUserAt)
    };
  }

  private readRefundReconciliationState(
    refund: PaymentRefundRecord
  ): FinancialReconciliationState {
    const state = refund.reconciliation;
    if (!state) {
      return {
        state: "scheduled",
        attemptCount: 0
      } as const;
    }

    return {
      state:
        state.state === "completed" || state.state === "manual_review"
          ? state.state
          : "scheduled",
      attemptCount:
        Number.isSafeInteger(state.attemptCount) && state.attemptCount >= 0
          ? state.attemptCount
          : 0,
      nextAttemptAt: this.readString(state.nextAttemptAt),
      lastAttemptAt: this.readString(state.lastAttemptAt),
      lastCompletedAt: this.readString(state.lastCompletedAt),
      lastResult: this.readString(state.lastResult),
      lastError: this.readString(state.lastError),
      alertedAt: this.readString(state.alertedAt),
      requestedByUserAt: this.readString(state.requestedByUserAt)
    };
  }

  private writeOrderReconciliationState(
    order: PaymentOrderRecord,
    state: FinancialReconciliationState
  ) {
    order.metadata = {
      ...(order.metadata ?? {}),
      reconciliation: Object.fromEntries(
        Object.entries(state).filter(([, value]) => value !== undefined)
      )
    };
    order.updatedAt = new Date().toISOString();
  }

  private writeRefundReconciliationState(
    refund: PaymentRefundRecord,
    state: FinancialReconciliationState
  ) {
    refund.reconciliation = Object.fromEntries(
      Object.entries(state).filter(([, value]) => value !== undefined)
    ) as unknown as FinancialReconciliationState;
    refund.updatedAt = new Date().toISOString();
  }

  private readReconciliationDueAt(
    state: ReturnType<PaymentsService["readOrderReconciliationState"]>,
    fallbackUpdatedAt: string
  ) {
    if (state.nextAttemptAt && Number.isFinite(Date.parse(state.nextAttemptAt))) {
      return state.nextAttemptAt;
    }

    const updatedAt = Number.isFinite(Date.parse(fallbackUpdatedAt))
      ? Date.parse(fallbackUpdatedAt)
      : Date.now();
    return new Date(
      updatedAt +
        this.readPositiveIntegerConfig(
          "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS",
          30_000
        )
    ).toISOString();
  }

  private isReconciliationDue(
    state: ReturnType<PaymentsService["readOrderReconciliationState"]>,
    fallbackUpdatedAt: string,
    now: Date
  ) {
    if (state.state === "completed" || state.state === "manual_review") {
      return false;
    }

    return Date.parse(
      this.readReconciliationDueAt(state, fallbackUpdatedAt)
    ) <= now.getTime();
  }

  private scheduleNextOrderReconciliation(
    order: PaymentOrderRecord,
    now: Date,
    result: "pending" | "error",
    errorMessage?: string
  ) {
    const current = this.readOrderReconciliationState(order);
    const attemptCount = current.attemptCount + 1;
    const initialDelayMs = this.readPositiveIntegerConfig(
      "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS",
      30_000
    );
    const maxDelayMs = this.readPositiveIntegerConfig(
      "PAYMENT_RECONCILIATION_MAX_DELAY_MS",
      30 * 60_000
    );
    const delayMs = Math.min(
      maxDelayMs,
      initialDelayMs * 2 ** Math.min(attemptCount, 16)
    );
    this.writeOrderReconciliationState(order, {
      ...current,
      state: "scheduled",
      attemptCount,
      lastAttemptAt: now.toISOString(),
      lastResult: result,
      ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString()
    });
    this.maybeEscalateOrderReconciliation(order, now);
  }

  private scheduleNextRefundReconciliation(
    refund: PaymentRefundRecord,
    now: Date,
    result: "pending" | "error",
    errorMessage?: string
  ) {
    const current = this.readRefundReconciliationState(refund);
    const attemptCount = current.attemptCount + 1;
    const initialDelayMs = this.readPositiveIntegerConfig(
      "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS",
      30_000
    );
    const maxDelayMs = this.readPositiveIntegerConfig(
      "PAYMENT_RECONCILIATION_MAX_DELAY_MS",
      30 * 60_000
    );
    const delayMs = Math.min(
      maxDelayMs,
      initialDelayMs * 2 ** Math.min(attemptCount, 16)
    );
    this.writeRefundReconciliationState(refund, {
      ...current,
      state: "scheduled",
      attemptCount,
      lastAttemptAt: now.toISOString(),
      lastResult: result,
      ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString()
    });
    this.maybeEscalateRefundReconciliation(refund, now);
  }

  private maybeEscalateOrderReconciliation(
    order: PaymentOrderRecord,
    now: Date
  ) {
    const state = this.readOrderReconciliationState(order);
    const alertAfterAttempts = this.readPositiveCountConfig(
      "PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS",
      5
    );
    if (state.attemptCount < alertAfterAttempts || state.alertedAt) {
      return;
    }

    this.alertsService.create({
      type: "callback",
      grade: "fault",
      title: "支付状态长期待确认",
      deviceCode: order.deviceCode,
      targetUserId: order.payerUserId,
      dueAt: now.toISOString(),
      relatedEventId: order.eventId,
      detail:
        `支付单 ${order.paymentNo} 已自动核对 ${state.attemptCount} 次仍无终态。` +
        "系统继续保留原支付意图并禁止重复支付，请人工核对渠道账单。"
    });
    this.writeOrderReconciliationState(order, {
      ...state,
      alertedAt: now.toISOString()
    });
  }

  private maybeEscalateRefundReconciliation(
    refund: PaymentRefundRecord,
    now: Date
  ) {
    const state = this.readRefundReconciliationState(refund);
    const alertAfterAttempts = this.readPositiveCountConfig(
      "PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS",
      5
    );
    if (state.attemptCount < alertAfterAttempts || state.alertedAt) {
      return;
    }

    const order = this.store.paymentOrders.find(
      (entry) => entry.id === refund.paymentOrderId
    );
    this.alertsService.create({
      type: "callback",
      grade: "fault",
      title: "退款状态长期待确认",
      deviceCode: order?.deviceCode,
      targetUserId: order?.payerUserId,
      dueAt: now.toISOString(),
      relatedEventId: order?.eventId,
      detail:
        `退款单 ${refund.refundNo} 已自动核对 ${state.attemptCount} 次仍无终态。` +
        "系统继续占用原退款余额并复用原退款号，请人工核对渠道账单。"
    });
    this.writeRefundReconciliationState(refund, {
      ...state,
      alertedAt: now.toISOString()
    });
  }

  private clearProviderNotFoundEvidence(order: PaymentOrderRecord) {
    if (!order.metadata?.providerNotFoundCount) {
      return;
    }

    const metadata = { ...order.metadata };
    delete metadata.providerNotFoundCode;
    delete metadata.providerNotFoundCount;
    delete metadata.providerNotFoundFirstAt;
    delete metadata.providerNotFoundLastAt;
    order.metadata = metadata;
  }

  private async handleRefundQueryError(
    order: PaymentOrderRecord,
    refund: PaymentRefundRecord,
    error: unknown
  ): Promise<PaymentRefundRecord> {
    const providerCode = this.readProviderErrorCode(error);
    const notFoundCodes =
      refund.provider === "wechat"
        ? new Set(["RESOURCE_NOT_EXISTS", "REFUND_NOT_EXIST"])
        : new Set([
            "TRADE_NOT_EXIST",
            "ACQ.TRADE_NOT_EXIST",
            "ALIPAY_REFUND_NOT_EXIST"
          ]);
    if (!providerCode || !notFoundCodes.has(providerCode)) {
      throw error;
    }

    const providerRefund = await this.createProviderRefund(
      order,
      refund.amount,
      refund.refundNo,
      refund.reason
    );
    this.assertFinancialWriter();
    const result = this.applyProviderRefundResponse(
      order,
      refund,
      providerRefund
    );
    this.store.persist();
    return result;
  }

  private async queryProviderPayment(
    order: PaymentOrderRecord
  ): Promise<ProviderPaymentQueryResult> {
    if (order.provider === "alipay") {
      return this.queryAlipayPayment(order);
    }

    const appId = this.requireConfig("WECHAT_PAY_APP_ID");
    const mchId = this.requireConfig("WECHAT_PAY_MCH_ID");
    const response = await this.callWechatApi(
      "GET",
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.paymentNo)}?mchid=${encodeURIComponent(mchId)}`
    );
    const amount =
      response.amount && typeof response.amount === "object"
        ? (response.amount as Record<string, unknown>)
        : undefined;
    if (this.readString(response.appid) !== appId) {
      throw new BadGatewayException("微信支付查询响应的应用标识不匹配，结果保持待确认。");
    }
    if (this.readString(response.mchid) !== mchId) {
      throw new BadGatewayException("微信支付查询响应的商户标识不匹配，结果保持待确认。");
    }
    if (this.readString(response.out_trade_no) !== order.paymentNo) {
      throw new BadGatewayException("微信支付查询响应的商户订单号不匹配，结果保持待确认。");
    }
    if (this.readAmount(amount?.total) !== order.amount) {
      throw new BadGatewayException("微信支付查询响应的订单金额不匹配，结果保持待确认。");
    }
    if (this.readString(amount?.currency) !== order.currency) {
      throw new BadGatewayException("微信支付查询响应的币种不匹配，结果保持待确认。");
    }

    const tradeState = this.readString(response.trade_state);
    const providerTransactionId = this.readString(response.transaction_id);
    const summary = {
      source: "active-query",
      appid: appId,
      mchid: mchId,
      out_trade_no: order.paymentNo,
      ...(providerTransactionId
        ? { transaction_id: providerTransactionId }
        : {}),
      trade_state: tradeState,
      amount: {
        total: order.amount,
        currency: order.currency
      }
    };
    if (tradeState === "NOTPAY") {
      return {
        state: "pending",
        closable: true,
        summary
      };
    }
    if (tradeState === "CLOSED" || tradeState === "REVOKED") {
      return {
        state: "closed",
        closable: false,
        summary
      };
    }
    if (tradeState === "PAYERROR") {
      return {
        state: "failed",
        closable: false,
        summary,
        failReason: "微信支付查询确认支付失败。"
      };
    }
    if (tradeState !== "SUCCESS" || !providerTransactionId) {
      throw new BadGatewayException("微信支付查询尚未返回已支付终态。");
    }

    return {
      state: "paid",
      providerTransactionId,
      closable: false,
      summary
    };
  }

  private applyProviderPaymentTerminal(
    order: PaymentOrderRecord,
    queried: ProviderPaymentQueryResult
  ) {
    if (queried.state !== "closed" && queried.state !== "failed") {
      throw new BadGatewayException("支付渠道尚未返回可应用的关闭或失败终态。");
    }

    const now = new Date().toISOString();
    order.status = queried.state;
    order.callbackPayload = queried.summary;
    order.failReason = queried.failReason;
    order.closedAt = queried.state === "closed" ? now : undefined;
    order.updatedAt = now;
    this.store.persist();
    return order;
  }

  private async queryAlipayPayment(
    order: PaymentOrderRecord
  ): Promise<ProviderPaymentQueryResult> {
    const sellerId = this.requireConfig("ALIPAY_SELLER_ID");
    const response = await this.callAlipayGateway("alipay.trade.query", {
      biz_content: JSON.stringify({
        out_trade_no: order.paymentNo
      })
    });
    const paymentNo = this.readString(response.out_trade_no);
    const tradeNo = this.readString(response.trade_no);
    const responseSellerId = this.readString(response.seller_id);
    const status = this.readString(response.trade_status);
    const amount = this.readYuanAmount(response.total_amount);
    const currency =
      this.readString(response.currency) ??
      this.readString(response.trans_currency);

    if (paymentNo !== order.paymentNo) {
      throw new BadGatewayException("支付宝支付查询响应的商户订单号不匹配，结果保持待确认。");
    }
    if (!tradeNo) {
      throw new BadGatewayException("支付宝支付查询响应缺少交易号，结果保持待确认。");
    }
    const expectedTradeNo =
      this.readString(order.providerTransactionId) ??
      this.readString(order.providerOrderId);
    if (expectedTradeNo && tradeNo !== expectedTradeNo) {
      throw new BadGatewayException("支付宝支付查询响应的交易号不匹配，结果保持待确认。");
    }
    if (responseSellerId && responseSellerId !== sellerId) {
      throw new BadGatewayException("支付宝支付查询响应的收款账号不匹配，结果保持待确认。");
    }
    if (amount !== order.amount) {
      throw new BadGatewayException("支付宝支付查询响应的订单金额不匹配，结果保持待确认。");
    }
    if (currency && currency !== order.currency) {
      throw new BadGatewayException("支付宝支付查询响应的币种不匹配，结果保持待确认。");
    }

    const summary = {
      source: "active-query",
      seller_id: responseSellerId ?? sellerId,
      out_trade_no: paymentNo,
      trade_no: tradeNo,
      trade_status: status,
      total_amount: this.formatYuan(order.amount),
      currency: order.currency
    };
    if (status === "WAIT_BUYER_PAY") {
      return {
        state: "pending",
        closable: true,
        summary
      };
    }
    if (status === "TRADE_CLOSED") {
      return {
        state: "closed",
        closable: false,
        summary
      };
    }
    if (status !== "TRADE_SUCCESS" && status !== "TRADE_FINISHED") {
      throw new BadGatewayException("支付宝支付查询尚未返回已支付终态。");
    }

    return {
      state: "paid",
      providerTransactionId: tradeNo,
      closable: false,
      summary
    };
  }

  private async reconcileAlipayRefund(
    order: PaymentOrderRecord,
    refund: PaymentRefundRecord,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ) {
    const sellerId = this.requireConfig("ALIPAY_SELLER_ID");
    const response = await this.callAlipayGateway(
      "alipay.trade.fastpay.refund.query",
      {
        biz_content: JSON.stringify({
          out_trade_no: order.paymentNo,
          out_request_no: refund.refundNo
        })
      }
    );
    this.assertFinancialWriter();
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    const tradeNo = this.readString(response.trade_no);
    const paymentNo = this.readString(response.out_trade_no);
    const requestNo = this.readString(response.out_request_no);
    const responseSellerId = this.readString(response.seller_id);
    const totalAmount = this.readYuanAmount(response.total_amount);
    const refundAmount = this.readYuanAmount(response.refund_amount);
    const currency =
      this.readString(response.currency) ??
      this.readString(response.trans_currency);
    const hasAnyRefundData = [
      "trade_no",
      "out_trade_no",
      "out_request_no",
      "total_amount",
      "refund_amount",
      "refund_detail_item_list",
      "gmt_refund_pay"
    ].some(
      (key) => response[key] !== undefined && response[key] !== null
    );

    if (
      this.readString(response.code) === "10000" &&
      !hasAnyRefundData
    ) {
      throw new BadGatewayException({
        message:
          "支付宝退款查询成功但未返回退款数据；将仅以原退款请求号安全重投。",
        providerCode: "ALIPAY_REFUND_NOT_EXIST"
      });
    }

    if (!tradeNo || tradeNo !== this.readString(order.providerTransactionId)) {
      throw new BadGatewayException("支付宝退款查询响应的原支付交易号不匹配，结果保持待确认。");
    }
    if (paymentNo !== order.paymentNo) {
      throw new BadGatewayException("支付宝退款查询响应的商户订单号不匹配，结果保持待确认。");
    }
    if (requestNo !== refund.refundNo) {
      throw new BadGatewayException("支付宝退款查询响应的退款请求号不匹配，结果保持待确认。");
    }
    if (responseSellerId && responseSellerId !== sellerId) {
      throw new BadGatewayException("支付宝退款查询响应的收款账号不匹配，结果保持待确认。");
    }
    if (totalAmount !== order.amount) {
      throw new BadGatewayException("支付宝退款查询响应的订单总额不匹配，结果保持待确认。");
    }
    if (refundAmount !== refund.amount) {
      throw new BadGatewayException("支付宝退款查询响应的退款金额不匹配，结果保持待确认。");
    }
    if (currency && currency !== order.currency) {
      throw new BadGatewayException("支付宝退款查询响应的币种不匹配，结果保持待确认。");
    }

    const providerRefundId =
      this.readString(refund.providerRefundId) ?? refund.refundNo;
    const result = this.markRefundFromProvider(
      {
        provider: "alipay",
        paymentNo: order.paymentNo,
        refundNo: refund.refundNo,
        providerRefundId,
        providerTransactionId: tradeNo,
        status: "success",
        amount: refund.amount,
        totalAmount: order.amount,
        callbackPayload: {
          source: "active-query",
          seller_id: responseSellerId ?? sellerId,
          trade_no: tradeNo,
          out_trade_no: paymentNo,
          out_request_no: requestNo,
          total_amount: this.formatYuan(order.amount),
          refund_amount: this.formatYuan(refund.amount),
          currency: order.currency
        }
      },
      assertRuntimeSafety
    );
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    this.store.persist();
    return result;
  }

  private async createWechatPrepayOrder(
    order: PaymentOrderRecord,
    payerIdentity?: string
  ): Promise<ProviderOrderResult> {
    const payerOpenId = this.readString(payerIdentity);

    if (!payerOpenId) {
      throw new BadRequestException("真实微信支付需要先获取付款用户 openid。");
    }

    const appId = this.requireConfig("WECHAT_PAY_APP_ID");
    const mchId = this.requireConfig("WECHAT_PAY_MCH_ID");
    const notifyUrl = this.resolveNotifyUrl("WECHAT_PAY_NOTIFY_URL", "/api/payments/callbacks/wechat");
    const response = await this.callWechatApi<{ prepay_id?: string }>(
      "POST",
      "/v3/pay/transactions/jsapi",
      {
        appid: appId,
        mchid: mchId,
        description: order.subject.slice(0, 127),
        out_trade_no: order.paymentNo,
        notify_url: notifyUrl,
        amount: {
          total: order.amount,
          currency: "CNY"
        },
        payer: {
          openid: payerOpenId
        }
      }
    );
    const prepayId = this.readString(response.prepay_id);

    if (!prepayId) {
      throw new BadRequestException("微信支付下单成功但未返回 prepay_id。");
    }

    return {
      providerOrderId: prepayId,
      invokePayload: this.buildWechatInvokePayload(appId, prepayId),
      providerResponse: {
        prepay_id: prepayId
      }
    };
  }

  private async createAlipayTradeOrder(
    order: PaymentOrderRecord,
    payerIdentity?: string
  ): Promise<ProviderOrderResult> {
    const payerAlipayUserId = this.readString(payerIdentity);

    if (!payerAlipayUserId) {
      throw new BadRequestException("真实支付宝支付需要先获取付款用户支付宝 user_id。");
    }

    const bizContent: Record<string, unknown> = {
      out_trade_no: order.paymentNo,
      total_amount: this.formatYuan(order.amount),
      subject: order.subject.slice(0, 256),
      buyer_id: payerAlipayUserId,
      product_code: "JSAPI_PAY"
    };
    bizContent.seller_id = this.requireConfig("ALIPAY_SELLER_ID");

    const response = await this.callAlipayGateway("alipay.trade.create", {
      notify_url: this.resolveNotifyUrl("ALIPAY_NOTIFY_URL", "/api/payments/callbacks/alipay"),
      biz_content: JSON.stringify(bizContent)
    });
    const tradeNo = this.readString(response.trade_no);

    if (!tradeNo) {
      throw new BadRequestException("支付宝创建交易成功但未返回 trade_no。");
    }
    if (this.readString(response.out_trade_no) !== order.paymentNo) {
      throw new BadGatewayException(
        "支付宝创建交易响应的商户订单号与本地支付单不匹配，结果保持待确认。"
      );
    }

    return {
      providerOrderId: tradeNo,
      invokePayload: {
        provider: "alipay",
        tradeNO: tradeNo,
        orderStr: tradeNo,
        simulated: false
      },
      providerResponse: {
        code: this.readString(response.code),
        trade_no: tradeNo,
        out_trade_no: order.paymentNo
      }
    };
  }

  private async createProviderRefund(
    order: PaymentOrderRecord,
    amount: number,
    refundNo: string,
    reason?: string
  ): Promise<ProviderRefundResult> {
    if (order.provider === "wechat") {
      return this.createWechatRefund(order, amount, refundNo, reason);
    }

    return this.createAlipayRefund(order, amount, refundNo, reason);
  }

  private async createWechatRefund(
    order: PaymentOrderRecord,
    amount: number,
    refundNo: string,
    reason?: string
  ): Promise<ProviderRefundResult> {
    const body: Record<string, unknown> = {
      out_trade_no: order.paymentNo,
      out_refund_no: refundNo,
      amount: {
        refund: amount,
        total: order.amount,
        currency: "CNY"
      }
    };

    if (reason) {
      body.reason = reason;
    }

    const notifyUrl = this.resolveNotifyUrl(
      "WECHAT_PAY_REFUND_NOTIFY_URL",
      "/api/payments/callbacks/wechat-refund"
    );
    body.notify_url = notifyUrl;

    const response = await this.callWechatApi<{
      refund_id?: string;
      status?: string;
      out_refund_no?: string;
      transaction_id?: string;
      out_trade_no?: string;
      amount?: {
        refund?: number;
        total?: number;
        currency?: string;
      };
    }>("POST", "/v3/refund/domestic/refunds", body);
    this.assertWechatRefundResponseBinding(
      order,
      amount,
      refundNo,
      response as Record<string, unknown>
    );
    const wechatStatus = this.readString(response.status);

    return {
      providerRefundId: this.readString(response.refund_id),
      // 微信退款申请响应只表示渠道已受理；终态必须来自可信退款通知或主动查询。
      status: "pending",
      callbackPayload: {
        refund_id: this.readString(response.refund_id),
        out_refund_no: this.readString(response.out_refund_no),
        transaction_id: this.readString(response.transaction_id),
        out_trade_no: this.readString(response.out_trade_no),
        status: wechatStatus
      },
      failReason: `微信退款申请已受理（同步状态 ${wechatStatus}），最终结果须等待可信回调或主动查询确认。`
    };
  }

  private assertWechatRefundResponseBinding(
    order: PaymentOrderRecord,
    amount: number,
    refundNo: string,
    response: Record<string, unknown>
  ) {
    if (!this.readString(response.refund_id)) {
      throw new BadGatewayException("微信退款响应缺少供应商退款号，结果保持待确认。");
    }
    if (this.readString(response.out_refund_no) !== refundNo) {
      throw new BadGatewayException("微信退款响应的商户退款单号不匹配，结果保持待确认。");
    }
    if (this.readString(response.out_trade_no) !== order.paymentNo) {
      throw new BadGatewayException("微信退款响应的商户订单号不匹配，结果保持待确认。");
    }
    if (
      this.readString(response.transaction_id) !==
      this.readString(order.providerTransactionId)
    ) {
      throw new BadGatewayException("微信退款响应的原支付交易号不匹配，结果保持待确认。");
    }

    const responseAmount =
      response.amount && typeof response.amount === "object"
        ? (response.amount as Record<string, unknown>)
        : undefined;
    if (this.readAmount(responseAmount?.refund) !== amount) {
      throw new BadGatewayException("微信退款响应的退款金额不匹配，结果保持待确认。");
    }
    if (this.readAmount(responseAmount?.total) !== order.amount) {
      throw new BadGatewayException("微信退款响应的订单总额不匹配，结果保持待确认。");
    }
    if (this.readString(responseAmount?.currency) !== "CNY") {
      throw new BadGatewayException("微信退款响应的币种必须为 CNY，结果保持待确认。");
    }

    const status = this.readString(response.status);
    if (!status || !["SUCCESS", "PROCESSING", "ABNORMAL", "CLOSED"].includes(status)) {
      throw new BadGatewayException("微信退款响应的退款状态无效，结果保持待确认。");
    }
  }

  private async createAlipayRefund(
    order: PaymentOrderRecord,
    amount: number,
    refundNo: string,
    reason?: string
  ): Promise<ProviderRefundResult> {
    const response = await this.callAlipayGateway("alipay.trade.refund", {
      biz_content: JSON.stringify({
        out_trade_no: order.paymentNo,
        refund_amount: this.formatYuan(amount),
        refund_reason: reason,
        out_request_no: refundNo
      })
    });
    const providerTransactionId = this.readString(response.trade_no);
    if (!providerTransactionId) {
      throw new BadGatewayException("支付宝退款响应缺少原支付交易号，结果保持待确认。");
    }
    if (providerTransactionId !== this.readString(order.providerTransactionId)) {
      throw new BadGatewayException("支付宝退款响应的原支付交易号不匹配，结果保持待确认。");
    }

    const responsePaymentNo = this.readString(response.out_trade_no);
    if (!responsePaymentNo || responsePaymentNo !== order.paymentNo) {
      throw new BadGatewayException("支付宝退款响应的商户订单号不匹配，结果保持待确认。");
    }

    const responseRequestNo = this.readString(response.out_request_no);
    if (responseRequestNo && responseRequestNo !== refundNo) {
      throw new BadGatewayException("支付宝退款响应的可选退款请求号不匹配，结果保持待确认。");
    }

    const successfulBefore = this.getRefundTotals(order.id).success;
    const expectedCumulativeRefund = successfulBefore + amount;
    const responseRefundFee = this.readYuanAmount(response.refund_fee);
    if (responseRefundFee !== expectedCumulativeRefund) {
      throw new BadGatewayException("支付宝退款响应的累计退款金额不匹配，结果保持待确认。");
    }

    const fundChange = this.readString(response.fund_change);
    if (fundChange !== "Y" && fundChange !== "N") {
      throw new BadGatewayException("支付宝退款响应的资金变化状态未确认，结果保持待确认。");
    }

    return {
      providerRefundId: refundNo,
      status: "success",
      callbackPayload: {
        code: this.readString(response.code),
        trade_no: providerTransactionId,
        out_trade_no: this.readString(response.out_trade_no),
        out_request_no: this.readString(response.out_request_no),
        refund_fee: this.readString(response.refund_fee),
        fund_change: fundChange
      }
    };
  }

  private async resolveWechatPayerIdentity(
    authCode: string | undefined,
    actor: Exclude<Actor, undefined>
  ): Promise<PaymentPayerIdentityResult> {
    const providerMode = this.resolveProviderConfigMode("wechat");

    if (providerMode.simulated) {
      return {
        provider: "wechat",
        simulated: true,
        simulatedReason: providerMode.simulatedReason
      };
    }

    const appId = this.requireConfig("WECHAT_PAY_APP_ID");
    const appSecret = this.getConfigValue("WECHAT_MINI_APP_SECRET");

    if (!appSecret) {
      if (providerMode.forcedReal) {
        throw new BadRequestException("真实微信支付需要配置 WECHAT_MINI_APP_SECRET 用于换取 openid。");
      }

      return {
        provider: "wechat",
        simulated: true,
        simulatedReason: "自动模拟回落模式：未配置 WECHAT_MINI_APP_SECRET，无法换取微信 openid，本次不会调用微信真实扣款。"
      };
    }

    if (!authCode) {
      if (providerMode.forcedReal) {
        throw new BadRequestException("真实微信支付需要前端传入微信登录 code。");
      }

      return {
        provider: "wechat",
        simulated: true,
        simulatedReason: "自动模拟回落模式：未获取到微信登录 code，无法换取微信 openid，本次不会调用微信真实扣款。"
      };
    }

    const loginUrl = new URL(
      this.getConfigValue("WECHAT_MINI_LOGIN_URL") ?? "https://api.weixin.qq.com/sns/jscode2session"
    );
    loginUrl.searchParams.set("appid", appId);
    loginUrl.searchParams.set("secret", appSecret);
    loginUrl.searchParams.set("js_code", authCode);
    loginUrl.searchParams.set("grant_type", "authorization_code");

    const response = await this.callJsonEndpoint(loginUrl.toString(), "微信登录凭证校验");
    const errcode = Number(response.errcode ?? 0);

    if (errcode) {
      throw new BadRequestException(
        `微信登录凭证校验失败：${this.readString(response.errmsg) ?? errcode.toString()}`
      );
    }

    const openId = this.readString(response.openid);

    if (!openId) {
      throw new BadRequestException("微信登录凭证校验成功但未返回 openid。");
    }

    const issued = this.payerIdentityHandles.issue("wechat", actor, openId);
    return {
      provider: "wechat",
      simulated: false,
      payerIdentityHandle: issued.handle,
      payerIdentityHandleExpiresAt: issued.expiresAt
    };
  }

  private async resolveAlipayPayerIdentity(
    authCode: string | undefined,
    actor: Exclude<Actor, undefined>
  ): Promise<PaymentPayerIdentityResult> {
    const providerMode = this.resolveProviderConfigMode("alipay");

    if (providerMode.simulated) {
      return {
        provider: "alipay",
        simulated: true,
        simulatedReason: providerMode.simulatedReason
      };
    }

    if (!authCode) {
      if (providerMode.forcedReal) {
        throw new BadRequestException("真实支付宝支付需要前端传入支付宝授权码。");
      }

      return {
        provider: "alipay",
        simulated: true,
        simulatedReason: "自动模拟回落模式：未获取到支付宝授权码，无法换取支付宝 user_id，本次不会调用支付宝真实扣款。"
      };
    }

    const response = await this.callAlipayGateway("alipay.system.oauth.token", {
      grant_type: "authorization_code",
      code: authCode
    });
    const userId = this.readString(response.user_id);

    if (!userId) {
      throw new BadRequestException("支付宝授权成功但未返回 user_id。");
    }

    const issued = this.payerIdentityHandles.issue("alipay", actor, userId);
    return {
      provider: "alipay",
      simulated: false,
      payerIdentityHandle: issued.handle,
      payerIdentityHandleExpiresAt: issued.expiresAt
    };
  }

  private async markPaid(
    payload: ProviderPaidPayload,
    financialOperationLease?: FinancialOperationLease,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ): Promise<PaymentOrderRecord> {
    const order = this.store.paymentOrders.find(
      (entry) => entry.provider === payload.provider && entry.paymentNo === payload.paymentNo
    );

    if (!order) {
      throw new BadRequestException("未找到对应支付单。");
    }

    if (!financialOperationLease) {
      return this.withBusinessPaymentLock(order, (lease) =>
        this.markPaid(payload, lease, assertRuntimeSafety)
      );
    }
    this.assertBusinessPaymentLease(order, financialOperationLease);
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);

    if (payload.amount !== undefined && payload.amount !== order.amount) {
      throw new BadRequestException("支付回调金额与本地支付单不一致。");
    }
    const providerTransactionId = this.readString(payload.providerTransactionId);
    if (!providerTransactionId) {
      throw new BadRequestException("支付回调缺少供应商交易号。");
    }

    if (
      order.provider === "alipay" &&
      !this.isSimulatedPaymentOrder(order) &&
      this.readString(order.providerOrderId) &&
      providerTransactionId !== this.readString(order.providerOrderId)
    ) {
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      const now = new Date().toISOString();
      order.metadata = {
        ...(order.metadata ?? {}),
        reconciliationState: "provider_transaction_mismatch",
        callbackTransactionId: providerTransactionId
      };
      order.failReason = "支付宝回调交易号与创建交易时绑定的渠道交易号不一致，需人工核对。";
      order.updatedAt = now;
      this.store.persist();
      this.alertsService.create({
        type: "callback",
        grade: "fault",
        title: "支付宝交易号绑定异常",
        deviceCode: order.deviceCode,
        targetUserId: order.payerUserId,
        dueAt: now,
        detail: `支付单 ${order.paymentNo} 的支付宝回调交易号与创建交易返回值不一致，系统已阻止入账，请核对渠道账单。`,
        relatedEventId: order.eventId
      });
      throw new ConflictException("支付宝回调交易号与创建交易返回的渠道交易号不一致，已转入人工核对。");
    }

    if (providerTransactionId) {
      const transactionConflict = this.store.paymentOrders.find(
        (entry) =>
          entry.id !== order.id &&
          entry.provider === payload.provider &&
          entry.providerTransactionId === providerTransactionId
      );

      if (transactionConflict) {
        throw new BadRequestException("支付回调交易号已绑定到其他支付单。");
      }
    }

    if (order.status === "paid" || order.status === "refunded") {
      if (
        order.providerTransactionId &&
        providerTransactionId !== order.providerTransactionId
      ) {
        throw new BadRequestException("支付单已由其他交易号完成，拒绝覆盖。");
      }

      if (order.status === "paid" && order.metadata?.smartVmForwardState !== "completed") {
        const forwarded = await this.forwardPaymentSuccessToSmartVm(
          order,
          financialOperationLease,
          assertRuntimeSafety
        );
        if (!forwarded) {
          throw new BadGatewayException(
            "支付已安全入账，但柜机平台回写尚未完成；已要求支付渠道稍后重试。"
          );
        }
      }

      return order;
    }

    const isLatePaymentAfterNotFoundRelease =
      order.status === "failed" &&
      order.metadata?.providerCreateOutcome === "not_found_confirmed";
    if (
      order.status !== "created" &&
      order.status !== "pending" &&
      !isLatePaymentAfterNotFoundRelease
    ) {
      throw new BadRequestException(`支付单当前状态为 ${order.status}，不能再标记为已支付。`);
    }

    if (isLatePaymentAfterNotFoundRelease) {
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      order.metadata = {
        ...(order.metadata ?? {}),
        latePaymentAfterNotFoundReleaseAt: new Date().toISOString()
      };
      order.failReason = undefined;
    }

    const existingBusinessTransactionId =
      this.resolveBusinessPaymentTransactionId(order) ??
      this.resolveOtherPaidBusinessTransactionId(order);
    if (
      existingBusinessTransactionId &&
      existingBusinessTransactionId !== providerTransactionId
    ) {
      return this.recordDuplicatePaymentConflict(
        order,
        payload,
        providerTransactionId,
        existingBusinessTransactionId,
        assertRuntimeSafety
      );
    }

    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    const now = new Date().toISOString();
    order.status = "paid";
    order.providerTransactionId = providerTransactionId;
    order.callbackPayload = payload.callbackPayload;
    order.paidAt = now;
    order.updatedAt = now;
    order.failReason = undefined;

    this.store.logOperation({
      category: "inventory",
      type: "payment-paid",
      status: "success",
      actor: {
        type: "system",
        name: "支付回调"
      },
      primarySubject: {
        type: "event",
        id: order.eventId ?? order.id,
        label: order.orderNo ?? order.paymentNo
      },
      relatedEventId: order.eventId,
      relatedOrderNo: order.orderNo,
      metadata: {
        paymentOrderId: order.id,
        paymentNo: order.paymentNo,
        provider: order.provider,
        transactionId: order.providerTransactionId,
        amount: order.amount,
        undoState: "not_undoable"
      }
    });
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    this.store.persist();

    const forwarded = await this.forwardPaymentSuccessToSmartVm(
      order,
      financialOperationLease,
      assertRuntimeSafety
    );
    if (!forwarded) {
      throw new BadGatewayException(
        "支付已安全入账，但柜机平台回写尚未完成；已要求支付渠道稍后重试。"
      );
    }

    return order;
  }

  private markRefundFromProvider(
    payload: WechatRefundCallbackPayload,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ) {
    const provider = payload.provider ?? "wechat";
    const refund = this.store.paymentRefunds.find(
      (entry) => entry.provider === provider && entry.refundNo === payload.refundNo
    );

    if (!refund) {
      throw new BadRequestException("未找到对应退款单。");
    }

    if (payload.amount !== undefined && payload.amount !== refund.amount) {
      throw new BadRequestException("退款回调金额与本地退款单不一致。");
    }

    if (payload.paymentNo !== refund.paymentNo) {
      throw new BadRequestException("退款回调支付单号与本地退款单不一致。");
    }

    const order = this.findOrder(refund.paymentOrderId);
    if (
      payload.providerTransactionId !==
      this.readString(order.providerTransactionId)
    ) {
      throw new BadRequestException("微信退款回调原支付交易号不匹配。");
    }
    if (payload.totalAmount !== order.amount) {
      throw new BadRequestException("微信退款回调订单总额不匹配。");
    }

    this.assertProviderRefundIdAvailable(refund, payload.providerRefundId);
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);

    if (refund.status === "success" && payload.status === "success") {
      refund.providerRefundId = payload.providerRefundId ?? refund.providerRefundId;
      refund.callbackPayload = payload.callbackPayload;
      refund.failReason = payload.failReason ?? refund.failReason;
      refund.updatedAt = new Date().toISOString();
      return refund;
    }

    if (refund.status !== "pending") {
      throw new BadRequestException(`退款单当前状态为 ${refund.status}，拒绝状态回退或改写。`);
    }

    if (refund.providerOutcome === "success" && payload.status !== "success") {
      this.applyRefundSuccess(order, refund, assertRuntimeSafety);
      return refund;
    }

    if (payload.status === "success") {
      this.assertRefundSuccessWithinOrder(order, refund);
    }

    const now = new Date().toISOString();
    refund.providerRefundId = payload.providerRefundId ?? refund.providerRefundId;
    refund.callbackPayload = payload.callbackPayload;
    refund.failReason = payload.failReason;
    refund.updatedAt = now;

    if (payload.status === "success") {
      refund.providerOutcome = "success";
      refund.businessApplyState = "pending";
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      this.store.persist();
      this.applyRefundSuccess(order, refund, assertRuntimeSafety);
    } else {
      refund.providerOutcome = payload.status;
      refund.status = payload.status;
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      this.store.persist();
    }

    return refund;
  }

  private assertProviderRefundIdAvailable(
    refund: PaymentRefundRecord,
    providerRefundId?: string
  ) {
    if (
      providerRefundId &&
      refund.providerRefundId &&
      providerRefundId !== refund.providerRefundId
    ) {
      throw new BadRequestException("退款单已绑定其他供应商退款号，拒绝覆盖。");
    }

    const providerRefundConflict = providerRefundId
      ? this.store.paymentRefunds.find(
          (entry) =>
            entry.id !== refund.id &&
            entry.provider === refund.provider &&
            entry.providerRefundId === providerRefundId
        )
      : undefined;

    if (providerRefundConflict) {
      throw new BadRequestException("供应商退款号已绑定到其他退款单。");
    }
  }

  private applyRefundSuccess(
    order: PaymentOrderRecord,
    refund: PaymentRefundRecord,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ) {
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    const alreadyApplied = Boolean(refund.refundedAt);

    if (alreadyApplied) {
      refund.status = "success";
      refund.providerOutcome = "success";
      refund.businessApplyState = "completed";
      return;
    }

    const successfulBefore = this.getRefundTotals(order.id, refund.id).success;
    const successfulAfter = successfulBefore + refund.amount;

    if (successfulAfter > order.amount) {
      throw new BadRequestException("累计成功退款金额超过支付单金额，拒绝应用退款结果。");
    }

    if (
      successfulAfter === order.amount &&
      !this.isDuplicatePaymentOrder(order) &&
      order.orderNo &&
      order.deviceCode
    ) {
      const providerTransactionId = this.readString(order.providerTransactionId);
      if (!providerTransactionId) {
        throw new ConflictException("原支付交易号缺失，退款业务副作用保持待补偿。");
      }
      this.inventoryOrdersService.markRefund(
        order.adjustmentOrderNo ?? order.orderNo,
        providerTransactionId,
        successfulAfter,
        {
          source: "payment-service",
          refundNo: refund.refundNo,
          deviceCode: order.deviceCode,
          actor:
            refund.requestedByUserId && refund.requestedByRole
              ? {
                  id: refund.requestedByUserId,
                  role: refund.requestedByRole
                }
              : undefined
        }
      );
    }

    const now = new Date().toISOString();
    refund.status = "success";
    refund.providerOutcome = "success";
    refund.businessApplyState = "completed";
    refund.refundedAt = now;
    refund.updatedAt = now;
    if (successfulAfter === order.amount) {
      order.status = "refunded";
    }
    order.refundNo = refund.refundNo;
    order.updatedAt = now;
  }

  private assertRefundSuccessWithinOrder(order: PaymentOrderRecord, refund: PaymentRefundRecord) {
    const successfulBefore = this.getRefundTotals(order.id, refund.id).success;

    if (successfulBefore + refund.amount > order.amount) {
      throw new BadRequestException("累计成功退款金额超过支付单金额，拒绝应用退款结果。");
    }
  }

  private resolveBusinessPaymentTransactionId(order: PaymentOrderRecord) {
    const event = order.eventId
      ? this.store.events.find((entry) => entry.eventId === order.eventId)
      : undefined;
    if (!event) {
      return undefined;
    }

    if (order.adjustmentOrderNo) {
      return this.readString(
        event.adjustments?.find((entry) => entry.orderNo === order.adjustmentOrderNo)
          ?.paymentTransactionId
      );
    }

    return event.paymentNotifyStatus === "success"
      ? this.readString(event.paymentTransactionId)
      : undefined;
  }

  private resolveOtherPaidBusinessTransactionId(order: PaymentOrderRecord) {
    const businessOrderNo = order.adjustmentOrderNo ?? order.orderNo;
    if (!businessOrderNo) {
      return undefined;
    }

    const existing = this.store.paymentOrders.find(
      (entry) =>
        entry.id !== order.id &&
        entry.eventId === order.eventId &&
        (entry.adjustmentOrderNo ?? entry.orderNo) === businessOrderNo &&
        (entry.status === "paid" || entry.status === "refunded") &&
        Boolean(this.readString(entry.providerTransactionId))
    );
    return this.readString(existing?.providerTransactionId);
  }

  private recordDuplicatePaymentConflict(
    order: PaymentOrderRecord,
    payload: ProviderPaidPayload,
    providerTransactionId: string,
    existingBusinessTransactionId: string,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ) {
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    const now = new Date().toISOString();
    order.status = "paid";
    order.providerTransactionId = providerTransactionId;
    order.callbackPayload = payload.callbackPayload;
    order.paidAt = now;
    order.updatedAt = now;
    order.failReason = undefined;
    order.metadata = {
      ...(order.metadata ?? {}),
      reconciliationState: "duplicate_payment",
      smartVmForwardState: "blocked",
      smartVmForwardError: "业务订单已绑定其他支付交易号，已阻止自动回写。"
    };

    const conflictLog = this.store.logOperation({
      category: "inventory",
      type: "duplicate-payment-reconciliation",
      status: "warning",
      actor: {
        type: "system",
        name: "支付回调"
      },
      primarySubject: {
        type: "event",
        id: order.eventId ?? order.id,
        label: order.adjustmentOrderNo ?? order.orderNo ?? order.paymentNo
      },
      relatedEventId: order.eventId,
      relatedOrderNo: order.adjustmentOrderNo ?? order.orderNo,
      description: "支付渠道确认了一笔付款，但业务订单已绑定另一交易号。",
      detail: "系统已记录新付款并阻止自动覆盖，必须人工核对是否重复收款并按渠道账单处置。",
      metadata: {
        paymentOrderId: order.id,
        paymentNo: order.paymentNo,
        provider: order.provider,
        existingBusinessTransactionId,
        callbackTransactionId: providerTransactionId,
        amount: order.amount,
        undoState: "not_undoable"
      }
    });
    this.alertsService.create({
      type: "callback",
      grade: "fault",
      title: "疑似重复收款待核对",
      deviceCode: order.deviceCode,
      targetUserId: order.payerUserId,
      dueAt: now,
      detail: `订单 ${order.adjustmentOrderNo ?? order.orderNo ?? order.paymentNo} 已出现不同支付交易号，系统已阻止自动覆盖，请立即核对渠道账单。`,
      relatedEventId: order.eventId,
      sourceLogId: conflictLog.id
    });
    this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
    this.store.persist();
    return order;
  }

  private isDuplicatePaymentOrder(order: PaymentOrderRecord) {
    return order.metadata?.reconciliationState === "duplicate_payment";
  }

  private requiresSmartVmForwardRecovery(order: PaymentOrderRecord) {
    return (
      order.status === "paid" &&
      !this.isSimulatedPaymentOrder(order) &&
      !this.isDuplicatePaymentOrder(order) &&
      order.metadata?.smartVmForwardState !== "completed" &&
      order.metadata?.smartVmForwardState !== "blocked" &&
      Boolean(order.orderNo && order.eventId && order.deviceCode)
    );
  }

  private isPaymentOrderReconciliationCandidate(order: PaymentOrderRecord) {
    return (
      !this.isSimulatedPaymentOrder(order) &&
      (
        order.status === "pending" ||
        this.requiresSmartVmForwardRecovery(order)
      )
    );
  }

  private async forwardPaymentSuccessToSmartVm(
    order: PaymentOrderRecord,
    financialOperationLease: FinancialOperationLease,
    assertRuntimeSafety?: AutomaticReconciliationRuntimeSafetyAssertion
  ) {
    if (!order.orderNo || !order.eventId || !order.deviceCode) {
      return true;
    }
    const orderNo = order.adjustmentOrderNo ?? order.orderNo;
    const eventId = order.eventId;
    const deviceCode = order.deviceCode;

    const existing = this.paymentForwardInFlight.get(order.id);
    if (existing) {
      const result = await existing;
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      return result;
    }

    const action = (async () => {
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      order.metadata = {
        ...(order.metadata ?? {}),
        smartVmForwardState: "submitting",
        smartVmForwardError: undefined
      };
      this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
      this.store.persist();

      try {
        await this.cabinetEventsService.notifyConfirmedPaymentSuccess(
          {
            orderNo,
            eventId,
            transactionId:
              order.providerTransactionId ?? order.providerOrderId ?? order.paymentNo,
            deviceCode,
            amount: order.amount
          },
          order.id,
          financialOperationLease,
          assertRuntimeSafety
        );
        this.assertFinancialWriter();
        this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
        order.metadata = {
          ...(order.metadata ?? {}),
          smartVmForwardState: "completed",
          smartVmForwardError: undefined
        };
        this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
        this.store.persist();
        return true;
      } catch (error) {
        this.assertFinancialWriter();
        this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
        order.metadata = {
          ...(order.metadata ?? {}),
          smartVmForwardState: "pending",
          smartVmForwardError: error instanceof Error ? error.message : "回写柜机平台失败"
        };
        this.assertAutomaticReconciliationRuntimeSafety(assertRuntimeSafety);
        this.store.persist();
        return false;
      }
    })();
    this.paymentForwardInFlight.set(order.id, action);
    try {
      return await action;
    } finally {
      if (this.paymentForwardInFlight.get(order.id) === action) {
        this.paymentForwardInFlight.delete(order.id);
      }
    }
  }

  private parseWechatPaidPayload(
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    rawBody?: string
  ): ProviderPaidPayload {
    this.verifyWechatSignature(headers, rawBody ?? JSON.stringify(body));
    const officialEnvelope = this.assertWechatCallbackEnvelope(body, "transaction");
    const resource = body.resource as Record<string, unknown> | undefined;
    const decrypted = resource ? this.decryptWechatResource(resource) : body;
    this.assertWechatPaymentCallbackIdentity(decrypted);
    this.assertWechatPaymentCurrency(decrypted.amount);
    if (officialEnvelope) {
      this.assertWechatPaymentPayerAmount(decrypted.amount);
    }
    const tradeState = this.readString(decrypted.trade_state);

    if (tradeState !== "SUCCESS") {
      throw new BadRequestException(`微信支付状态不是 SUCCESS：${tradeState}`);
    }

    const paymentNo = this.readString(decrypted.out_trade_no);
    const amount = this.readAmount(decrypted.amount);
    const providerTransactionId = this.readString(decrypted.transaction_id);

    if (!paymentNo) {
      throw new BadRequestException("微信回调缺少 out_trade_no。");
    }

    if (amount === undefined) {
      throw new BadRequestException("微信回调缺少支付金额。");
    }

    if (!providerTransactionId) {
      throw new BadRequestException("微信回调缺少 transaction_id。");
    }

    return {
      provider: "wechat",
      paymentNo,
      providerTransactionId,
      amount,
      callbackPayload: {
        appid: decrypted.appid,
        mchid: decrypted.mchid,
        out_trade_no: paymentNo,
        transaction_id: providerTransactionId,
        trade_state: tradeState,
        amount: {
          total: amount,
          currency: "CNY"
        }
      }
    };
  }

  private assertWechatPaymentCallbackIdentity(payload: Record<string, unknown>) {
    const expectedAppId = this.requireConfig("WECHAT_PAY_APP_ID");
    const expectedMerchantId = this.requireConfig("WECHAT_PAY_MCH_ID");
    const appId = this.readString(payload.appid);
    const merchantId = this.readString(payload.mchid);

    if (!appId) {
      throw new BadRequestException("微信支付回调缺少 appid。");
    }

    if (appId !== expectedAppId) {
      throw new BadRequestException("微信支付回调应用标识与本地配置不一致。");
    }

    if (!merchantId) {
      throw new BadRequestException("微信支付回调缺少 mchid。");
    }

    if (merchantId !== expectedMerchantId) {
      throw new BadRequestException("微信支付回调商户标识与本地配置不一致。");
    }
  }

  private assertWechatPaymentCurrency(value: unknown) {
    const currency =
      value && typeof value === "object"
        ? this.readString((value as { currency?: unknown }).currency)
        : undefined;

    if (currency !== "CNY") {
      throw new BadRequestException("微信支付回调币种必须为 CNY。");
    }
  }

  private parseWechatRefundPayload(
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    rawBody?: string
  ): WechatRefundCallbackPayload {
    this.verifyWechatSignature(headers, rawBody ?? JSON.stringify(body));
    const officialEnvelope = this.assertWechatCallbackEnvelope(body, "refund");
    const resource = body.resource as Record<string, unknown> | undefined;
    const decrypted = resource ? this.decryptWechatResource(resource) : body;
    this.assertWechatRefundCallbackIdentity(decrypted);
    const paymentNo = this.readString(decrypted.out_trade_no);
    const refundNo = this.readString(decrypted.out_refund_no);
    const providerRefundId = this.readString(decrypted.refund_id);
    const providerTransactionId = this.readString(decrypted.transaction_id);
    const refundStatus = this.readString(decrypted.refund_status);
    this.assertWechatRefundCurrency(decrypted.amount);
    if (officialEnvelope) {
      this.assertWechatRefundPayerAmounts(decrypted.amount);
      this.assertWechatRefundEventMatchesStatus(body, refundStatus);
    }
    const amount = this.readWechatRefundAmount(decrypted.amount);
    const totalAmount = this.readWechatRefundTotal(decrypted.amount);

    if (!paymentNo || !refundNo) {
      throw new BadRequestException("微信退款回调缺少 out_trade_no 或 out_refund_no。");
    }
    if (!providerRefundId) {
      throw new BadRequestException("微信退款回调缺少 refund_id。");
    }
    if (!providerTransactionId) {
      throw new BadRequestException("微信退款回调缺少 transaction_id。");
    }

    if (amount === undefined) {
      throw new BadRequestException("微信退款回调缺少退款金额。");
    }
    if (totalAmount === undefined) {
      throw new BadRequestException("微信退款回调缺少订单总额。");
    }

    const statusMap: Record<string, PaymentRefundStatus> = {
      SUCCESS: "success",
      PROCESSING: "pending",
      ABNORMAL: "pending",
      CLOSED: "failed"
    };
    const status = refundStatus ? statusMap[refundStatus] : undefined;

    if (!status) {
      throw new BadRequestException("微信退款回调退款状态无效。");
    }

    return {
      paymentNo,
      refundNo,
      providerRefundId,
      providerTransactionId,
      status,
      amount,
      totalAmount,
      callbackPayload: {
        mchid: decrypted.mchid,
        out_trade_no: paymentNo,
        transaction_id: providerTransactionId,
        out_refund_no: refundNo,
        refund_id: providerRefundId,
        refund_status: refundStatus,
        amount: {
          total: totalAmount,
          refund: amount,
          ...(this.readString(
            decrypted.amount && typeof decrypted.amount === "object"
              ? (decrypted.amount as Record<string, unknown>).currency
              : undefined
          )
            ? {
                currency: this.readString(
                  (decrypted.amount as Record<string, unknown>).currency
                )
              }
            : {})
        }
      },
      failReason:
        refundStatus === "ABNORMAL"
          ? "微信退款状态：ABNORMAL，结果待确认，请人工核对。"
          : status === "failed"
            ? `微信退款状态：${refundStatus}`
            : undefined
    };
  }

  private assertWechatRefundCallbackIdentity(payload: Record<string, unknown>) {
    const expectedMerchantId = this.requireConfig("WECHAT_PAY_MCH_ID");
    const merchantId = this.readString(payload.mchid);

    if (!merchantId) {
      throw new BadRequestException("微信退款回调缺少 mchid。");
    }

    if (merchantId !== expectedMerchantId) {
      throw new BadRequestException("微信退款回调商户标识与本地配置不一致。");
    }
  }

  private assertWechatRefundCurrency(value: unknown) {
    const currency =
      value && typeof value === "object"
        ? this.readString((value as { currency?: unknown }).currency)
        : undefined;

    if (currency !== undefined && currency !== "CNY") {
      throw new BadRequestException("微信退款回调币种必须为 CNY。");
    }
  }

  private parseAlipayPaidPayload(body: Record<string, unknown>): ProviderPaidPayload {
    this.verifyAlipaySignature(body);
    this.assertProviderCallbackFreshness(body.notify_time, "支付宝回调 notify_time");
    this.assertAlipayCallbackIdentity(body);

    const status = this.readString(body.trade_status);

    if (status !== "TRADE_SUCCESS" && status !== "TRADE_FINISHED") {
      throw new BadRequestException(`支付宝交易状态不是成功：${status}`);
    }

    const paymentNo = this.readString(body.out_trade_no) ?? this.readString(body.paymentNo);
    const amount = this.readYuanAmount(body.total_amount);
    const providerTransactionId = this.readString(body.trade_no) ?? this.readString(body.transactionId);

    if (!paymentNo) {
      throw new BadRequestException("支付宝回调缺少 out_trade_no。");
    }

    if (amount === undefined) {
      throw new BadRequestException("支付宝回调缺少支付金额。");
    }

    if (!providerTransactionId) {
      throw new BadRequestException("支付宝回调缺少 trade_no。");
    }

    return {
      provider: "alipay",
      paymentNo,
      providerTransactionId,
      amount,
      callbackPayload: {
        app_id: body.app_id,
        seller_id: body.seller_id,
        out_trade_no: paymentNo,
        trade_no: providerTransactionId,
        trade_status: status,
        total_amount: body.total_amount,
        notify_time: body.notify_time
      }
    };
  }

  private assertAlipayCallbackIdentity(body: Record<string, unknown>) {
    const expectedAppId = this.requireConfig("ALIPAY_APP_ID");
    const appId = this.readString(body.app_id);

    if (!appId) {
      throw new BadRequestException("支付宝回调缺少 app_id。");
    }

    if (appId !== expectedAppId) {
      throw new BadRequestException("支付宝回调应用标识与本地配置不一致。");
    }

    const expectedSellerId = this.requireConfig("ALIPAY_SELLER_ID");
    const sellerId = this.readString(body.seller_id);

    if (!sellerId) {
      throw new BadRequestException("支付宝回调缺少 seller_id。");
    }

    if (sellerId !== expectedSellerId) {
      throw new BadRequestException("支付宝回调商户标识与本地配置不一致。");
    }
  }

  private verifyWechatSignature(headers: Record<string, string | undefined>, rawBody: string) {
    const publicKey = this.normalizePem(this.getConfigValue("WECHAT_PAY_PLATFORM_PUBLIC_KEY"));

    if (!publicKey) {
      throw new BadRequestException("微信支付平台公钥未配置，无法验签。");
    }

    const signature = headers["wechatpay-signature"];
    const timestamp = headers["wechatpay-timestamp"];
    const nonce = headers["wechatpay-nonce"];
    const serial = headers["wechatpay-serial"];

    if (!signature || !timestamp || !nonce || !serial) {
      throw new BadRequestException("微信支付回调缺少验签请求头。");
    }
    this.assertWechatPlatformSerial(serial, "微信支付回调");

    this.assertProviderCallbackFreshness(timestamp, "微信回调 wechatpay-timestamp");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8");
    verifier.end();

    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadRequestException("微信支付回调验签失败。");
    }
  }

  private assertWechatPlatformSerial(serial: string, label: string) {
    const expectedSerial = this.getConfigValue("WECHAT_PAY_PLATFORM_CERT_SERIAL_NO");
    if (expectedSerial && serial !== expectedSerial) {
      throw new BadRequestException(`${label}平台证书序列号与本地配置不一致。`);
    }
  }

  private assertWechatCallbackEnvelope(
    body: Record<string, unknown>,
    expectedOriginalType: "transaction" | "refund"
  ) {
    const resource = body.resource;
    if (!resource) {
      if (isProductionRuntime() || this.isLiveDataPlane()) {
        throw new BadRequestException("真实数据平面微信支付回调必须使用官方加密资源信封。");
      }
      return false;
    }
    if (typeof resource !== "object" || Array.isArray(resource)) {
      throw new BadRequestException("微信支付回调 resource 格式无效。");
    }

    const resourceObject = resource as Record<string, unknown>;
    const resourceType = this.readString(body.resource_type);
    const eventType = this.readString(body.event_type);
    const algorithm = this.readString(resourceObject.algorithm);
    const originalType = this.readString(resourceObject.original_type);
    const allowedEventTypes =
      expectedOriginalType === "transaction"
        ? ["TRANSACTION.SUCCESS"]
        : ["REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"];

    if (resourceType !== "encrypt-resource") {
      throw new BadRequestException("微信支付回调 resource_type 必须为 encrypt-resource。");
    }
    if (algorithm !== "AEAD_AES_256_GCM") {
      throw new BadRequestException("微信支付回调加密算法必须为 AEAD_AES_256_GCM。");
    }
    if (originalType !== expectedOriginalType) {
      throw new BadRequestException("微信支付回调资源类型与当前回调入口不一致。");
    }
    if (!eventType || !allowedEventTypes.includes(eventType)) {
      throw new BadRequestException("微信支付回调 event_type 与当前回调入口不一致。");
    }

    return true;
  }

  private assertWechatPaymentPayerAmount(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("微信支付回调缺少付款方金额。");
    }
    const amount = value as Record<string, unknown>;
    const total = this.readAmount(amount.total);
    const payerTotal = this.readAmount(amount.payer_total);
    const payerCurrency = this.readString(amount.payer_currency);

    if (total === undefined || payerTotal === undefined || payerTotal > total) {
      throw new BadRequestException("微信支付回调付款方金额无效。");
    }
    if (payerCurrency !== "CNY") {
      throw new BadRequestException("微信支付回调付款方币种必须为 CNY。");
    }
  }

  private assertWechatRefundPayerAmounts(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("微信退款回调缺少付款方退款金额。");
    }
    const amount = value as Record<string, unknown>;
    const total = this.readAmount(amount.total);
    const refund = this.readAmount(amount.refund);
    const payerTotal = this.readAmount(amount.payer_total);
    const payerRefund = this.readAmount(amount.payer_refund);
    const payerCurrency = this.readString(amount.payer_currency);

    if (
      total === undefined ||
      refund === undefined ||
      payerTotal === undefined ||
      payerRefund === undefined ||
      payerTotal > total ||
      payerRefund > refund ||
      payerRefund > payerTotal
    ) {
      throw new BadRequestException("微信退款回调付款方金额无效。");
    }
    if (payerCurrency !== "CNY") {
      throw new BadRequestException("微信退款回调付款方币种必须为 CNY。");
    }
  }

  private assertWechatRefundEventMatchesStatus(
    body: Record<string, unknown>,
    refundStatus?: string
  ) {
    const expectedStatusByEvent: Record<string, string> = {
      "REFUND.SUCCESS": "SUCCESS",
      "REFUND.ABNORMAL": "ABNORMAL",
      "REFUND.CLOSED": "CLOSED"
    };
    const eventType = this.readString(body.event_type);
    if (!eventType || expectedStatusByEvent[eventType] !== refundStatus) {
      throw new BadRequestException("微信退款回调 event_type 与 refund_status 不一致。");
    }
  }

  private assertProviderCallbackFreshness(value: unknown, label: string) {
    const occurredAt = this.parseProviderCallbackTime(value);

    if (occurredAt === undefined) {
      throw new BadRequestException(`${label} 缺失或格式无效。`);
    }

    const futureToleranceSeconds = this.readPositiveIntegerConfig(
      "PAYMENT_CALLBACK_FUTURE_TOLERANCE_SECONDS",
      60
    );
    const ageMilliseconds = Date.now() - occurredAt;

    if (ageMilliseconds < -futureToleranceSeconds * 1000) {
      throw new BadRequestException(`${label} 超出允许的未来时钟偏差。`);
    }
  }

  private parseProviderCallbackTime(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
    }

    if (typeof value !== "string" || !value.trim()) {
      return undefined;
    }

    const normalized = value.trim();

    if (/^\d{10,13}$/.test(normalized)) {
      const numeric = Number(normalized);
      return normalized.length === 13 ? numeric : numeric * 1000;
    }

    const alipayTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)
      ? `${normalized.replace(" ", "T")}+08:00`
      : normalized;
    const parsed = Date.parse(alipayTimestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private readPositiveIntegerConfig(key: string, fallback: number) {
    const raw = this.getConfigValue(key);
    const parsed = raw === undefined ? fallback : Number(raw);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${key} 必须是正整数。`);
    }

    return parsed;
  }

  private readPositiveCountConfig(key: string, fallback: number) {
    const raw = this.getConfigValue(key);
    const parsed = raw === undefined ? fallback : Number(raw);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${key} 必须是正整数。`);
    }

    return parsed;
  }

  private verifyAlipaySignature(body: Record<string, unknown>) {
    const publicKey = this.normalizePem(this.getConfigValue("ALIPAY_PUBLIC_KEY"));

    if (!publicKey) {
      throw new BadRequestException("支付宝公钥未配置，无法验签。");
    }

    const signature = this.readString(body.sign);

    if (!signature) {
      throw new BadRequestException("支付宝回调缺少 sign。");
    }

    const unsigned = this.buildAlipayCanonicalString(body);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(unsigned, "utf8");
    verifier.end();

    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadRequestException("支付宝回调验签失败。");
    }
  }

  private decryptWechatResource(resource: Record<string, unknown>) {
    const apiV3Key = this.requireConfig("WECHAT_PAY_API_V3_KEY");
    const ciphertext = this.readString(resource.ciphertext);
    const nonce = this.readString(resource.nonce);
    const associatedData = this.readString(resource.associated_data) ?? "";

    if (!ciphertext || !nonce) {
      throw new BadRequestException("微信支付回调资源字段不完整。");
    }

    const decoded = Buffer.from(ciphertext, "base64");
    const authTag = decoded.subarray(decoded.length - 16);
    const encrypted = decoded.subarray(0, decoded.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));

    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(associatedData));
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as Record<string, unknown>;
  }

  private resolveEvent(payload: PaymentOrderCreatePayload) {
    if (payload.eventId) {
      const event = this.store.events.find((entry) => entry.eventId === payload.eventId);

      if (!event) {
        throw new BadRequestException("未找到对应开柜事件。");
      }

      return event;
    }

    if (payload.orderNo || payload.adjustmentOrderNo) {
      const orderNo = payload.adjustmentOrderNo ?? payload.orderNo;
      const event = this.store.events.find(
        (entry) =>
          entry.orderNo === orderNo ||
          entry.adjustmentOrderNo === orderNo ||
          entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)
      );

      if (!event) {
        throw new BadRequestException("未找到对应业务订单。");
      }

      return event;
    }

    return undefined;
  }

  private resolvePaymentOrderContext(payload: PaymentOrderCreatePayload): PaymentOrderContext {
    if (!paymentProviders.includes(payload.provider)) {
      throw new BadRequestException("不支持的支付方式。");
    }

    if (payload.phase !== "pre_open" && payload.phase !== "post_settlement") {
      throw new BadRequestException("不支持的支付阶段。");
    }

    if (payload.phase === "pre_open") {
      throw new BadRequestException(
        "开柜前支付阶段尚未启用；请在柜门关闭、服务端结算金额确认后再创建支付单。"
      );
    }

    const event = this.resolveEvent(payload);

    if (!event) {
      throw new BadRequestException("创建支付单必须关联柜机事件或业务订单。");
    }

    const inferredAdjustmentOrderNo =
      payload.adjustmentOrderNo ??
      (payload.orderNo && payload.orderNo !== event.orderNo ? payload.orderNo : undefined);
    const adjustment = inferredAdjustmentOrderNo
      ? event.adjustments?.find((entry) => entry.orderNo === inferredAdjustmentOrderNo)
      : undefined;

    if (inferredAdjustmentOrderNo && !adjustment) {
      throw new BadRequestException("补扣订单不属于当前柜机事件。");
    }

    if (
      payload.orderNo &&
      payload.orderNo !== event.orderNo &&
      payload.orderNo !== adjustment?.orderNo
    ) {
      throw new BadRequestException("业务订单号与柜机事件不一致。");
    }

    if (payload.deviceCode && payload.deviceCode !== event.deviceCode) {
      throw new BadRequestException("柜机编号与柜机事件不一致。");
    }

    if (payload.payerUserId && payload.payerUserId !== event.userId) {
      throw new BadRequestException("付款用户与柜机事件不一致。");
    }

    if (adjustment && payload.phase !== "post_settlement") {
      throw new BadRequestException("补扣订单只能在结算后支付。");
    }

    if (payload.phase === "post_settlement") {
      if (event.billingStatus === "mismatch") {
        throw new BadRequestException("当前业务仍在差异核对中，不能创建支付单。");
      }

      if (adjustment) {
        if (adjustment.refundedAt) {
          throw new BadRequestException("该补扣订单已退款，不能重新支付。");
        }

        if (adjustment.paymentNotifyStatus === "success") {
          throw new BadRequestException("该补扣订单已完成支付，不能重复创建支付单。");
        }
      } else {
        if (event.status === "refunded" || event.refundedAt) {
          throw new BadRequestException("该业务订单已退款，不能重新支付。");
        }

        if (event.paymentNotifyStatus === "success") {
          throw new BadRequestException("该业务订单已完成支付，不能重复创建支付单。");
        }
      }

      if (event.status !== "settled" && event.status !== "closed") {
        throw new BadRequestException("当前业务订单尚未进入可支付的结算状态。");
      }
    }

    const amount =
      adjustment?.amount ??
      (payload.phase === "post_settlement"
        ? event.amount
        : event.preSettlement?.payableAmount ?? 0);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException("当前业务事件没有需要支付的有效金额。");
    }

    if (payload.amount !== undefined) {
      if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) {
        throw new BadRequestException("客户端支付金额必须是正整数分值。");
      }

      if (payload.amount !== amount) {
        throw new BadRequestException("客户端支付金额与服务端业务金额不一致。");
      }
    }

    return {
      event,
      adjustment,
      amount,
      businessOrderNo: adjustment?.orderNo ?? event.orderNo
    };
  }

  private assertCanCreateOrder(
    event: CabinetEventRecord,
    payload: PaymentOrderCreatePayload,
    actor?: Actor
  ) {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (
      event.role === "special" &&
      (
        event.reservationOnlyPickup === true ||
        event.preSettlement?.chargeRequired === false
      )
    ) {
      throw new BadRequestException(
        "当前公益物资只支持免费领取，不创建用户支付单。"
      );
    }

    if (actor.role === "admin") {
      return;
    }

    if (actor.id !== event.userId || actor.role !== event.role) {
      throw new ForbiddenException("不能为其他用户或商家的业务创建支付单。");
    }

    if (actor.role === "merchant" && payload.merchantUserId && payload.merchantUserId !== actor.id) {
      throw new ForbiddenException("不能为其他商家的业务创建支付单。");
    }

    if (actor.role !== "merchant" && payload.merchantUserId) {
      throw new BadRequestException("当前业务不能由客户端指定退款商家。");
    }
  }

  private buildPaymentIdempotencyKey(
    payload: PaymentOrderCreatePayload,
    context: PaymentOrderContext
  ) {
    return [payload.phase, context.event.eventId, context.businessOrderNo].join(":");
  }

  private findIdempotentPaymentOrder(
    payload: PaymentOrderCreatePayload,
    context: PaymentOrderContext
  ) {
    return this.store.paymentOrders.find(
      (entry) =>
        entry.phase === payload.phase &&
        entry.eventId === context.event.eventId &&
        (entry.adjustmentOrderNo ?? entry.orderNo) === context.businessOrderNo &&
        entry.status !== "failed" &&
        entry.status !== "closed"
    );
  }

  private toCreateResult(order: PaymentOrderRecord): PaymentOrderCreateResult {
    const {
      invokePayload,
      callbackPayload: _callbackPayload,
      providerTransactionId: _providerTransactionId,
      ...clientOrder
    } = order;
    return {
      order: clientOrder,
      invokePayload: invokePayload ?? {}
    };
  }

  private buildSubject(
    payload: PaymentOrderCreatePayload,
    event?: CabinetEventRecord,
    adjustmentOrderNo?: string
  ) {
    if (payload.phase === "pre_open") {
      return `柜机开门预支付 ${payload.deviceCode ?? event?.deviceCode ?? ""}`.trim();
    }

    return adjustmentOrderNo
      ? `柜机补扣支付 ${adjustmentOrderNo}`
      : `柜机结算支付 ${event?.orderNo ?? payload.orderNo ?? ""}`.trim();
  }

  private buildMockInvokePayload(order: PaymentOrderRecord, simulatedReason?: string) {
    if (order.provider === "wechat") {
      const appId = this.getConfigValue("WECHAT_PAY_APP_ID") ?? "";
      const timeStamp = Math.floor(Date.now() / 1000).toString();
      const nonceStr = randomBytes(16).toString("hex");
      const packageValue = `prepay_id=${order.providerOrderId}`;

      return {
        provider: "wechat",
        appId,
        timeStamp,
        nonceStr,
        package: packageValue,
        signType: "RSA",
        paySign: `mock-${nonceStr}`,
        simulated: true,
        simulatedReason
      };
    }

    return {
      provider: "alipay",
      tradeNO: order.providerOrderId,
      orderStr: order.providerOrderId,
      simulated: true,
      simulatedReason
    };
  }

  private buildWechatInvokePayload(appId: string, prepayId: string) {
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = randomBytes(16).toString("hex");
    const packageValue = `prepay_id=${prepayId}`;

    return {
      provider: "wechat",
      appId,
      timeStamp,
      nonceStr,
      package: packageValue,
      signType: "RSA",
      paySign: this.signWechatInvokePayload(appId, timeStamp, nonceStr, packageValue),
      simulated: false
    };
  }

  private signWechatInvokePayload(appId: string, timeStamp: string, nonceStr: string, packageValue: string) {
    const privateKey = this.normalizePem(this.requireConfig("WECHAT_PAY_MERCHANT_PRIVATE_KEY"));
    const signer = createSign("RSA-SHA256");
    signer.update(`${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`, "utf8");
    signer.end();
    return signer.sign(privateKey, "base64");
  }

  private async callWechatApi<T extends Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    bodyObject?: Record<string, unknown>
  ): Promise<T> {
    const url = this.resolveWechatApiUrl(path);
    const body = bodyObject ? JSON.stringify(bodyObject) : "";
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.createWechatAuthorization(method, url, body)
    };
    if (bodyObject) {
      headers["Content-Type"] = "application/json";
    }
    const { response, text } = await this.fetchProvider(url, {
      method,
      headers,
      ...(bodyObject ? { body } : {})
    }, "微信支付接口");
    this.verifyWechatProviderResponse(response, text);
    const data = text
      ? this.parseProviderJsonObject(text, providerLabels.wechat)
      : {};

    if (!response.ok) {
      throw new BadGatewayException({
        message: `微信支付接口调用失败：${this.extractProviderError(data, text)}`,
        providerCode: this.readString(data.code)
      });
    }

    return data as T;
  }

  private createWechatAuthorization(method: string, url: URL, body: string) {
    const mchId = this.requireConfig("WECHAT_PAY_MCH_ID");
    const serialNo = this.requireConfig("WECHAT_PAY_MERCHANT_CERT_SERIAL_NO");
    const privateKey = this.normalizePem(this.requireConfig("WECHAT_PAY_MERCHANT_PRIVATE_KEY"));
    const nonceStr = randomBytes(16).toString("hex");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const pathWithQuery = `${url.pathname}${url.search}`;
    const signer = createSign("RSA-SHA256");

    signer.update(`${method}\n${pathWithQuery}\n${timestamp}\n${nonceStr}\n${body}\n`, "utf8");
    signer.end();

    const signature = signer.sign(privateKey, "base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
  }

  private async callAlipayGateway(
    method: string,
    extraParams: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const gatewayUrl = this.getConfigValue("ALIPAY_GATEWAY_URL") ?? "https://openapi.alipay.com/gateway.do";
    const params: Record<string, string> = {
      app_id: this.requireConfig("ALIPAY_APP_ID"),
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: this.formatAlipayTimestamp(new Date()),
      version: "1.0",
      ...extraParams
    };
    params.sign = this.signAlipayParams(params);

    const { response, text } = await this.fetchProvider(gatewayUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: new URLSearchParams(params).toString()
    }, "支付宝接口");
    const data = this.parseProviderJsonObject(text, providerLabels.alipay);

    if (!response.ok) {
      throw new BadGatewayException({
        message: `支付宝接口调用失败：${this.extractProviderError(data, text)}`,
        providerCode:
          this.readString(data.sub_code) ??
          this.readString(data.code)
      });
    }

    const responseKey = `${method.replace(/\./g, "_")}_response`;
    this.verifyAlipayProviderResponse(text, data, responseKey);
    const gatewayResponse = data[responseKey];

    if (!gatewayResponse || typeof gatewayResponse !== "object" || Array.isArray(gatewayResponse)) {
      throw new BadGatewayException("支付宝接口响应格式不正确。");
    }

    const payload = gatewayResponse as Record<string, unknown>;
    const code = this.readString(payload.code);

    if (code !== "10000") {
      throw new BadGatewayException({
        message: `支付宝接口调用失败：${this.extractProviderError(payload, text)}`,
        providerCode:
          this.readString(payload.sub_code) ??
          code
      });
    }

    return payload;
  }

  private signAlipayParams(params: Record<string, string>) {
    const privateKey = this.normalizePem(this.requireConfig("ALIPAY_APP_PRIVATE_KEY"));
    const unsigned = this.buildAlipayCanonicalString(params);
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned, "utf8");
    signer.end();
    return signer.sign(privateKey, "base64");
  }

  private buildAlipayCanonicalString(params: Record<string, unknown>) {
    return Object.entries(params)
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
  }

  private verifyWechatProviderResponse(response: Response, rawBody: string) {
    const signature = response.headers.get("wechatpay-signature");
    const timestamp = response.headers.get("wechatpay-timestamp");
    const nonce = response.headers.get("wechatpay-nonce");
    const serial = response.headers.get("wechatpay-serial");
    if (!signature || !timestamp || !nonce || !serial) {
      throw new BadGatewayException("微信支付接口响应缺少平台签名头，结果保持待确认。");
    }
    try {
      this.assertWechatPlatformSerial(serial, "微信支付接口响应");
    } catch {
      throw new BadGatewayException("微信支付接口响应平台证书序列号不匹配，结果保持待确认。");
    }

    const occurredAt = this.parseProviderCallbackTime(timestamp);
    const futureToleranceSeconds = this.readPositiveIntegerConfig(
      "PAYMENT_CALLBACK_FUTURE_TOLERANCE_SECONDS",
      60
    );
    if (
      occurredAt === undefined ||
      Date.now() - occurredAt < -futureToleranceSeconds * 1_000
    ) {
      throw new BadGatewayException("微信支付接口响应时间无效，结果保持待确认。");
    }

    const publicKey = this.normalizePem(
      this.requireConfig("WECHAT_PAY_PLATFORM_PUBLIC_KEY")
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8");
    verifier.end();
    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadGatewayException("微信支付接口响应验签失败，结果保持待确认。");
    }
  }

  private verifyAlipayProviderResponse(
    rawBody: string,
    parsed: Record<string, unknown>,
    responseKey: string
  ) {
    const signature = this.readString(parsed.sign);
    const signedContent = this.extractJsonObjectSource(rawBody, responseKey);
    if (!signature || !signedContent) {
      throw new BadGatewayException("支付宝接口响应缺少有效签名，结果保持待确认。");
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signedContent, "utf8");
    verifier.end();
    const publicKey = this.normalizePem(this.requireConfig("ALIPAY_PUBLIC_KEY"));
    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadGatewayException("支付宝接口响应验签失败，结果保持待确认。");
    }
  }

  private extractJsonObjectSource(rawBody: string, key: string) {
    const marker = `"${key}"`;
    const keyIndex = rawBody.indexOf(marker);
    if (keyIndex < 0) {
      return undefined;
    }

    let cursor = keyIndex + marker.length;
    while (/\s/.test(rawBody[cursor] ?? "")) {
      cursor += 1;
    }
    if (rawBody[cursor] !== ":") {
      return undefined;
    }
    cursor += 1;
    while (/\s/.test(rawBody[cursor] ?? "")) {
      cursor += 1;
    }
    if (rawBody[cursor] !== "{") {
      return undefined;
    }

    const start = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; cursor < rawBody.length; cursor += 1) {
      const character = rawBody[cursor]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }

      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return rawBody.slice(start, cursor + 1);
        }
      }
    }

    return undefined;
  }

  private parseProviderJsonObject(text: string, label: string) {
    try {
      return this.parseJsonObject(text, label);
    } catch {
      throw new BadGatewayException(`${label}响应不是有效 JSON，结果保持待确认。`);
    }
  }

  private async callJsonEndpoint(url: string, label: string) {
    const { response, text } = await this.fetchProvider(url, {
      headers: {
        Accept: "application/json"
      }
    }, label);
    const data = this.parseJsonObject(text, label);

    if (!response.ok) {
      throw new BadRequestException(`${label}失败：${this.extractProviderError(data, text)}`);
    }

    return data;
  }

  private async fetchProvider(input: string | URL, init: RequestInit, label: string) {
    const timeoutMs = this.getProviderTimeoutMs();
    const controller = new AbortController();
    let timedOut = false;
    let rejectForTimeout: ((reason: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectForTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectForTimeout?.(new Error(`${label} request timed out`));
    }, timeoutMs);

    try {
      const requestPromise = (async () => {
        const response = await fetch(input, { ...init, signal: controller.signal });
        const text = await response.text();
        return { response, text };
      })();

      return await Promise.race([
        requestPromise,
        timeoutPromise
      ]);
    } catch (error) {
      if (timedOut) {
        throw new GatewayTimeoutException(
          `${label}请求超过 ${timeoutMs} 毫秒，结果待确认，请勿重复提交。`
        );
      }

      throw new BadGatewayException(
        `${label}网络请求失败，结果待确认：${error instanceof Error ? error.message : "未知错误"}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private getProviderTimeoutMs() {
    const configured = Number(this.getConfigValue("PAYMENT_PROVIDER_TIMEOUT_MS") ?? 15_000);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 15_000;
  }

  private resolveCreatePaymentMode(
    provider: PaymentProvider,
    hasPayerIdentityHandle: boolean
  ): PaymentMode {
    const providerMode = this.resolveProviderConfigMode(provider);

    if (providerMode.simulated) {
      return providerMode;
    }

    if (hasPayerIdentityHandle) {
      return providerMode;
    }

    const identityName = "服务端付款身份句柄";

    if (providerMode.forcedReal) {
      throw new BadRequestException(`真实${providerLabels[provider]}缺少${identityName}。`);
    }

    return {
      simulated: true,
      forcedReal: false,
      requestedMode: providerMode.requestedMode,
      simulatedReason: `自动模拟回落模式：未获取到${identityName}，本次不会调用${providerLabels[provider]}真实扣款。`
    };
  }

  private resolveProviderConfigMode(provider: PaymentProvider): PaymentMode {
    const setting = this.resolvePaymentModeSetting();
    const missingKeys = this.getMissingProviderReadinessKeys(provider);

    if (setting.mode === "disabled") {
      throw new BadRequestException(
        "当前实例已关闭支付功能，不创建新的支付单或付款人身份授权。"
      );
    }

    if (setting.mode === "mock") {
      return {
        simulated: true,
        forcedReal: false,
        requestedMode: setting.mode,
        simulatedReason: "支付运行模式为强制模拟，本次不会调用微信或支付宝真实扣款。"
      };
    }

    if (setting.mode === "real" && missingKeys.length) {
      throw new BadRequestException(`真实${providerLabels[provider]}缺少配置：${missingKeys.join("、")}。`);
    }

    if (missingKeys.length) {
      return {
        simulated: true,
        forcedReal: false,
        requestedMode: setting.mode,
        simulatedReason: `自动模拟回落模式：${providerLabels[provider]}配置未完整设置（缺少 ${missingKeys.join("、")}），本次不会调用真实扣款。`
      };
    }

    return {
      simulated: false,
      forcedReal: setting.mode === "real",
      requestedMode: setting.mode
    };
  }

  private resolvePaymentModeSetting(): PaymentModeSetting {
    this.assertRuntimeDataPlanePaymentPolicy();
    const fullSimulationMode = resolveFullSimulationExternalMode("payment", {
      VM_DATA_PLANE: this.getConfigValue("VM_DATA_PLANE"),
      VM_SIMULATION_PROFILE: this.getConfigValue("VM_SIMULATION_PROFILE"),
      VM_FULL_SIMULATION_ENABLED: this.getConfigValue("VM_FULL_SIMULATION_ENABLED"),
      VM_FULL_SIMULATION_PAYMENT_MODE: this.getConfigValue("VM_FULL_SIMULATION_PAYMENT_MODE")
    });

    if (fullSimulationMode) {
      return {
        mode: fullSimulationMode,
        source: "VM_FULL_SIMULATION_PAYMENT_MODE"
      };
    }

    const paymentModeRaw = this.getConfigValue("PAYMENT_MODE")?.toLowerCase();

    if (paymentModeRaw) {
      if (["auto", "mock", "real", "disabled"].includes(paymentModeRaw)) {
        return {
          mode: paymentModeRaw as PaymentRuntimeMode,
          source: "PAYMENT_MODE",
          paymentModeRaw
        };
      }

      throw new BadRequestException(
        "PAYMENT_MODE 只能设置为 auto、mock、real 或 disabled。"
      );
    }

    const legacyPaymentMockEnabled = this.getConfigValue("PAYMENT_MOCK_ENABLED")?.toLowerCase();

    if (legacyPaymentMockEnabled && ["true", "1", "yes", "on"].includes(legacyPaymentMockEnabled)) {
      return {
        mode: "mock",
        source: "PAYMENT_MOCK_ENABLED",
        legacyPaymentMockEnabled
      };
    }

    if (legacyPaymentMockEnabled && ["false", "0", "no", "off"].includes(legacyPaymentMockEnabled)) {
      return {
        mode: "real",
        source: "PAYMENT_MOCK_ENABLED",
        legacyPaymentMockEnabled
      };
    }

    if (legacyPaymentMockEnabled) {
      throw new BadRequestException("PAYMENT_MOCK_ENABLED 只能设置为 true、false 或留空。");
    }

    return {
      mode: "auto",
      source: "default"
    };
  }

  /**
   * 预约取货模式保留历史订单的查询、核对和退款能力，但不允许产生新的用户付款。
   */
  private assertPaymentCreationEnabled() {
    if (
      isReservationOnlyPickup({
        VM_RESERVATION_ONLY_PICKUP: this.getConfigValue("VM_RESERVATION_ONLY_PICKUP")
      })
    ) {
      throw new BadRequestException("当前为预约取货模式，不创建新的支付单或付款人身份授权。");
    }

    if (this.resolvePaymentModeSetting().mode === "disabled") {
      throw new BadRequestException(
        "当前实例已关闭支付功能，不创建新的支付单或付款人身份授权。"
      );
    }
  }

  private isSimulatedPaymentOrder(order: PaymentOrderRecord) {
    return order.metadata?.simulated === true || order.invokePayload?.simulated === true;
  }

  private buildProviderDiagnostics(
    provider: PaymentProvider,
    setting: PaymentModeSetting
  ): PaymentProviderDiagnostics {
    const missingRequiredKeys =
      setting.mode === "disabled"
        ? []
        : this.getMissingProviderReadinessKeys(provider);
    const readyForRealPayment =
      setting.mode !== "disabled" && missingRequiredKeys.length === 0;
    const warnings: string[] = [];
    const blockers: string[] = [];
    let effectiveMode: PaymentEffectiveMode = "real";
    let simulatedReason: string | undefined;

    if (setting.mode === "disabled") {
      effectiveMode = "disabled";
    } else if (setting.mode === "mock") {
      effectiveMode = "mock";
      simulatedReason = "支付运行模式为强制模拟，本渠道不会发起真实扣款。";
    } else if (setting.mode === "auto" && !readyForRealPayment) {
      effectiveMode = "mock";
      simulatedReason = `${providerLabels[provider]}真实支付自检未通过，自动模式下会使用本地模拟支付。`;
    } else if (setting.mode === "real" && !readyForRealPayment) {
      blockers.push(`严格真实支付缺少配置：${missingRequiredKeys.join("、")}。`);
    }

    if (setting.mode === "auto" && readyForRealPayment) {
      warnings.push("配置自检通过；但前端未拿到付款人身份时，自动模式仍会回落到模拟支付。");
    }

    return {
      provider,
      label: providerLabels[provider],
      requestedMode: setting.mode,
      effectiveMode,
      readyForRealPayment,
      forcedReal: setting.mode === "real",
      mockPaymentEnabled: effectiveMode === "mock",
      missingRequiredKeys,
      blockers,
      warnings,
      simulatedReason
    };
  }

  private getMissingProviderReadinessKeys(provider: PaymentProvider) {
    const missingKeys: string[] = [...this.getMissingProviderOperationalSettings(provider)];

    if (provider === "wechat" && !this.getConfigValue("WECHAT_MINI_APP_SECRET")) {
      missingKeys.push("WECHAT_MINI_APP_SECRET");
    }

    return missingKeys;
  }

  private getMissingProviderOperationalSettings(provider: PaymentProvider) {
    const missingKeys: string[] = [...this.getMissingProviderSettings(provider)];
    const notifyKey = provider === "wechat" ? "WECHAT_PAY_NOTIFY_URL" : "ALIPAY_NOTIFY_URL";

    if (!this.getConfigValue(notifyKey) && !this.getConfigValue("PUBLIC_BASE_URL")) {
      missingKeys.push(`${notifyKey} 或 PUBLIC_BASE_URL`);
    }

    if (
      provider === "wechat" &&
      !this.getConfigValue("WECHAT_PAY_REFUND_NOTIFY_URL") &&
      !this.getConfigValue("PUBLIC_BASE_URL")
    ) {
      missingKeys.push("WECHAT_PAY_REFUND_NOTIFY_URL 或 PUBLIC_BASE_URL");
    }

    return missingKeys;
  }

  private getMissingProviderSettings(provider: PaymentProvider) {
    const keys = provider === "wechat" ? wechatRequiredPaymentKeys : alipayRequiredPaymentKeys;
    return keys.filter((key) => !this.getConfigValue(key));
  }

  private resolveWechatApiUrl(path: string) {
    const baseUrl = this.getConfigValue("WECHAT_PAY_API_BASE_URL") ?? "https://api.mch.weixin.qq.com";
    return new URL(path, baseUrl);
  }

  private resolveNotifyUrl(settingKey: string, fallbackPath: string) {
    const configured = this.getConfigValue(settingKey);

    if (configured) {
      return configured;
    }

    const publicBaseUrl = this.getConfigValue("PUBLIC_BASE_URL");

    if (!publicBaseUrl) {
      throw new BadRequestException(`真实支付需要配置 ${settingKey} 或 PUBLIC_BASE_URL。`);
    }

    return new URL(fallbackPath, publicBaseUrl).toString();
  }

  private requireConfig(key: string) {
    const value = this.getConfigValue(key);

    if (!value) {
      throw new BadRequestException(`支付配置缺少 ${key}。`);
    }

    return value;
  }

  private getConfigValue(key: string) {
    const value = this.configService.get<string>(key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private assertRuntimeDataPlanePaymentPolicy() {
    try {
      assertConfiguredRuntimeDataPlanePaymentPolicy({
        VM_DATA_PLANE: this.getConfigValue("VM_DATA_PLANE"),
        VM_DATA_ROOT: this.getConfigValue("VM_DATA_ROOT"),
        VM_DATA_PLANE_ID: this.getConfigValue("VM_DATA_PLANE_ID"),
        VM_SIMULATION_PROFILE: this.getConfigValue("VM_SIMULATION_PROFILE"),
        VM_FULL_SIMULATION_ENABLED: this.getConfigValue("VM_FULL_SIMULATION_ENABLED"),
        VM_FULL_SIMULATION_PAYMENT_MODE: this.getConfigValue("VM_FULL_SIMULATION_PAYMENT_MODE"),
        VM_RESERVATION_ONLY_PICKUP: this.getConfigValue(
          "VM_RESERVATION_ONLY_PICKUP"
        ),
        PAYMENT_MODE: this.getConfigValue("PAYMENT_MODE")
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "支付数据平面配置无效。"
      );
    }
  }

  private isLiveDataPlane() {
    const store = this.store as unknown as {
      isLiveDataPlane?: () => boolean;
    };

    if (typeof store.isLiveDataPlane === "function") {
      return store.isLiveDataPlane();
    }

    return this.getConfigValue("VM_DATA_PLANE")?.toLowerCase() === "live";
  }

  private normalizePem(value: string): string;
  private normalizePem(value: string | undefined): string | undefined;
  private normalizePem(value: string | undefined) {
    return value?.replace(/\\n/g, "\n");
  }

  private createPaymentNo(provider: PaymentProvider) {
    const prefix = provider === "wechat" ? "wx" : "ali";
    const separator = provider === "wechat" ? "-" : "_";
    return `${prefix}${separator}${Date.now().toString(36)}${separator}${randomBytes(4).toString("hex")}`;
  }

  private createProviderOrderId(order: PaymentOrderRecord) {
    return `${order.provider}-${order.paymentNo}`;
  }

  private createRefundNo(provider: PaymentProvider) {
    const prefix = provider === "wechat" ? "wxr" : "alir";
    const separator = provider === "wechat" ? "-" : "_";
    return `${prefix}${separator}${Date.now().toString(36)}${separator}${randomBytes(4).toString("hex")}`;
  }

  private findOrder(id: unknown) {
    const normalizedId = this.readString(id);
    if (!normalizedId) {
      throw new BadRequestException("支付单标识不能为空。");
    }

    const order = this.store.paymentOrders.find(
      (entry) =>
        entry.id === normalizedId ||
        entry.paymentNo === normalizedId ||
        entry.providerOrderId === normalizedId
    );

    if (!order) {
      throw new BadRequestException("未找到对应支付单。");
    }

    return order;
  }

  private toPaymentOrderRecoverySummary(
    order: PaymentOrderRecord
  ): PaymentOrderRecoverySummary {
    return {
      id: order.id,
      paymentNo: order.paymentNo,
      provider: order.provider,
      phase: order.phase,
      status: order.status,
      amount: order.amount,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
  }

  private findRefund(id: unknown) {
    const normalizedId = this.readString(id);
    if (!normalizedId) {
      throw new BadRequestException("退款单标识不能为空。");
    }

    const refund = this.store.paymentRefunds.find(
      (entry) =>
        entry.id === normalizedId ||
        entry.refundNo === normalizedId ||
        entry.providerRefundId === normalizedId
    );

    if (!refund) {
      throw new BadRequestException("未找到对应退款单。");
    }

    return refund;
  }

  private assertCanReadOrder(order: PaymentOrderRecord, actor?: Actor) {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (actor.role === "admin") {
      return;
    }

    if (actor.role === "merchant" && order.merchantUserId === actor.id) {
      return;
    }

    if (actor.role === "special" && order.payerUserId === actor.id) {
      return;
    }

    throw new ForbiddenException("当前账号无权访问该支付单。");
  }

  private assertCanManagePayment(order: PaymentOrderRecord, actor?: Actor) {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (actor.role === "admin") {
      return;
    }

    if (actor.role === "merchant" && order.merchantUserId === actor.id) {
      return;
    }

    throw new ForbiddenException("当前账号无权核对或关闭该支付单。");
  }

  private parseJsonObject(text: string, label: string) {
    try {
      const parsed = JSON.parse(text) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 供应商错误响应可能不是 JSON，统一走下方错误。
    }

    throw new BadRequestException(`${label}响应不是有效 JSON。`);
  }

  private extractProviderError(payload: Record<string, unknown>, rawText?: string) {
    const message =
      this.readString(payload.sub_msg) ??
      this.readString(payload.message) ??
      this.readString(payload.msg) ??
      this.readString(payload.errmsg) ??
      this.readString(payload.detail) ??
      this.readString(payload.code) ??
      this.readString(payload.errcode);

    if (message) {
      return message;
    }

    return rawText?.slice(0, 200) || "未知错误";
  }

  private summarizeProviderError(error: unknown) {
    const message = error instanceof Error ? error.message : "未知错误";
    return message.slice(0, 200);
  }

  private readProviderErrorCode(error: unknown) {
    if (
      !error ||
      typeof error !== "object" ||
      typeof (error as { getResponse?: unknown }).getResponse !== "function"
    ) {
      return undefined;
    }

    const response = (
      error as { getResponse(): unknown }
    ).getResponse();
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return undefined;
    }

    return this.readString(
      (response as { providerCode?: unknown }).providerCode
    )?.toUpperCase();
  }

  private formatYuan(amount: number) {
    return (amount / 100).toFixed(2);
  }

  private formatAlipayTimestamp(date: Date) {
    const pad = (value: number) => value.toString().padStart(2, "0");
    const shanghaiTime = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
    return `${shanghaiTime.getUTCFullYear()}-${pad(shanghaiTime.getUTCMonth() + 1)}-${pad(shanghaiTime.getUTCDate())} ${pad(shanghaiTime.getUTCHours())}:${pad(shanghaiTime.getUTCMinutes())}:${pad(shanghaiTime.getUTCSeconds())}`;
  }

  private readString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private assertRequestObject(value: unknown, label: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(`${label}必须是对象。`);
    }
  }

  private validatePaymentOrderCreatePayload(payload: PaymentOrderCreatePayload) {
    this.assertOnlyRequestKeys(
      payload,
      paymentOrderCreateKeys,
      "支付请求体"
    );
    this.assertOptionalText(payload.subject, "支付主题", 256);

    for (const [label, value] of [
      ["事件编号", payload.eventId],
      ["业务订单号", payload.orderNo],
      ["补扣订单号", payload.adjustmentOrderNo],
      ["柜机编号", payload.deviceCode],
      ["付款用户编号", payload.payerUserId],
      ["退款商家编号", payload.merchantUserId]
    ] as const) {
      this.assertOptionalText(value, label, 128);
    }

    this.assertOptionalText(payload.payerIdentityHandle, "付款身份句柄", 128);
    this.assertBoundedMetadata(payload.openRequest, "开柜上下文", 20_000);
    this.assertBoundedMetadata(payload.intentItems, "支付意向商品", 50_000);
  }

  private assertOnlyRequestKeys(
    value: object,
    allowedKeys: ReadonlySet<string>,
    label: string
  ) {
    const unsupported = Object.keys(value).filter(
      (key) => !allowedKeys.has(key)
    );

    if (unsupported.length) {
      throw new BadRequestException(
        `${label}包含不支持的字段：${unsupported.join("、")}。`
      );
    }
  }

  private assertOptionalText(
    value: unknown,
    label: string,
    maxLength: number
  ) {
    if (value === undefined) {
      return;
    }

    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestException(`${label}必须是非空字符串。`);
    }

    if (value.length > maxLength) {
      throw new BadRequestException(`${label}最多 ${maxLength} 个字符。`);
    }
  }

  private assertRequiredText(
    value: unknown,
    label: string,
    maxLength: number
  ) {
    if (value === undefined) {
      throw new BadRequestException(`${label}必须明确提供。`);
    }

    this.assertOptionalText(value, label, maxLength);
  }

  private assertBoundedMetadata(
    value: unknown,
    label: string,
    maxLength: number
  ) {
    if (value === undefined) {
      return;
    }

    let serialized: string;

    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new BadRequestException(`${label}不是有效的 JSON 数据。`);
    }

    if (!serialized || serialized.length > maxLength) {
      throw new BadRequestException(
        `${label}内容过大，最多允许 ${maxLength} 个字符。`
      );
    }
  }

  private readAmount(value: unknown): number | undefined {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    }

    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const numberValue = Number(value.trim());
      return Number.isSafeInteger(numberValue) ? numberValue : undefined;
    }

    if (value && typeof value === "object") {
      const total = (value as { total?: unknown }).total;
      return this.readAmount(total);
    }

    return undefined;
  }

  private readYuanAmount(value: unknown): number | undefined {
    const text =
      typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : typeof value === "string"
          ? value.trim()
          : "";

    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
      return undefined;
    }

    const [yuanText, fractionText = ""] = text.split(".");
    const yuan = Number(yuanText);
    const fraction = Number(fractionText.padEnd(2, "0"));
    const amount = yuan * 100 + fraction;
    return Number.isSafeInteger(amount) ? amount : undefined;
  }

  private readWechatRefundAmount(value: unknown) {
    if (value && typeof value === "object") {
      const refund = (value as { refund?: unknown }).refund;
      return this.readAmount(refund);
    }

    return this.readAmount(value);
  }

  private readWechatRefundTotal(value: unknown) {
    if (value && typeof value === "object") {
      return this.readAmount((value as { total?: unknown }).total);
    }

    return undefined;
  }
}
