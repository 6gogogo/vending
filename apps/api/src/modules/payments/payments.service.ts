import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";

import type {
  CabinetEventRecord,
  PaymentOrderCreatePayload,
  PaymentOrderCreateResult,
  PaymentOrderRecord,
  PaymentPayerIdentityPayload,
  PaymentPayerIdentityResult,
  PaymentProvider,
  PaymentRefundRecord,
  PaymentRefundStatus,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { CabinetEventsService } from "../cabinet-events/cabinet-events.service";
import { InventoryOrdersService } from "../inventory-orders/inventory-orders.service";

type Actor = { id: string; role: UserRole } | undefined;
type MockSetting = "auto" | "mock" | "real";

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
  simulatedReason?: string;
}

interface ProviderOrderResult {
  providerOrderId: string;
  invokePayload: Record<string, unknown>;
  providerResponse?: unknown;
}

interface ProviderRefundResult {
  providerRefundId?: string;
  status: PaymentRefundStatus;
  callbackPayload?: unknown;
  failReason?: string;
}

interface WechatRefundCallbackPayload {
  paymentNo: string;
  refundNo: string;
  providerRefundId?: string;
  status: PaymentRefundStatus;
  amount?: number;
  callbackPayload: unknown;
  failReason?: string;
}

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
  "WECHAT_PAY_PLATFORM_PUBLIC_KEY"
] as const;

const alipayRequiredPaymentKeys = [
  "ALIPAY_APP_ID",
  "ALIPAY_APP_PRIVATE_KEY",
  "ALIPAY_PUBLIC_KEY"
] as const;

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(CabinetEventsService) private readonly cabinetEventsService: CabinetEventsService,
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService
  ) {}

  async createOrder(
    payload: PaymentOrderCreatePayload,
    actor?: Actor
  ): Promise<PaymentOrderCreateResult> {
    const event = this.resolveEvent(payload);
    const adjustment = event && payload.adjustmentOrderNo
      ? event.adjustments?.find((entry) => entry.orderNo === payload.adjustmentOrderNo)
      : undefined;
    const amount = this.resolveAmount(payload, event, adjustment?.amount);

    if (amount <= 0) {
      throw new BadRequestException("支付金额必须大于 0。");
    }

    if (actor?.role !== "admin") {
      const payerUserId = payload.payerUserId ?? event?.userId;
      const merchantUserId = payload.merchantUserId;

      if (actor?.role === "special" && payerUserId && payerUserId !== actor.id) {
        throw new ForbiddenException("不能为其他用户创建支付单。");
      }

      if (actor?.role === "merchant" && merchantUserId && merchantUserId !== actor.id) {
        throw new ForbiddenException("不能为其他商家的业务创建支付单。");
      }
    }

    const paymentMode = this.resolveCreatePaymentMode(payload.provider, payload);
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
      subject: payload.subject ?? this.buildSubject(payload, event),
      eventId: payload.eventId ?? event?.eventId,
      orderNo: payload.orderNo ?? event?.orderNo,
      adjustmentOrderNo: payload.adjustmentOrderNo,
      deviceCode: payload.deviceCode ?? event?.deviceCode,
      payerUserId: payload.payerUserId ?? event?.userId,
      merchantUserId: payload.merchantUserId,
      metadata: {
        openRequest: payload.openRequest,
        intentItems: payload.intentItems,
        payerOpenId: payload.payerOpenId,
        payerAlipayUserId: payload.payerAlipayUserId,
        simulated: paymentMode.simulated,
        simulatedReason: paymentMode.simulatedReason
      },
      createdAt: now,
      updatedAt: now
    };

    if (paymentMode.simulated) {
      order.providerOrderId = this.createProviderOrderId(order);
      order.invokePayload = this.buildMockInvokePayload(order, paymentMode.simulatedReason);
    } else {
      const providerOrder = await this.createProviderPaymentOrder(order, payload);
      order.providerOrderId = providerOrder.providerOrderId;
      order.invokePayload = providerOrder.invokePayload;
      order.metadata = {
        ...(order.metadata ?? {}),
        providerResponse: providerOrder.providerResponse
      };
    }

    this.store.paymentOrders.unshift(order);

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

    return {
      order,
      invokePayload: order.invokePayload
    };
  }

  async resolvePayerIdentity(
    payload: PaymentPayerIdentityPayload,
    actor?: Actor
  ): Promise<PaymentPayerIdentityResult> {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (payload.provider !== "wechat" && payload.provider !== "alipay") {
      throw new BadRequestException("不支持的支付方式。");
    }

    if (payload.provider === "wechat") {
      return this.resolveWechatPayerIdentity(payload.authCode);
    }

    return this.resolveAlipayPayerIdentity(payload.authCode);
  }

  detail(id: string, actor?: Actor) {
    const order = this.findOrder(id);
    this.assertCanReadOrder(order, actor);
    return order;
  }

  async markMockPaid(id: string, actor?: Actor) {
    const order = this.findOrder(id);
    this.assertCanReadOrder(order, actor);

    if (!this.isMockPaymentEnabled(order.provider)) {
      throw new BadRequestException("当前环境未启用模拟支付完成接口。");
    }

    return this.markPaid({
      provider: order.provider,
      paymentNo: order.paymentNo,
      providerTransactionId: `${order.provider}-mock-${Date.now().toString(36)}`,
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
    this.markRefundFromProvider(payload);
  }

  async refund(
    payload: {
      paymentOrderId: string;
      amount?: number;
      reason?: string;
    },
    actor?: Actor
  ) {
    const order = this.findOrder(payload.paymentOrderId);

    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (actor.role !== "admin" && order.merchantUserId !== actor.id) {
      throw new ForbiddenException("当前账号无权退款该支付单。");
    }

    if (order.status !== "paid") {
      throw new BadRequestException("只有已支付的订单可以退款。");
    }

    const amount = Math.max(1, Math.min(payload.amount ?? order.amount, order.amount));
    const now = new Date().toISOString();
    const refundNo = this.createRefundNo(order.provider);
    const providerRefund = this.isMockPaymentEnabled(order.provider)
      ? {
          providerRefundId: `${order.provider}-refund-${Date.now().toString(36)}`,
          status: "success" as const,
          callbackPayload: {
            mock: true,
            actor
          }
        }
      : await this.createProviderRefund(order, amount, refundNo, payload.reason);
    const refund: PaymentRefundRecord = {
      id: this.store.createId("payment-refund"),
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo,
      provider: order.provider,
      status: providerRefund.status,
      amount,
      reason: payload.reason,
      providerRefundId: providerRefund.providerRefundId,
      callbackPayload: providerRefund.callbackPayload,
      createdAt: now,
      updatedAt: now,
      refundedAt: providerRefund.status === "success" ? now : undefined,
      failReason: providerRefund.failReason
    };

    this.store.paymentRefunds.unshift(refund);

    if (refund.status === "success") {
      this.applyRefundSuccess(order, refund);
    } else {
      order.refundNo = refund.refundNo;
      order.updatedAt = now;
    }

    this.store.logOperation({
      category: "inventory",
      type: "payment-refund",
      status: refund.status === "failed" ? "failed" : refund.status === "pending" ? "pending" : "success",
      actor: {
        type: actor.role,
        id: actor.id,
        name: this.store.users.find((entry) => entry.id === actor.id)?.name ?? actor.id,
        role: actor.role
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

  private async createProviderPaymentOrder(
    order: PaymentOrderRecord,
    payload: PaymentOrderCreatePayload
  ): Promise<ProviderOrderResult> {
    if (order.provider === "wechat") {
      return this.createWechatPrepayOrder(order, payload);
    }

    return this.createAlipayTradeOrder(order, payload);
  }

  private async createWechatPrepayOrder(
    order: PaymentOrderRecord,
    payload: PaymentOrderCreatePayload
  ): Promise<ProviderOrderResult> {
    const payerOpenId = this.readString(payload.payerOpenId);

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
      providerResponse: response
    };
  }

  private async createAlipayTradeOrder(
    order: PaymentOrderRecord,
    payload: PaymentOrderCreatePayload
  ): Promise<ProviderOrderResult> {
    const payerAlipayUserId = this.readString(payload.payerAlipayUserId);

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
    const sellerId = this.getConfigValue("ALIPAY_SELLER_ID");

    if (sellerId) {
      bizContent.seller_id = sellerId;
    }

    const response = await this.callAlipayGateway("alipay.trade.create", {
      notify_url: this.resolveNotifyUrl("ALIPAY_NOTIFY_URL", "/api/payments/callbacks/alipay"),
      biz_content: JSON.stringify(bizContent)
    });
    const tradeNo = this.readString(response.trade_no);

    if (!tradeNo) {
      throw new BadRequestException("支付宝创建交易成功但未返回 trade_no。");
    }

    return {
      providerOrderId: tradeNo,
      invokePayload: {
        provider: "alipay",
        tradeNO: tradeNo,
        orderStr: tradeNo,
        simulated: false
      },
      providerResponse: response
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
      body.reason = reason.slice(0, 80);
    }

    const notifyUrl = this.resolveOptionalNotifyUrl(
      "WECHAT_PAY_REFUND_NOTIFY_URL",
      "/api/payments/callbacks/wechat-refund"
    );

    if (notifyUrl) {
      body.notify_url = notifyUrl;
    }

    const response = await this.callWechatApi<{
      refund_id?: string;
      status?: string;
      out_refund_no?: string;
    }>("POST", "/v3/refund/domestic/refunds", body);
    const wechatStatus = this.readString(response.status);

    return {
      providerRefundId: this.readString(response.refund_id) ?? this.readString(response.out_refund_no),
      status: wechatStatus === "SUCCESS" ? "success" : wechatStatus === "PROCESSING" ? "pending" : "failed",
      callbackPayload: response,
      failReason: wechatStatus && wechatStatus !== "SUCCESS" && wechatStatus !== "PROCESSING"
        ? `微信退款状态：${wechatStatus}`
        : undefined
    };
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

    return {
      providerRefundId: this.readString(response.trade_no) ?? refundNo,
      status: "success",
      callbackPayload: response
    };
  }

  private async resolveWechatPayerIdentity(authCode?: string): Promise<PaymentPayerIdentityResult> {
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
        simulatedReason: "未配置 WECHAT_MINI_APP_SECRET，自动切换模拟支付。"
      };
    }

    if (!authCode) {
      if (providerMode.forcedReal) {
        throw new BadRequestException("真实微信支付需要前端传入微信登录 code。");
      }

      return {
        provider: "wechat",
        simulated: true,
        simulatedReason: "未获取到微信登录 code，自动切换模拟支付。"
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

    return {
      provider: "wechat",
      simulated: false,
      payerOpenId: openId
    };
  }

  private async resolveAlipayPayerIdentity(authCode?: string): Promise<PaymentPayerIdentityResult> {
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
        simulatedReason: "未获取到支付宝授权码，自动切换模拟支付。"
      };
    }

    const response = await this.callAlipayGateway("alipay.system.oauth.token", {
      grant_type: "authorization_code",
      code: authCode
    });
    const userId = this.readString(response.user_id) ?? this.readString(response.open_id);

    if (!userId) {
      throw new BadRequestException("支付宝授权成功但未返回 user_id。");
    }

    return {
      provider: "alipay",
      simulated: false,
      payerAlipayUserId: userId
    };
  }

  private async markPaid(payload: ProviderPaidPayload) {
    const order = this.store.paymentOrders.find(
      (entry) => entry.provider === payload.provider && entry.paymentNo === payload.paymentNo
    );

    if (!order) {
      throw new BadRequestException("未找到对应支付单。");
    }

    if (payload.amount !== undefined && payload.amount !== order.amount) {
      throw new BadRequestException("支付回调金额与本地支付单不一致。");
    }

    if (order.status === "paid" || order.status === "refunded") {
      return order;
    }

    const now = new Date().toISOString();
    order.status = "paid";
    order.providerTransactionId = payload.providerTransactionId;
    order.callbackPayload = payload.callbackPayload;
    order.paidAt = now;
    order.updatedAt = now;

    await this.forwardPaymentSuccessToSmartVm(order);

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

    return order;
  }

  private markRefundFromProvider(payload: WechatRefundCallbackPayload) {
    const refund = this.store.paymentRefunds.find(
      (entry) => entry.provider === "wechat" && entry.refundNo === payload.refundNo
    );

    if (!refund) {
      throw new BadRequestException("未找到对应退款单。");
    }

    if (payload.amount !== undefined && payload.amount !== refund.amount) {
      throw new BadRequestException("退款回调金额与本地退款单不一致。");
    }

    const order = this.findOrder(refund.paymentOrderId);
    const now = new Date().toISOString();
    refund.providerRefundId = payload.providerRefundId ?? refund.providerRefundId;
    refund.callbackPayload = payload.callbackPayload;
    refund.status = payload.status;
    refund.failReason = payload.failReason;
    refund.updatedAt = now;

    if (payload.status === "success") {
      this.applyRefundSuccess(order, refund);
    }
  }

  private applyRefundSuccess(order: PaymentOrderRecord, refund: PaymentRefundRecord) {
    const alreadyRefunded = refund.status === "success" && Boolean(refund.refundedAt);
    const now = new Date().toISOString();

    refund.status = "success";
    refund.refundedAt = refund.refundedAt ?? now;
    refund.updatedAt = now;
    order.status = refund.amount >= order.amount ? "refunded" : order.status;
    order.refundNo = refund.refundNo;
    order.updatedAt = now;

    if (!alreadyRefunded && order.orderNo && order.deviceCode) {
      this.inventoryOrdersService.markRefund(
        order.adjustmentOrderNo ?? order.orderNo,
        refund.providerRefundId ?? refund.refundNo,
        refund.amount,
        {
          source: "manual",
          refundNo: refund.refundNo
        }
      );
    }
  }

  private async forwardPaymentSuccessToSmartVm(order: PaymentOrderRecord) {
    if (!order.orderNo || !order.eventId || !order.deviceCode) {
      return;
    }

    try {
      await this.cabinetEventsService.notifyPaymentSuccess({
        orderNo: order.adjustmentOrderNo ?? order.orderNo,
        eventId: order.eventId,
        transactionId: order.providerTransactionId ?? order.providerOrderId ?? order.paymentNo,
        deviceCode: order.deviceCode,
        amount: order.amount
      });
    } catch (error) {
      order.metadata = {
        ...(order.metadata ?? {}),
        smartVmForwardError: error instanceof Error ? error.message : "回写柜机平台失败"
      };
    }
  }

  private parseWechatPaidPayload(
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    rawBody?: string
  ): ProviderPaidPayload {
    const mockPaymentNo = this.readString(body.paymentNo) ?? this.readString(body.out_trade_no);

    if (mockPaymentNo && this.isMockPaymentEnabled("wechat")) {
      return {
        provider: "wechat",
        paymentNo: mockPaymentNo,
        providerTransactionId: this.readString(body.transaction_id) ?? this.readString(body.transactionId),
        amount: this.readAmount(body.amount),
        callbackPayload: body
      };
    }

    this.verifyWechatSignature(headers, rawBody ?? JSON.stringify(body));
    const resource = body.resource as Record<string, unknown> | undefined;
    const decrypted = resource ? this.decryptWechatResource(resource) : body;
    const tradeState = this.readString(decrypted.trade_state);

    if (tradeState && tradeState !== "SUCCESS") {
      throw new BadRequestException(`微信支付状态不是 SUCCESS：${tradeState}`);
    }

    const paymentNo = this.readString(decrypted.out_trade_no);

    if (!paymentNo) {
      throw new BadRequestException("微信回调缺少 out_trade_no。");
    }

    return {
      provider: "wechat",
      paymentNo,
      providerTransactionId: this.readString(decrypted.transaction_id),
      amount: this.readAmount(decrypted.amount),
      callbackPayload: body
    };
  }

  private parseWechatRefundPayload(
    body: Record<string, unknown>,
    headers: Record<string, string | undefined>,
    rawBody?: string
  ): WechatRefundCallbackPayload {
    this.verifyWechatSignature(headers, rawBody ?? JSON.stringify(body));
    const resource = body.resource as Record<string, unknown> | undefined;
    const decrypted = resource ? this.decryptWechatResource(resource) : body;
    const paymentNo = this.readString(decrypted.out_trade_no);
    const refundNo = this.readString(decrypted.out_refund_no);
    const refundStatus = this.readString(decrypted.refund_status);

    if (!paymentNo || !refundNo) {
      throw new BadRequestException("微信退款回调缺少 out_trade_no 或 out_refund_no。");
    }

    return {
      paymentNo,
      refundNo,
      providerRefundId: this.readString(decrypted.refund_id),
      status: refundStatus === "SUCCESS" ? "success" : refundStatus === "ABNORMAL" ? "failed" : "pending",
      amount: this.readWechatRefundAmount(decrypted.amount),
      callbackPayload: body,
      failReason: refundStatus && refundStatus !== "SUCCESS" ? `微信退款状态：${refundStatus}` : undefined
    };
  }

  private parseAlipayPaidPayload(body: Record<string, unknown>): ProviderPaidPayload {
    if (!this.isMockPaymentEnabled("alipay")) {
      this.verifyAlipaySignature(body);
    }

    const status = this.readString(body.trade_status);

    if (status && status !== "TRADE_SUCCESS" && status !== "TRADE_FINISHED") {
      throw new BadRequestException(`支付宝交易状态不是成功：${status}`);
    }

    const paymentNo = this.readString(body.out_trade_no) ?? this.readString(body.paymentNo);

    if (!paymentNo) {
      throw new BadRequestException("支付宝回调缺少 out_trade_no。");
    }

    return {
      provider: "alipay",
      paymentNo,
      providerTransactionId: this.readString(body.trade_no) ?? this.readString(body.transactionId),
      amount: this.readAmount(body.total_amount),
      callbackPayload: body
    };
  }

  private verifyWechatSignature(headers: Record<string, string | undefined>, rawBody: string) {
    const publicKey = this.normalizePem(this.getConfigValue("WECHAT_PAY_PLATFORM_PUBLIC_KEY"));

    if (!publicKey) {
      if (this.isMockPaymentEnabled("wechat")) {
        return;
      }

      throw new BadRequestException("微信支付平台公钥未配置，无法验签。");
    }

    const signature = headers["wechatpay-signature"];
    const timestamp = headers["wechatpay-timestamp"];
    const nonce = headers["wechatpay-nonce"];

    if (!signature || !timestamp || !nonce) {
      throw new BadRequestException("微信支付回调缺少验签请求头。");
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8");
    verifier.end();

    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadRequestException("微信支付回调验签失败。");
    }
  }

  private verifyAlipaySignature(body: Record<string, unknown>) {
    const publicKey = this.normalizePem(this.getConfigValue("ALIPAY_PUBLIC_KEY"));

    if (!publicKey) {
      if (this.isMockPaymentEnabled("alipay")) {
        return;
      }

      throw new BadRequestException("支付宝公钥未配置，无法验签。");
    }

    const signature = this.readString(body.sign);

    if (!signature) {
      throw new BadRequestException("支付宝回调缺少 sign。");
    }

    const unsigned = Object.entries(body)
      .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== undefined && value !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("&");

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

  private resolveAmount(
    payload: PaymentOrderCreatePayload,
    event?: CabinetEventRecord,
    adjustmentAmount?: number
  ) {
    if (payload.amount !== undefined) {
      return Math.round(payload.amount);
    }

    if (adjustmentAmount !== undefined) {
      return Math.round(adjustmentAmount);
    }

    if (payload.phase === "post_settlement" && event) {
      return Math.round(event.amount);
    }

    return Math.round(
      (payload.intentItems ?? []).reduce((sum, item) => {
        const catalogItem = this.store.goodsCatalog.find((entry) => entry.goodsId === item.goodsId);
        return sum + (item.unitPrice ?? catalogItem?.price ?? 0) * item.quantity;
      }, 0)
    );
  }

  private buildSubject(payload: PaymentOrderCreatePayload, event?: CabinetEventRecord) {
    if (payload.phase === "pre_open") {
      return `柜机开门预支付 ${payload.deviceCode ?? event?.deviceCode ?? ""}`.trim();
    }

    return `柜机结算支付 ${event?.orderNo ?? payload.orderNo ?? ""}`.trim();
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
    method: "POST",
    path: string,
    bodyObject: Record<string, unknown>
  ): Promise<T> {
    const url = this.resolveWechatApiUrl(path);
    const body = JSON.stringify(bodyObject);
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        Authorization: this.createWechatAuthorization(method, url, body),
        "Content-Type": "application/json"
      },
      body
    });
    const text = await response.text();
    const data = text ? this.parseJsonObject(text, providerLabels.wechat) : {};

    if (!response.ok) {
      throw new BadRequestException(`微信支付接口调用失败：${this.extractProviderError(data, text)}`);
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

    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: new URLSearchParams(params).toString()
    });
    const text = await response.text();
    const data = this.parseJsonObject(text, providerLabels.alipay);

    if (!response.ok) {
      throw new BadRequestException(`支付宝接口调用失败：${this.extractProviderError(data, text)}`);
    }

    const responseKey = `${method.replace(/\./g, "_")}_response`;
    const gatewayResponse = data[responseKey];

    if (!gatewayResponse || typeof gatewayResponse !== "object" || Array.isArray(gatewayResponse)) {
      throw new BadRequestException("支付宝接口响应格式不正确。");
    }

    const payload = gatewayResponse as Record<string, unknown>;
    const code = this.readString(payload.code);

    if (code !== "10000") {
      throw new BadRequestException(`支付宝接口调用失败：${this.extractProviderError(payload, text)}`);
    }

    return payload;
  }

  private signAlipayParams(params: Record<string, string>) {
    const privateKey = this.normalizePem(this.requireConfig("ALIPAY_APP_PRIVATE_KEY"));
    const unsigned = Object.entries(params)
      .filter(([key, value]) => key !== "sign" && value !== undefined && value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned, "utf8");
    signer.end();
    return signer.sign(privateKey, "base64");
  }

  private async callJsonEndpoint(url: string, label: string) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });
    const text = await response.text();
    const data = this.parseJsonObject(text, label);

    if (!response.ok) {
      throw new BadRequestException(`${label}失败：${this.extractProviderError(data, text)}`);
    }

    return data;
  }

  private resolveCreatePaymentMode(
    provider: PaymentProvider,
    payload: PaymentOrderCreatePayload
  ): PaymentMode {
    const providerMode = this.resolveProviderConfigMode(provider);

    if (providerMode.simulated) {
      return providerMode;
    }

    const missingIdentity =
      provider === "wechat"
        ? !this.readString(payload.payerOpenId)
        : !this.readString(payload.payerAlipayUserId);

    if (!missingIdentity) {
      return providerMode;
    }

    const identityName = provider === "wechat" ? "付款用户 openid" : "付款用户支付宝 user_id";

    if (providerMode.forcedReal) {
      throw new BadRequestException(`真实${providerLabels[provider]}缺少${identityName}。`);
    }

    return {
      simulated: true,
      forcedReal: false,
      simulatedReason: `未获取到${identityName}，自动切换模拟支付。`
    };
  }

  private resolveProviderConfigMode(provider: PaymentProvider): PaymentMode {
    const setting = this.getMockSetting();
    const missingKeys = this.getMissingProviderSettings(provider);

    if (setting === "mock") {
      return {
        simulated: true,
        forcedReal: false,
        simulatedReason: "后台已启用本地模拟支付。"
      };
    }

    if (setting === "real" && missingKeys.length) {
      throw new BadRequestException(`真实${providerLabels[provider]}缺少配置：${missingKeys.join("、")}。`);
    }

    if (missingKeys.length) {
      return {
        simulated: true,
        forcedReal: false,
        simulatedReason: `${providerLabels[provider]}配置未完整设置（缺少 ${missingKeys.join("、")}），自动切换模拟支付。`
      };
    }

    return {
      simulated: false,
      forcedReal: setting === "real"
    };
  }

  private getMockSetting(): MockSetting {
    const explicit = this.getConfigValue("PAYMENT_MOCK_ENABLED")?.toLowerCase();

    if (explicit && ["true", "1", "yes", "on"].includes(explicit)) {
      return "mock";
    }

    if (explicit && ["false", "0", "no", "off"].includes(explicit)) {
      return "real";
    }

    return "auto";
  }

  private isMockPaymentEnabled(provider: PaymentProvider) {
    const setting = this.getMockSetting();

    if (setting === "mock") {
      return true;
    }

    if (setting === "real") {
      return false;
    }

    return this.getMissingProviderSettings(provider).length > 0;
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

  private resolveOptionalNotifyUrl(settingKey: string, fallbackPath: string) {
    try {
      return this.resolveNotifyUrl(settingKey, fallbackPath);
    } catch {
      return undefined;
    }
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

  private normalizePem(value: string): string;
  private normalizePem(value: string | undefined): string | undefined;
  private normalizePem(value: string | undefined) {
    return value?.replace(/\\n/g, "\n");
  }

  private createPaymentNo(provider: PaymentProvider) {
    return `${provider === "wechat" ? "wx" : "ali"}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  private createProviderOrderId(order: PaymentOrderRecord) {
    return `${order.provider}-${order.paymentNo}`;
  }

  private createRefundNo(provider: PaymentProvider) {
    return `${provider === "wechat" ? "wxr" : "alir"}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  private findOrder(id: string) {
    const order = this.store.paymentOrders.find(
      (entry) => entry.id === id || entry.paymentNo === id || entry.providerOrderId === id
    );

    if (!order) {
      throw new BadRequestException("未找到对应支付单。");
    }

    return order;
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

  private formatYuan(amount: number) {
    return (amount / 100).toFixed(2);
  }

  private formatAlipayTimestamp(date: Date) {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  private readString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readAmount(value: unknown): number | undefined {
    if (typeof value === "number") {
      return Math.round(value);
    }

    if (typeof value === "string" && value.trim()) {
      const numberValue = Number(value);

      if (!Number.isNaN(numberValue)) {
        return value.includes(".") ? Math.round(numberValue * 100) : Math.round(numberValue);
      }
    }

    if (value && typeof value === "object") {
      const total = (value as { total?: unknown }).total;
      return this.readAmount(total);
    }

    return undefined;
  }

  private readWechatRefundAmount(value: unknown) {
    if (value && typeof value === "object") {
      const refund = (value as { refund?: unknown }).refund;
      return this.readAmount(refund);
    }

    return this.readAmount(value);
  }
}
