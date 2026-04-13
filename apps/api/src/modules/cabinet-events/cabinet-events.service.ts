import { BadGatewayException, BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import type {
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
    @Inject(AlertsService) private readonly alertsService: AlertsService
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
      const detail = error instanceof Error ? error.message : "柜机平台未返回可用结果。";
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

  listCallbackLogs(limit = 20) {
    return this.store.callbackLog.slice(0, Math.max(1, limit));
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
      if (payload.doorIsOpen === "N") {
        this.alertsService.create({
          type: "device_fault",
          title: "开门后未实际拉开柜门",
          deviceCode: payload.deviceCode,
          targetUserId: event.userId,
          dueAt: event.updatedAt,
          detail: `事件 ${payload.eventId} 已关门，但回调显示用户未实际拉开柜门。`,
          relatedEventId: event.eventId
        });
      }
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

    const event = this.getEventByOrderNo(payload.orderNo);
    event.status = "settled";
    event.amount = payload.amount;
    event.updatedAt = new Date().toISOString();
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
        amount: payload.amount
      }
    });

    return this.inventoryOrdersService.recordSettlement(event, payload);
  }

  handleAdjustment(payload: SmartVmAdjustmentPayload & Record<string, unknown>) {
    this.store.logCallback("adjustment", payload);
    this.assertSignature(payload);

    const event = this.getEventByOrderNo(payload.orgOrderNo);
    event.updatedAt = new Date().toISOString();

    this.inventoryOrdersService.recordAdjustment(event, payload);

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
        amount: payload.amount
      }
    });

    if (payload.amount > 0) {
      return {
        code: 500,
        message: "等待用户完成支付"
      };
    }

    return {
      code: 200,
      message: "补扣回调已接收"
    };
  }

  async handlePaymentSuccess(payload: SmartVmPaymentPayload & Record<string, unknown>) {
    this.store.logCallback("payment-success", payload);
    const event = this.getEventByOrderNo(payload.orderNo);
    event.amount = payload.amount;
    event.updatedAt = new Date().toISOString();

    await this.smartVmGateway.notifyPaymentSuccess(payload);

    this.store.logOperation({
      category: "inventory",
      type: "payment-success-callback",
      status: "success",
      actor: {
        type: "system",
        name: "支付回调"
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
      description: `订单 ${payload.orderNo} 收到支付成功通知。`,
      detail: `支付结果已转发给设备侧，交易号 ${payload.transactionId}。`,
      relatedEventId: event.eventId,
      relatedOrderNo: payload.orderNo,
      metadata: {
        transactionId: payload.transactionId,
        amount: payload.amount
      }
    });

    return {
      orderNo: payload.orderNo,
      forwarded: true
    };
  }

  private assertSignature(payload: Record<string, unknown>) {
    if (!this.smartVmGateway.verifySignedPayload(payload)) {
      throw new BadRequestException("签名校验失败。");
    }
  }

  private getEventByOrderNo(orderNo: string) {
    const event = this.store.events.find((entry) => entry.orderNo === orderNo);

    if (!event) {
      throw new BadRequestException(`订单 ${orderNo} 不存在。`);
    }

    return event;
  }
}
