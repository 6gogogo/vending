import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  CabinetEventRecord,
  CabinetIntentItem,
  CabinetOpenPreviewResult,
  CabinetOpenRequest,
  CabinetPreSettlement,
  CabinetPreSettlementItem,
  CabinetSettlementComparison,
  CabinetSettlementComparisonItem,
  GoodsCategory,
  SmartVmAdjustmentPayload,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AccessRulesService } from "../access-rules/access-rules.service";
import { AlertsService } from "../alerts/alerts.service";
import { SmartVmGateway } from "../devices/smartvm.gateway";
import { InventoryOrdersService } from "../inventory-orders/inventory-orders.service";
import { ReservationsService } from "../reservations/reservations.service";

type CallbackBilling = Pick<
  CabinetPreSettlement,
  "totalQuantity" | "freeQuantity" | "paidQuantity" | "originalAmount" | "freeAmount" | "payableAmount"
> & {
  platformAmount: number;
  items: CabinetPreSettlementItem[];
};

@Injectable()
export class CabinetEventsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway,
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService,
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(ReservationsService) private readonly reservationsService: ReservationsService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  previewOpenSettlement(payload: CabinetOpenRequest): CabinetOpenPreviewResult {
    const { user, quotaSummary, intentItems, preSettlement, doorNum } = this.prepareOpenContext(payload);

    return {
      deviceCode: payload.deviceCode,
      doorNum,
      role: user.role,
      remainingQuota: quotaSummary?.remainingToday,
      acceptedIntentItems: intentItems.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity
      })),
      preSettlement
    };
  }

  async openCabinet(payload: CabinetOpenRequest) {
    const { user, quotaSummary, intentItems, preSettlement, doorNum, reservation } = this.prepareOpenContext(payload);

    const eventId = this.store.createId("event");
    let openResult: Awaited<ReturnType<SmartVmGateway["openDoor"]>>;

    try {
      openResult = await this.smartVmGateway.openDoor({
        userId: user.id,
        eventId,
        deviceCode: payload.deviceCode,
        payStyle: payload.payStyle,
        doorNum,
        phone: payload.phone
      });
    } catch (error) {
      const detail = this.smartVmGateway.extractErrorMessage(error);
      this.store.logOperation({
        category: user.role === "merchant" ? "restock" : "pickup",
        type: "open-cabinet",
        status: "failed",
        actor: {
          type: user.role,
          id: user.id,
          name: user.name,
          role: user.role
        },
        primarySubject: {
          type: "device",
          id: payload.deviceCode,
          label: payload.deviceCode
        },
        secondarySubject: {
          type: "user",
          id: user.id,
          label: user.name
        },
        description: `${user.name} 发起的 ${payload.deviceCode} 开柜请求失败。`,
        detail: `柜机平台返回：${detail}`,
        relatedEventId: eventId,
        metadata: {
          deviceCode: payload.deviceCode,
          doorNum,
          payStyle: payload.payStyle,
          undoState: "not_undoable"
        }
      });
      throw new BadGatewayException(`柜机平台开柜失败：${detail}`);
    }

    this.store.events.unshift({
      eventId,
      orderNo: openResult.orderNo,
      userId: user.id,
      phone: user.phone,
      role: user.role,
      deviceCode: payload.deviceCode,
      doorNum,
      openMode: payload.openMode ?? "manual",
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      amount: 0,
      billingStatus: preSettlement ? "pending" : undefined,
      reservationId: reservation?.id,
      intentItems,
      preSettlement,
      goods: []
    });
    this.reservationsService.markFulfilled(reservation?.id, eventId);

    this.store.updateDeviceRuntime(payload.deviceCode, {
      lastCommandAt: new Date().toISOString(),
      openedAfterLastCommand: false
    });
    this.store.logOperation({
      category: user.role === "merchant" ? "restock" : "pickup",
      type: "open-cabinet",
      status: "pending",
      actor: {
        type: user.role,
        id: user.id,
        name: user.name,
        role: user.role
      },
      primarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      secondarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      description: `${user.name} 发起了 ${payload.deviceCode} 的开柜请求。`,
      detail: `事件 ${eventId} 已创建，等待设备返回门状态。`,
      relatedEventId: eventId,
      relatedOrderNo: openResult.orderNo,
      metadata: {
        deviceCode: payload.deviceCode,
        category: payload.category,
        openMode: payload.openMode ?? "manual",
        intentItems,
        preSettlement,
        reservationId: reservation?.id
      }
    });

    return {
      orderNo: openResult.orderNo,
      eventId,
      deviceCode: payload.deviceCode,
      doorNum,
      reservationId: reservation?.id,
      role: user.role,
      openMode: payload.openMode ?? "manual",
      remainingQuota: quotaSummary?.remainingToday,
      acceptedIntentItems: intentItems.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity
      })),
      preSettlement
    };
  }

  list(userId?: string) {
    if (!userId) {
      return this.store.events;
    }

    return this.store.events.filter((entry) => entry.userId === userId);
  }

  getDetail(eventId: string, actor?: { id: string; role: CabinetEventRecord["role"] }) {
    const event = this.store.events.find((entry) => entry.eventId === eventId);

    if (!event) {
      throw new BadRequestException("未找到对应开柜事件。");
    }

    if (actor && actor.role !== "admin" && actor.id !== event.userId) {
      throw new ForbiddenException("当前账号无权查看该开柜事件。");
    }

    return event;
  }

  listCallbackLogs(limit = 20, deviceCode?: string) {
    const resolvedLimit = Math.max(1, limit);
    const normalizedDeviceCode = deviceCode?.trim();

    if (!normalizedDeviceCode) {
      return this.store.callbackLog.slice(0, resolvedLimit);
    }

    const matches: typeof this.store.callbackLog = [];

    for (const entry of this.store.callbackLog) {
      const serialized =
        typeof entry.payload === "string"
          ? entry.payload
          : (() => {
              try {
                return JSON.stringify(entry.payload ?? {});
              } catch {
                return "";
              }
            })();

      if (serialized.includes(normalizedDeviceCode)) {
        matches.push(entry);
      }

      if (matches.length >= resolvedLimit) {
        break;
      }
    }

    return matches;
  }

  handleDoorStatus(payload: SmartVmDoorStatusPayload & Record<string, unknown>) {
    this.store.logCallback("door-status", payload);
    this.assertSignature(payload);

    // 把门状态链路完整落下来，管理员才能快速判断是设备异常还是流程卡住。
    const event = this.store.events.find((entry) => entry.eventId === payload.eventId);

    if (!event) {
      this.alertsService.create({
        type: "callback",
        title: "收到未知开门状态回调",
        deviceCode: payload.deviceCode,
        dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        detail: `设备回调返回了未知事件 ${payload.eventId}。`
      });
      return { eventId: payload.eventId };
    }

    event.updatedAt = new Date().toISOString();

    if (payload.status === "OPENDING") {
      event.status = "opening";
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "unknown"
      });
    } else if (payload.status === "SUCCESS") {
      event.status = "opened";
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "open",
        lastOpenedAt: event.updatedAt,
        openedAfterLastCommand: true
      });
    } else if (payload.status === "CLOSED") {
      event.status = "closed";
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "closed",
        lastClosedAt: event.updatedAt,
        openedAfterLastCommand:
          payload.doorIsOpen === "Y"
            ? true
            : this.store.getDeviceRuntime(payload.deviceCode).openedAfterLastCommand
      });
    } else if (payload.status === "FAIL") {
      event.status = "failed";
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "unknown"
      });
      this.alertsService.create({
        type: "device_fault",
        title: "开门失败",
        deviceCode: payload.deviceCode,
        targetUserId: event.userId,
        dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        detail: `设备 ${payload.deviceCode} 对事件 ${payload.eventId} 返回了 FAIL。`,
        relatedEventId: event.eventId
      });
    }

    this.store.logOperation({
      category: "device",
      type: "door-status-callback",
      status: payload.status === "FAIL" ? "failed" : "success",
      actor: {
        type: "system",
        name: "设备回调"
      },
      primarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      secondarySubject: {
        type: "event",
        id: payload.eventId,
        label: event.orderNo
      },
      description: `设备 ${payload.deviceCode} 返回门状态 ${payload.status}。`,
      detail: `事件 ${payload.eventId} 已更新为 ${event.status}。`,
      relatedEventId: payload.eventId,
      relatedOrderNo: event.orderNo,
      metadata: {
        deviceCode: payload.deviceCode,
        status: payload.status
      }
    });

    return { eventId: payload.eventId };
  }

  handleSettlement(payload: SmartVmSettlementPayload & Record<string, unknown>) {
    this.store.logCallback("settlement", payload);
    this.assertSignature(payload);

    const event = this.getEventByPlatformOrderNo(payload.orderNo);
    const settlementWasAlreadyRecorded = this.hasSettlementRecord(payload.orderNo);
    const callbackBilling = settlementWasAlreadyRecorded
      ? undefined
      : this.buildCallbackBilling(event, payload);
    event.status = "settled";
    event.platformAmount = payload.amount;
    if (callbackBilling) {
      event.amount = callbackBilling.payableAmount;
    } else if (!settlementWasAlreadyRecorded) {
      event.amount = payload.amount;
    }
    event.updatedAt = new Date().toISOString();
    event.paymentNotifyUrl = payload.notifyUrl;
    const settlementAlreadyRecorded = this.inventoryOrdersService
      .recordSettlement(event, payload);

    if (event.paymentNotifyStatus !== "success") {
      event.paymentNotifyStatus = "pending";
      event.paymentNotifyMessage = settlementAlreadyRecorded.duplicated
        ? "重复收到结算回调，已保持现有记录，等待向平台回写付款成功。"
        : "等待向平台回写付款成功。";
    }

    if (!settlementAlreadyRecorded.duplicated) {
      event.goods =
        payload.detail?.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: this.getGoodsCategory(event.deviceCode, item.goodsId),
          quantity: item.quantity,
          unitPrice: item.unitPrice
        })) ?? [];
    }

    const settlementComparison = this.compareSettlement(event, payload);
    event.settlementComparison = settlementComparison;

    if (!settlementAlreadyRecorded.duplicated && callbackBilling) {
      this.applyCallbackBilling(event, callbackBilling, settlementComparison);
    } else if (event.role === "special" && event.intentItems?.length && !event.billingStatus) {
      event.billingStatus = settlementComparison.matched
        ? event.amount > 0
          ? "payable"
          : "free"
        : "mismatch";
    }

    if (event.intentItems?.length && !settlementComparison.matched) {
      this.alertsService.create({
        type: "callback",
        grade: "feedback",
        title: "实际领取与用户选择不一致",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: [
          `事件 ${event.eventId}`,
          `柜机 ${event.deviceCode}`,
          `用户选择：${this.formatComparisonItems(settlementComparison.intendedItems)}`,
          `平台结算：${this.formatComparisonItems(settlementComparison.settledItems)}`
        ].join("；"),
        previewDetail: settlementComparison.summary,
        relatedEventId: event.eventId
      });
    }

    if (!settlementAlreadyRecorded.duplicated && event.billingDeltaType === "supplement") {
      this.alertsService.create({
        type: "callback",
        grade: "warning",
        title: "用户结算需补差",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: [
          `事件 ${event.eventId}`,
          `原预估 ${this.formatAmount(event.billingBaseAmount ?? 0)}`,
          `按柜机回调商品应付 ${this.formatAmount(event.billingActualAmount ?? event.amount)}`,
          `需补 ${this.formatAmount(event.billingDeltaAmount ?? 0)}`
        ].join("；"),
        previewDetail: "补差完成或管理员确认前，该用户不能继续开柜或预约。",
        relatedEventId: event.eventId
      });
    }

    if (!settlementAlreadyRecorded.duplicated) {
      this.store.logOperation({
        category: event.role === "merchant" ? "restock" : "pickup",
        type: "settlement-callback",
        status: "success",
        actor: {
          type: event.role === "admin" ? "admin" : event.role,
          id: event.userId,
          name: this.store.users.find((entry) => entry.id === event.userId)?.name ?? event.phone,
          role: event.role
        },
        primarySubject: {
          type: "device",
          id: event.deviceCode,
          label: event.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: event.orderNo
        },
        description: `订单 ${event.orderNo} 已完成结算。`,
        detail: `设备 ${event.deviceCode} 的结算回调已入库，事件状态更新为 settled。`,
        relatedEventId: event.eventId,
        relatedOrderNo: event.orderNo,
        metadata: {
          amount: event.amount,
          platformAmount: payload.amount,
          billingStatus: event.billingStatus,
          undoState: "not_undoable"
        }
      });
    }

    const shouldAutoForwardFreeSettlement =
      event.role === "special" &&
      event.amount <= 0 &&
      settlementComparison.matched &&
      event.billingDeltaType !== "supplement";

    if (
      event.paymentNotifyStatus !== "success" &&
      (this.shouldAutoForwardSettlementPaymentSuccess() || shouldAutoForwardFreeSettlement)
    ) {
      event.paymentNotifyMessage = shouldAutoForwardFreeSettlement
        ? "本次预结算金额为 0，系统将自动回写平台付款成功。"
        : "已收到结算回调，系统将自动回写平台付款成功。";
      void this.tryAutoForwardPaymentSuccess(
        event,
        {
          orderNo: event.orderNo,
          eventId: event.eventId,
          transactionId: this.store.createReference("txn"),
          deviceCode: payload.deviceCode,
          amount: event.amount
        },
        payload.notifyUrl
      );
    } else if (event.paymentNotifyStatus !== "success") {
      event.paymentNotifyStatus = "pending";
      event.paymentNotifyMessage =
        event.amount > 0
          ? "已收到结算回调，等待用户支付成功后回写平台。"
          : "已收到结算回调，本次无需用户支付。";
    }

    return {
      movements: settlementAlreadyRecorded.movements,
      duplicated: settlementAlreadyRecorded.duplicated,
      paymentNotifyStatus: event.paymentNotifyStatus,
      paymentNotifyMessage: event.paymentNotifyMessage
    };
  }

  handleAdjustment(payload: SmartVmAdjustmentPayload & Record<string, unknown>) {
    this.store.logCallback("adjustment", payload);
    this.assertSignature(payload);

    const event = this.getEventByPlatformOrderNo(payload.orgOrderNo);
    event.updatedAt = new Date().toISOString();
    const adjustment = this.upsertAdjustment(event, payload);

    const adjustmentRecorded = this.inventoryOrdersService.recordAdjustment(event, payload);

    if (!adjustmentRecorded.duplicated) {
      this.store.logOperation({
        category: "inventory",
        type: "adjustment-callback",
        status: payload.amount > 0 ? "warning" : "success",
        actor: {
          type: "system",
          name: "补扣回调"
        },
        primarySubject: {
          type: "device",
          id: payload.deviceCode,
          label: payload.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: event.orderNo
        },
        description: `订单 ${payload.orderNo} 收到补扣回调。`,
        detail: payload.amount > 0 ? "补扣订单仍需等待用户支付。" : "补扣订单已完成。",
        relatedEventId: event.eventId,
        relatedOrderNo: payload.orderNo,
        metadata: {
          amount: payload.amount,
          orgOrderNo: payload.orgOrderNo,
          undoState: "not_undoable"
        }
      });
    }

    if (payload.amount > 0) {
      adjustment.paymentNotifyStatus = "pending";
      adjustment.paymentNotifyMessage = `等待补扣订单 ${payload.orderNo} 支付成功后，再向平台回写付款成功。`;
      this.syncLatestAdjustmentFields(event);
      return {
        code: 200,
        message: "补扣回调已接收，等待支付成功后回写平台",
        duplicated: adjustmentRecorded.duplicated
      };
    }

    adjustment.paymentNotifyStatus = "pending";
    adjustment.paymentNotifyMessage = `补扣订单 ${payload.orderNo} 金额为 0，准备自动回写平台。`;
    this.syncLatestAdjustmentFields(event);
    void this.tryAutoForwardPaymentSuccess(event, {
      orderNo: payload.orderNo,
      eventId: event.eventId,
      transactionId: this.store.createReference("txn"),
      deviceCode: payload.deviceCode,
      amount: payload.amount
    }, payload.noticeUrl);

    return {
      code: 200,
      message: "补扣回调已接收",
      duplicated: adjustmentRecorded.duplicated
    };
  }

  private shouldAutoForwardSettlementPaymentSuccess() {
    const raw = this.configService
      .get<string>("SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS")
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return false;
    }

    return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  }

  async handlePaymentSuccess(payload: SmartVmPaymentPayload & Record<string, unknown>) {
    this.store.logCallback("payment-success", payload);
    return this.forwardPaymentSuccessToPlatform(payload, {
      actor: {
        type: "system",
        name: "支付回调"
      },
      logType: "payment-success-callback",
      targetUrl:
        payload.targetUrl ||
        payload.noticeUrl ||
        payload.notifyUrl
    });
  }

  async notifyPaymentSuccess(
    payload: SmartVmPaymentPayload & {
      openId?: string;
    },
    actorUserId?: string
  ) {
    return this.forwardPaymentSuccessToPlatform(payload, {
      actor: this.getAdminActor(actorUserId),
      logType: "manual-payment-success",
      targetUrl:
        payload.targetUrl ||
        payload.noticeUrl ||
        payload.notifyUrl
    });
  }

  confirmBillingResolution(
    eventId: string,
    actorUserId?: string,
    payload?: {
      note?: string;
    }
  ) {
    const event = this.store.events.find((entry) => entry.eventId === eventId);

    if (!event) {
      throw new BadRequestException("未找到对应开柜事件。");
    }

    const now = new Date().toISOString();
    event.billingStatus = "admin_confirmed";
    event.billingResolvedAt = now;
    event.billingConfirmedByUserId = actorUserId;
    event.billingResolutionNote = payload?.note;
    event.updatedAt = now;

    if (event.paymentNotifyStatus !== "success") {
      event.paymentNotifyMessage = payload?.note
        ? `管理员已确认本次结算：${payload.note}`
        : "管理员已确认本次结算。";
    }

    this.store.logOperation({
      category: "admin",
      type: "confirm-billing-resolution",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "event",
        id: event.eventId,
        label: event.orderNo
      },
      secondarySubject: {
        type: "user",
        id: event.userId,
        label: this.store.users.find((entry) => entry.id === event.userId)?.name ?? event.phone
      },
      description: `管理员确认了订单 ${event.orderNo} 的结算状态。`,
      detail: payload?.note,
      relatedEventId: event.eventId,
      relatedOrderNo: event.orderNo,
      metadata: {
        billingStatus: event.billingStatus,
        billingDeltaAmount: event.billingDeltaAmount,
        undoState: "not_undoable"
      }
    });

    return event;
  }

  private assertSignature(payload: Record<string, unknown>) {
    if (!this.smartVmGateway.verifySignedPayload(payload)) {
      throw new BadRequestException("签名校验失败。");
    }
  }

  private getEventByPlatformOrderNo(orderNo: string) {
    const event = this.store.events.find(
      (entry) =>
        entry.orderNo === orderNo ||
        entry.adjustmentOrderNo === orderNo ||
        entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)
    );

    if (!event) {
      throw new BadRequestException(`订单 ${orderNo} 不存在。`);
    }

    return event;
  }

  private async tryAutoForwardPaymentSuccess(
    event: CabinetEventRecord,
    payload: SmartVmPaymentPayload,
    targetUrl?: string
  ) {
    try {
      await this.forwardPaymentSuccessToPlatform(payload, {
        actor: {
          type: "system",
          name: "系统回写"
        },
        logType: "auto-payment-success",
        targetUrl
      });
    } catch (error) {
      const message = this.smartVmGateway.extractErrorMessage(error);
      const adjustment = this.getAdjustment(event, payload.orderNo);
      if (adjustment) {
        adjustment.paymentNotifyStatus = "failed";
        adjustment.paymentNotifyMessage = message;
        adjustment.updatedAt = new Date().toISOString();
        this.syncLatestAdjustmentFields(event);
      } else {
        event.paymentNotifyStatus = "failed";
        event.paymentNotifyMessage = message;
      }
      event.updatedAt = new Date().toISOString();
      this.alertsService.create({
        type: "callback",
        title: "付款成功回写平台失败",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: `订单 ${event.orderNo} 回写平台失败：${message}`,
        relatedEventId: event.eventId
      });
      this.store.logOperation({
        category: "inventory",
        type: "auto-payment-success",
        status: "failed",
        actor: {
          type: "system",
          name: "系统回写"
        },
        primarySubject: {
          type: "device",
          id: event.deviceCode,
          label: event.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: event.orderNo
        },
        description: `订单 ${event.orderNo} 回写平台付款成功失败。`,
        detail: `平台返回：${message}`,
        relatedEventId: event.eventId,
        relatedOrderNo: event.orderNo,
        metadata: {
          amount: payload.amount,
          transactionId: payload.transactionId,
          undoState: "not_undoable"
        }
      });
    }
  }

  private async forwardPaymentSuccessToPlatform(
    payload: SmartVmPaymentPayload & { openId?: string },
    options: {
      actor: {
        type: "admin" | "merchant" | "special" | "system";
        id?: string;
        name: string;
        role?: "admin" | "merchant" | "special";
      };
      logType: string;
      targetUrl?: string;
    }
  ) {
    const event = this.getEventByPlatformOrderNo(payload.orderNo);
    event.updatedAt = new Date().toISOString();
    const adjustment = this.getAdjustment(event, payload.orderNo);
    const isAdjustmentOrder = Boolean(adjustment);

    if (!isAdjustmentOrder) {
      event.amount = payload.amount;
    }

    const resolvedTargetUrl =
      options.targetUrl ??
      adjustment?.noticeUrl ??
      event.adjustmentNoticeUrl ??
      event.paymentNotifyUrl;

    if (!resolvedTargetUrl) {
      throw new BadRequestException(
        `订单 ${payload.orderNo} 缺少平台付款成功通知地址，请先接收结算或补扣回调中的 notifyUrl / noticeUrl。`
      );
    }

    await this.smartVmGateway.notifyPaymentSuccess(payload, {
      targetUrl: resolvedTargetUrl
    });

    if (adjustment) {
      adjustment.paymentNotifyStatus = "success";
      adjustment.paymentNotifyMessage = resolvedTargetUrl
        ? `已回写平台付款成功，补扣订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
        : `已回写平台付款成功，补扣订单 ${payload.orderNo}。`;
      adjustment.paymentNotifiedAt = event.updatedAt;
      adjustment.paymentTransactionId = payload.transactionId;
      adjustment.updatedAt = event.updatedAt;
      if (event.billingStatus === "supplement_pending") {
        event.billingStatus = "paid";
        event.billingResolvedAt = event.updatedAt;
      }
      this.syncLatestAdjustmentFields(event);
    } else {
      event.paymentNotifyStatus = "success";
      event.paymentNotifyMessage = resolvedTargetUrl
        ? `已回写平台付款成功，订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
        : `已回写平台付款成功，订单 ${payload.orderNo}。`;
      event.paymentNotifiedAt = event.updatedAt;
      event.paymentTransactionId = payload.transactionId;
      if (event.role === "special" && event.amount > 0) {
        event.billingStatus = "paid";
        event.billingResolvedAt = event.updatedAt;
      }
    }

    this.store.logOperation({
      category: "inventory",
      type: options.logType,
      status: "success",
      actor: options.actor,
      primarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      secondarySubject: {
        type: "event",
        id: event.eventId,
        label: event.orderNo
      },
      description: `订单 ${payload.orderNo}${isAdjustmentOrder ? "（补扣单）" : ""} 已回写平台付款成功。`,
      detail: `交易号 ${payload.transactionId}，金额 ${payload.amount}${resolvedTargetUrl ? `，目标 ${resolvedTargetUrl}` : ""}。`,
      relatedEventId: event.eventId,
      relatedOrderNo: payload.orderNo,
      metadata: {
        transactionId: payload.transactionId,
        amount: payload.amount,
        targetUrl: resolvedTargetUrl,
        undoState: "not_undoable"
      }
    });

    return {
      orderNo: payload.orderNo,
      forwarded: true,
      transactionId: payload.transactionId,
      targetUrl: resolvedTargetUrl
    };
  }

  private upsertAdjustment(event: CabinetEventRecord, payload: SmartVmAdjustmentPayload) {
    event.adjustments ??= [];
    const now = new Date().toISOString();
    let adjustment = event.adjustments.find((entry) => entry.orderNo === payload.orderNo);

    if (!adjustment) {
      adjustment = {
        orderNo: payload.orderNo,
        sourceOrderNo: payload.orgOrderNo,
        noticeUrl: payload.noticeUrl,
        amount: payload.amount,
        createdAt: now,
        updatedAt: now,
        goods:
          payload.detail?.map((item) => ({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: item.quantity,
            unitPrice: item.unitPrice
          })) ?? []
      };
      event.adjustments.unshift(adjustment);
    } else {
      adjustment.sourceOrderNo = payload.orgOrderNo;
      adjustment.noticeUrl = payload.noticeUrl;
      adjustment.amount = payload.amount;
      adjustment.updatedAt = now;
      adjustment.goods =
        payload.detail?.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        })) ?? adjustment.goods;
    }

    this.syncLatestAdjustmentFields(event);
    return adjustment;
  }

  private getAdjustment(event: CabinetEventRecord, orderNo: string) {
    return event.adjustments?.find((entry) => entry.orderNo === orderNo);
  }

  private syncLatestAdjustmentFields(event: CabinetEventRecord) {
    const latest = event.adjustments?.[0];

    event.adjustmentOrderNo = latest?.orderNo;
    event.adjustmentNoticeUrl = latest?.noticeUrl;
    event.adjustmentAmount = latest?.amount;
    event.adjustmentPaymentNotifyStatus = latest?.paymentNotifyStatus;
    event.adjustmentPaymentNotifyMessage = latest?.paymentNotifyMessage;
    event.adjustmentPaymentNotifiedAt = latest?.paymentNotifiedAt;
    event.adjustmentPaymentTransactionId = latest?.paymentTransactionId;
    event.adjustmentRefundNo = latest?.refundNo;
    event.adjustmentRefundTransactionId = latest?.refundTransactionId;
    event.adjustmentRefundedAt = latest?.refundedAt;
  }

  private getAdminActor(actorUserId?: string) {
    const adminUser =
      (actorUserId ? this.store.users.find((entry) => entry.id === actorUserId) : undefined) ??
      this.store.users.find((entry) => entry.role === "admin");

    return {
      type: "admin" as const,
      id: adminUser?.id,
      name: adminUser?.name ?? "管理员",
      role: "admin" as const
    };
  }

  private prepareOpenContext(payload: CabinetOpenRequest) {
    const user = this.store.users.find(
      (entry) => entry.phone === payload.phone && entry.status === "active"
    );

    if (!user) {
      throw new UnauthorizedException("该手机号未登记，无法开柜。");
    }

    if (user.role === "admin") {
      throw new BadRequestException("管理员账号不能直接开柜。");
    }

    const doorNum = payload.doorNum ?? "1";
    this.reservationsService.assertUserCanUseRelatedFeatures(user.id);
    const reservation = payload.reservationId
      ? this.reservationsService.getReservationForOpen(user.id, payload.reservationId, payload.deviceCode)
      : undefined;
    const intentItems = this.resolveIntentItems(
      payload.deviceCode,
      reservation?.items ?? payload.intentItems ?? [],
      payload.category ?? "daily"
    );
    const quotaSummary =
      user.role === "special"
        ? this.accessRulesService.assertCanOpenSpecialCabinet(
            user,
            payload.category ?? intentItems[0]?.category
          )
        : undefined;

    if (user.role === "special" && !intentItems.length) {
      throw new BadRequestException("正式开柜前请先选择本次计划领取的商品。");
    }

    const preSettlement =
      user.role === "special" && quotaSummary
        ? this.buildPreSettlement(payload.deviceCode, doorNum, intentItems, quotaSummary)
        : undefined;

    return {
      user,
      doorNum,
      quotaSummary,
      intentItems,
      preSettlement,
      reservation
    };
  }

  private resolveIntentItems(
    deviceCode: string,
    intentItems: NonNullable<CabinetOpenRequest["intentItems"]>,
    fallbackCategory: CabinetOpenRequest["category"] = "daily"
  ): CabinetIntentItem[] {
    this.store.syncDeviceStocksFromBatches(deviceCode);
    const resolved = new Map<string, CabinetIntentItem>();

    for (const item of intentItems) {
      const quantity = Math.floor(Number(item.quantity));

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException("选择商品数量必须大于 0。");
      }

      const deviceGoods = this.store.devices
        .find((device) => device.deviceCode === deviceCode)
        ?.doors.flatMap((door) => door.goods)
        .find((goods) => goods.goodsId === item.goodsId);
      const catalogGoods = this.store.goodsCatalog.find((goods) => goods.goodsId === item.goodsId);
      const existing = resolved.get(item.goodsId);
      const goodsName = item.goodsName || deviceGoods?.name || catalogGoods?.name || item.goodsId;
      const category = item.category || deviceGoods?.category || catalogGoods?.category || fallbackCategory;
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      const stock = this.store.getCurrentStock(deviceCode, item.goodsId);

      if (stock < nextQuantity) {
        throw new BadRequestException(`${goodsName} 当前库存不足，最多可选择 ${Math.max(0, stock)} 件。`);
      }

      resolved.set(item.goodsId, {
        goodsId: item.goodsId,
        goodsName,
        category,
        quantity: nextQuantity
      });
    }

    return Array.from(resolved.values());
  }

  private buildPreSettlement(
    deviceCode: string,
    doorNum: string,
    intentItems: CabinetIntentItem[],
    quotaSummary: ReturnType<AccessRulesService["getQuotaSummaryForUser"]>
  ): CabinetPreSettlement {
    const remainingByGoods = new Map(
      Object.entries((quotaSummary.remainingByGoods as Record<string, number> | undefined) ?? {})
    );
    const remainingByCategory = new Map(
      Object.entries((quotaSummary.remainingToday as Record<string, number> | undefined) ?? {})
    );
    const useGoodsQuota = remainingByGoods.size > 0;
    const items = intentItems.map((item) => {
      const goods = this.getGoodsSnapshot(deviceCode, item.goodsId);
      const goodsRemaining = remainingByGoods.get(item.goodsId);
      const categoryRemaining = useGoodsQuota ? undefined : remainingByCategory.get(item.category);
      const freeQuantity = Math.min(
        item.quantity,
        Math.max(0, goodsRemaining ?? categoryRemaining ?? 0)
      );
      const paidQuantity = Math.max(0, item.quantity - freeQuantity);
      const unitPrice = goods.unitPrice;

      if (useGoodsQuota && goodsRemaining !== undefined) {
        remainingByGoods.set(item.goodsId, Math.max(0, goodsRemaining - freeQuantity));
      } else if (!useGoodsQuota && categoryRemaining !== undefined) {
        remainingByCategory.set(item.category, Math.max(0, categoryRemaining - freeQuantity));
      }

      return {
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: item.category,
        quantity: item.quantity,
        freeQuantity,
        paidQuantity,
        unitPrice,
        originalAmount: unitPrice * item.quantity,
        freeAmount: unitPrice * freeQuantity,
        paidAmount: unitPrice * paidQuantity
      };
    });
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const freeQuantity = items.reduce((sum, item) => sum + item.freeQuantity, 0);
    const paidQuantity = items.reduce((sum, item) => sum + item.paidQuantity, 0);
    const originalAmount = items.reduce((sum, item) => sum + item.originalAmount, 0);
    const freeAmount = items.reduce((sum, item) => sum + item.freeAmount, 0);
    const payableAmount = items.reduce((sum, item) => sum + item.paidAmount, 0);
    const chargeRequired = payableAmount > 0;

    return {
      deviceCode,
      doorNum,
      createdAt: new Date().toISOString(),
      totalQuantity,
      freeQuantity,
      paidQuantity,
      originalAmount,
      freeAmount,
      payableAmount,
      chargeRequired,
      summary: chargeRequired
        ? `本次预计免费 ${freeQuantity} 件，超出范围 ${paidQuantity} 件，需支付 ${this.formatAmount(payableAmount)}。`
        : `本次选择的 ${totalQuantity} 件均在可领取范围内，预计免费。`,
      items
    };
  }

  private getGoodsSnapshot(deviceCode: string, goodsId: string) {
    const deviceGoods = this.store.devices
      .find((device) => device.deviceCode === deviceCode)
      ?.doors.flatMap((door) => door.goods)
      .find((goods) => goods.goodsId === goodsId);
    const catalogGoods = this.store.goodsCatalog.find((goods) => goods.goodsId === goodsId);

    return {
      unitPrice: Math.max(0, Math.round(deviceGoods?.price ?? catalogGoods?.price ?? 0))
    };
  }

  private hasSettlementRecord(orderNo: string) {
    return this.store.inventory.some(
      (entry) =>
        entry.orderNo === orderNo &&
        (entry.type === "pickup" || entry.type === "donation")
    );
  }

  private buildCallbackBilling(
    event: CabinetEventRecord,
    payload: SmartVmSettlementPayload
  ): CallbackBilling {
    const platformAmount = Math.max(0, Math.round(payload.amount));
    const lines =
      payload.detail?.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: this.getGoodsCategory(event.deviceCode, item.goodsId),
        quantity: Math.max(0, Math.floor(Number(item.quantity))),
        unitPrice: Math.max(0, Math.round(Number(item.unitPrice)))
      })) ?? [];

    if (!lines.length || event.role !== "special") {
      const totalQuantity = lines.reduce((sum, item) => sum + item.quantity, 0);
      const originalAmount = lines.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

      return {
        platformAmount,
        totalQuantity,
        freeQuantity: 0,
        paidQuantity: totalQuantity,
        originalAmount: originalAmount || platformAmount,
        freeAmount: 0,
        payableAmount: platformAmount,
        items: lines.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: item.category,
          quantity: item.quantity,
          freeQuantity: 0,
          paidQuantity: item.quantity,
          unitPrice: item.unitPrice,
          originalAmount: item.quantity * item.unitPrice,
          freeAmount: 0,
          paidAmount: item.quantity * item.unitPrice
        }))
      };
    }

    const user = this.store.users.find((entry) => entry.id === event.userId);
    const quotaSummary = user ? this.accessRulesService.getQuotaSummaryForUser(user) : undefined;
    const remainingByGoods = new Map(
      Object.entries((quotaSummary?.remainingByGoods as Record<string, number> | undefined) ?? {})
    );
    const remainingByCategory = new Map(
      Object.entries((quotaSummary?.remainingToday as Record<string, number> | undefined) ?? {})
    );
    const useGoodsQuota = remainingByGoods.size > 0;
    const items = lines.map((item) => {
      const goodsRemaining = remainingByGoods.get(item.goodsId);
      const categoryRemaining = useGoodsQuota ? undefined : remainingByCategory.get(item.category);
      const freeQuantity = Math.min(
        item.quantity,
        Math.max(0, goodsRemaining ?? categoryRemaining ?? 0)
      );
      const paidQuantity = Math.max(0, item.quantity - freeQuantity);

      if (useGoodsQuota && goodsRemaining !== undefined) {
        remainingByGoods.set(item.goodsId, Math.max(0, goodsRemaining - freeQuantity));
      } else if (!useGoodsQuota && categoryRemaining !== undefined) {
        remainingByCategory.set(item.category, Math.max(0, categoryRemaining - freeQuantity));
      }

      return {
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: item.category,
        quantity: item.quantity,
        freeQuantity,
        paidQuantity,
        unitPrice: item.unitPrice,
        originalAmount: item.unitPrice * item.quantity,
        freeAmount: item.unitPrice * freeQuantity,
        paidAmount: item.unitPrice * paidQuantity
      };
    });

    return {
      platformAmount,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      freeQuantity: items.reduce((sum, item) => sum + item.freeQuantity, 0),
      paidQuantity: items.reduce((sum, item) => sum + item.paidQuantity, 0),
      originalAmount: items.reduce((sum, item) => sum + item.originalAmount, 0),
      freeAmount: items.reduce((sum, item) => sum + item.freeAmount, 0),
      payableAmount: items.reduce((sum, item) => sum + item.paidAmount, 0),
      items
    };
  }

  private applyCallbackBilling(
    event: CabinetEventRecord,
    billing: CallbackBilling,
    settlementComparison: CabinetSettlementComparison
  ) {
    const expectedAmount = event.preSettlement?.payableAmount ?? 0;
    const actualAmount = billing.payableAmount;
    const deltaAmount = actualAmount - expectedAmount;

    event.amount = actualAmount;
    event.billingBaseAmount = expectedAmount;
    event.billingActualAmount = actualAmount;
    event.billingDeltaAmount = deltaAmount;
    event.billingDeltaType =
      deltaAmount > 0 ? "supplement" : deltaAmount < 0 ? "refund" : "none";

    if (event.role !== "special") {
      return;
    }

    if (actualAmount <= 0) {
      event.billingStatus = "free";
      return;
    }

    if (deltaAmount > 0) {
      event.billingStatus = "supplement_pending";
      return;
    }

    event.billingStatus = settlementComparison.matched ? "payable" : "mismatch";
  }

  private getGoodsCategory(deviceCode: string, goodsId: string, fallback: GoodsCategory = "daily") {
    return (
      this.store.devices
        .find((device) => device.deviceCode === deviceCode)
        ?.doors.flatMap((door) => door.goods)
        .find((goods) => goods.goodsId === goodsId)?.category ??
      this.store.goodsCatalog.find((goods) => goods.goodsId === goodsId)?.category ??
      fallback
    );
  }

  private formatAmount(amount: number) {
    return `￥${(amount / 100).toFixed(2)}`;
  }

  private compareSettlement(event: CabinetEventRecord, payload: SmartVmSettlementPayload) {
    const intendedItems = (event.intentItems ?? []).map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      quantity: item.quantity,
      unitPrice: this.getGoodsSnapshot(event.deviceCode, item.goodsId).unitPrice,
      amount: this.getGoodsSnapshot(event.deviceCode, item.goodsId).unitPrice * item.quantity
    }));
    const settledItems =
      payload.detail?.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.unitPrice * item.quantity
      })) ?? [];

    const intendedMap = new Map(intendedItems.map((item) => [item.goodsId, item]));
    const settledMap = new Map(settledItems.map((item) => [item.goodsId, item]));
    const missingItems: CabinetSettlementComparisonItem[] = [];
    const extraItems: CabinetSettlementComparisonItem[] = [];

    for (const item of intendedItems) {
      const settled = settledMap.get(item.goodsId);

      if (!settled) {
        missingItems.push(item);
        continue;
      }

      if (settled.quantity !== item.quantity) {
        const delta = item.quantity - settled.quantity;

        if (delta > 0) {
          missingItems.push({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: delta,
            unitPrice: item.unitPrice,
            amount: (item.unitPrice ?? 0) * delta
          });
        } else if (delta < 0) {
          extraItems.push({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: Math.abs(delta),
            unitPrice: settled.unitPrice,
            amount: (settled.unitPrice ?? 0) * Math.abs(delta)
          });
        }
      }
    }

    for (const item of settledItems) {
      if (!intendedMap.has(item.goodsId)) {
        extraItems.push(item);
      }
    }

    const matched = missingItems.length === 0 && extraItems.length === 0;
    const summaryParts: string[] = [];

    if (missingItems.length) {
      summaryParts.push(`少领 ${this.formatComparisonItems(missingItems)}`);
    }

    if (extraItems.length) {
      summaryParts.push(`多领 ${this.formatComparisonItems(extraItems)}`);
    }

    return {
      matched,
      comparedAt: new Date().toISOString(),
      summary: matched
        ? "平台结算结果与用户选择一致。"
        : `存在差异：${summaryParts.join("；")}`,
      intendedItems,
      settledItems,
      missingItems,
      extraItems
    } satisfies CabinetSettlementComparison;
  }

  private formatComparisonItems(items: CabinetSettlementComparisonItem[]) {
    if (!items.length) {
      return "无";
    }

    return items.map((item) => `${item.goodsName} x${item.quantity}`).join("、");
  }
}
