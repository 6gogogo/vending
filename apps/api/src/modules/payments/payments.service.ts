import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";

import type {
  CabinetEventRecord,
  PaymentOrderCreatePayload,
  PaymentOrderCreateResult,
  PaymentOrderRecord,
  PaymentProvider,
  PaymentRefundRecord,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { CabinetEventsService } from "../cabinet-events/cabinet-events.service";
import { InventoryOrdersService } from "../inventory-orders/inventory-orders.service";

type Actor = { id: string; role: UserRole } | undefined;

interface ProviderPaidPayload {
  provider: PaymentProvider;
  paymentNo: string;
  providerTransactionId?: string;
  amount?: number;
  callbackPayload?: unknown;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(CabinetEventsService) private readonly cabinetEventsService: CabinetEventsService,
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService
  ) {}

  createOrder(payload: PaymentOrderCreatePayload, actor?: Actor): PaymentOrderCreateResult {
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
        intentItems: payload.intentItems
      },
      createdAt: now,
      updatedAt: now
    };

    order.providerOrderId = this.createProviderOrderId(order);
    order.invokePayload = this.buildInvokePayload(order);
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
        undoState: "not_undoable"
      }
    });

    return {
      order,
      invokePayload: order.invokePayload
    };
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
    const refund: PaymentRefundRecord = {
      id: this.store.createId("payment-refund"),
      paymentOrderId: order.id,
      paymentNo: order.paymentNo,
      refundNo: this.createRefundNo(order.provider),
      provider: order.provider,
      status: "success",
      amount,
      reason: payload.reason,
      providerRefundId: `${order.provider}-refund-${Date.now().toString(36)}`,
      createdAt: now,
      updatedAt: now,
      refundedAt: now
    };

    this.store.paymentRefunds.unshift(refund);
    order.status = amount >= order.amount ? "refunded" : order.status;
    order.refundNo = refund.refundNo;
    order.updatedAt = now;

    if (order.orderNo && order.deviceCode) {
      this.inventoryOrdersService.markRefund(
        order.adjustmentOrderNo ?? order.orderNo,
        refund.providerRefundId ?? refund.refundNo,
        amount,
        {
          source: "manual",
          refundNo: refund.refundNo
        }
      );
    }

    this.store.logOperation({
      category: "inventory",
      type: "payment-refund",
      status: "success",
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
        amount,
        undoState: "not_undoable"
      }
    });

    return refund;
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
    const publicKey = this.configService.get<string>("WECHAT_PAY_PLATFORM_PUBLIC_KEY")?.trim();

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
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
    verifier.end();

    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadRequestException("微信支付回调验签失败。");
    }
  }

  private verifyAlipaySignature(body: Record<string, unknown>) {
    const publicKey = this.configService.get<string>("ALIPAY_PUBLIC_KEY")?.trim();

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
    verifier.update(unsigned);
    verifier.end();

    if (!verifier.verify(publicKey, signature, "base64")) {
      throw new BadRequestException("支付宝回调验签失败。");
    }
  }

  private decryptWechatResource(resource: Record<string, unknown>) {
    const apiV3Key = this.configService.get<string>("WECHAT_PAY_API_V3_KEY")?.trim();

    if (!apiV3Key) {
      throw new BadRequestException("微信支付 API v3 密钥未配置，无法解密回调。");
    }

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

  private buildInvokePayload(order: PaymentOrderRecord) {
    if (order.provider === "wechat") {
      const appId = this.configService.get<string>("WECHAT_PAY_APP_ID") ?? "";
      const timeStamp = Math.floor(Date.now() / 1000).toString();
      const nonceStr = randomBytes(16).toString("hex");
      const packageValue = `prepay_id=${order.providerOrderId}`;
      const signType = "RSA";

      return {
        provider: "wechat",
        appId,
        timeStamp,
        nonceStr,
        package: packageValue,
        signType,
        paySign: this.signWechatInvokePayload(appId, timeStamp, nonceStr, packageValue),
        simulated: this.isMockPaymentEnabled("wechat")
      };
    }

    return {
      provider: "alipay",
      tradeNO: order.providerOrderId,
      orderStr: order.providerOrderId,
      simulated: this.isMockPaymentEnabled("alipay")
    };
  }

  private signWechatInvokePayload(appId: string, timeStamp: string, nonceStr: string, packageValue: string) {
    const privateKey = this.configService.get<string>("WECHAT_PAY_MERCHANT_PRIVATE_KEY")?.trim();

    if (!privateKey) {
      return `mock-${nonceStr}`;
    }

    const signer = createSign("RSA-SHA256");
    signer.update(`${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`);
    signer.end();
    return signer.sign(privateKey, "base64");
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

  private isMockPaymentEnabled(provider: PaymentProvider) {
    const explicit = this.configService.get<string>("PAYMENT_MOCK_ENABLED")?.trim().toLowerCase();

    if (explicit) {
      return explicit === "true" || explicit === "1" || explicit === "yes" || explicit === "on";
    }

    if (provider === "wechat") {
      return !this.configService.get<string>("WECHAT_PAY_MCH_ID");
    }

    return !this.configService.get<string>("ALIPAY_APP_ID");
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
}
