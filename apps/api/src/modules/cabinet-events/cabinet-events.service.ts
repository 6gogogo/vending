import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";

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
    }

    const eventId = this.store.createId("event");
    const doorNum = payload.doorNum ?? "1";
    const openResult = await this.smartVmGateway.openDoor({
      userId: user.id,
      eventId,
      deviceCode: payload.deviceCode,
      payStyle: payload.payStyle ?? "2",
      doorNum,
      phone: payload.phone
    });

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

    return {
      orderNo: openResult.orderNo,
      eventId,
      deviceCode: payload.deviceCode,
      doorNum,
      role: user.role,
      remainingQuota: quotaSummary?.remainingToday
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
    } else if (payload.status === "SUCCESS") {
      event.status = "opened";
    } else if (payload.status === "CLOSED") {
      event.status = "closed";
    } else if (payload.status === "FAIL") {
      event.status = "failed";
      this.alertsService.create({
        type: "callback",
        title: "开门失败",
        deviceCode: payload.deviceCode,
        targetUserId: event.userId,
        dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        detail: `设备 ${payload.deviceCode} 对事件 ${payload.eventId} 返回了 FAIL。`
      });
    }

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

    return this.inventoryOrdersService.recordSettlement(event, payload);
  }

  handleAdjustment(payload: SmartVmAdjustmentPayload & Record<string, unknown>) {
    this.store.logCallback("adjustment", payload);
    this.assertSignature(payload);

    const event = this.getEventByOrderNo(payload.orgOrderNo);
    event.updatedAt = new Date().toISOString();

    this.inventoryOrdersService.recordAdjustment(event, payload);

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
