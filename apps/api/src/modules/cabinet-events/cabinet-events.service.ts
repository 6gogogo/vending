import { BadGatewayException, BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  CabinetEventRecord,
  CabinetOpenRequest,
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

@Injectable()
export class CabinetEventsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway,
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService,
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  async openCabinet(payload: CabinetOpenRequest) {
    const user = this.store.users.find(
      (entry) => entry.phone === payload.phone && entry.status === "active"
    );

    if (!user) {
      throw new UnauthorizedException("该手机号未登记，无法开柜。");
    }

    if (user.role === "admin") {
      throw new BadRequestException("管理员账号不能直接开柜。");
    }

    let quotaSummary:
      | ReturnType<AccessRulesService["getQuotaSummaryForUser"]>
      | undefined;

    if (user.role === "special") {
      quotaSummary = this.accessRulesService.assertCanOpenSpecialCabinet(user, payload.category);

      if (payload.intentItems?.length) {
        const remainingToday = (quotaSummary.remainingToday ?? {}) as Record<string, number>;
        const remainingByGoods =
          ((quotaSummary.remainingByGoods as Record<string, number> | undefined) ?? {});

        for (const item of payload.intentItems) {
          const fallbackCategory = payload.category ?? "daily";
          const remaining = remainingByGoods[item.goodsId] ?? remainingToday[fallbackCategory] ?? 0;

          if (item.quantity > remaining) {
            throw new BadRequestException("意向领取数量超过当前可用额度。");
          }
        }
      }
    }

    const eventId = this.store.createId("event");
    const doorNum = payload.doorNum ?? "1";
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
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      amount: 0,
      goods: []
    });

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
        intentItems: payload.intentItems ?? []
      }
    });

    return {
      orderNo: openResult.orderNo,
      eventId,
      deviceCode: payload.deviceCode,
      doorNum,
      role: user.role,
      remainingQuota: quotaSummary?.remainingToday,
      acceptedIntentItems: payload.intentItems ?? []
    };
  }

  list(userId?: string) {
    if (!userId) {
      return this.store.events;
    }

    return this.store.events.filter((entry) => entry.userId === userId);
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
    event.status = "settled";
    event.amount = payload.amount;
    event.updatedAt = new Date().toISOString();
    event.paymentNotifyUrl = payload.notifyUrl;
    const settlementAlreadyRecorded = this.inventoryOrdersService
      .recordSettlement(event, payload);

    event.paymentNotifyStatus = "pending";
    event.paymentNotifyMessage = settlementAlreadyRecorded.duplicated
      ? "重复收到结算回调，已保持现有记录，等待向平台回写付款成功。"
      : "等待向平台回写付款成功。";
    if (!settlementAlreadyRecorded.duplicated) {
      event.goods =
        payload.detail?.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category:
            this.store.devices
              .flatMap((device) => device.doors)
              .flatMap((door) => door.goods)
              .find((goods) => goods.goodsId === item.goodsId)?.category ?? "daily",
          quantity: item.quantity,
          unitPrice: item.unitPrice
            })) ?? [];
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
          amount: payload.amount,
          undoState: "not_undoable"
        }
      });
    }

    if (this.shouldAutoForwardSettlementPaymentSuccess()) {
      void this.tryAutoForwardPaymentSuccess(
        event,
        {
          orderNo: event.orderNo,
          eventId: event.eventId,
          transactionId: this.store.createReference("txn"),
          deviceCode: payload.deviceCode,
          amount: payload.amount
        },
        payload.notifyUrl
      );
    } else {
      event.paymentNotifyStatus = "pending";
      event.paymentNotifyMessage = "已收到结算回调，等待手动或外部支付成功后回写平台。";
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
      return true;
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
    event.amount = payload.amount;
    event.updatedAt = new Date().toISOString();
    const adjustment = this.getAdjustment(event, payload.orderNo);
    const isAdjustmentOrder = Boolean(adjustment);

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
      this.syncLatestAdjustmentFields(event);
    } else {
      event.paymentNotifyStatus = "success";
      event.paymentNotifyMessage = resolvedTargetUrl
        ? `已回写平台付款成功，订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
        : `已回写平台付款成功，订单 ${payload.orderNo}。`;
      event.paymentNotifiedAt = event.updatedAt;
      event.paymentTransactionId = payload.transactionId;
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
}
