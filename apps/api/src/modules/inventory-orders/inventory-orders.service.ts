import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  CabinetEventRecord,
  GoodsCategory,
  InventoryMovement,
  SmartVmAdjustmentPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";
import { DevicesService } from "../devices/devices.service";

@Injectable()
export class InventoryOrdersService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(DevicesService) private readonly devicesService: DevicesService,
    @Inject(AlertsService) private readonly alertsService: AlertsService
  ) {}

  list(userId?: string, role?: "special" | "merchant" | "admin") {
    return this.store.inventory.filter((entry) => {
      if (userId && entry.userId !== userId) {
        return false;
      }

      if (role && role !== "admin") {
        const user = this.store.users.find((candidate) => candidate.id === entry.userId);
        return user?.role === role;
      }

      return true;
    });
  }

  getMerchantSummary(userId: string) {
    const records = this.store.inventory.filter((entry) => entry.userId === userId);
    const donatedUnits = records
      .filter((entry) => entry.type === "donation")
      .reduce((sum, entry) => sum + entry.quantity, 0);
    const expiredUnits = records
      .filter((entry) => entry.type === "expired")
      .reduce((sum, entry) => sum + entry.quantity, 0);

    return {
      donatedUnits,
      expiredUnits,
      pendingAlerts: this.store.alerts.filter(
        (alert) => alert.targetUserId === userId && alert.status === "open"
      ).length,
      records
    };
  }

  recordSettlement(event: CabinetEventRecord, payload: SmartVmSettlementPayload) {
    const movements =
      payload.detail?.map((item) =>
        this.createMovementFromLineItem(event, item.goodsId, item.goodsName, item.quantity, item.unitPrice)
      ) ?? [];

    for (const movement of movements) {
      this.store.inventory.unshift(movement);

      if (movement.type === "pickup") {
        this.devicesService.adjustStock(movement.deviceCode, movement.goodsId, -movement.quantity);
      } else if (movement.type === "donation") {
        this.devicesService.adjustStock(movement.deviceCode, movement.goodsId, movement.quantity);

        if (movement.expiresAt) {
          this.alertsService.create({
            type: "expiry",
            title: "商户投放物资待过期处理",
            deviceCode: movement.deviceCode,
            targetUserId: movement.userId,
            dueAt: movement.expiresAt,
            detail: `商品 ${movement.goodsId} 即将超过领取期限，请及时处理。`
          });
        }
      }

      const actorUser = this.store.users.find((entry) => entry.id === movement.userId);
      this.store.logOperation({
        category: movement.type === "donation" ? "restock" : "pickup",
        type: movement.type === "donation" ? "inventory-restock" : "inventory-pickup",
        status: "success",
        actor: actorUser
          ? {
              type: actorUser.role === "admin" ? "admin" : actorUser.role,
              id: actorUser.id,
              name: actorUser.name,
              role: actorUser.role
            }
          : {
              type: "system",
              name: "系统"
            },
        primarySubject: {
          type: "device",
          id: movement.deviceCode,
          label: movement.deviceCode
        },
        secondarySubject: {
          type: "goods",
          id: movement.goodsId,
          label: movement.goodsName
        },
        relatedEventId: event.eventId,
        relatedOrderNo: event.orderNo,
        metadata: {
          goodsId: movement.goodsId,
          goodsName: movement.goodsName,
          quantity: movement.quantity,
          deviceCode: movement.deviceCode
        }
      });
    }

    return movements;
  }

  recordAdjustment(event: CabinetEventRecord, payload: SmartVmAdjustmentPayload) {
    const movements =
      payload.detail?.map((item) =>
        this.createMovementFromLineItem(
          event,
          item.goodsId,
          item.goodsName,
          item.quantity,
          item.unitPrice,
          "adjustment"
        )
      ) ?? [];

    for (const movement of movements) {
      this.store.inventory.unshift(movement);
    }

    if (payload.amount > 0) {
      this.alertsService.create({
        type: "callback",
        title: "补扣订单待支付跟进",
        deviceCode: payload.deviceCode,
        targetUserId: event.userId,
        dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        detail: `补扣订单 ${payload.orderNo} 仍在等待支付完成。`
      });
    }

    return movements;
  }

  markRefund(orderNo: string, transactionId: string, amount: number) {
    const event = this.store.events.find((entry) => entry.orderNo === orderNo);

    if (!event) {
      throw new NotFoundException("未找到可退款的订单。");
    }

    const movement: InventoryMovement = {
      id: this.store.createId("movement"),
      orderNo,
      userId: event.userId,
      deviceCode: event.deviceCode,
      goodsId: event.goods[0]?.goodsId ?? "unknown",
      goodsName: event.goods[0]?.goodsName ?? "unknown",
      category: event.goods[0]?.category ?? "daily",
      quantity: 1,
      unitPrice: amount,
      type: "refund",
      happenedAt: new Date().toISOString()
    };

    event.status = "refunded";
    event.updatedAt = new Date().toISOString();
    this.store.inventory.unshift(movement);
    this.store.logOperation({
      category: "inventory",
      type: "manual-refund",
      status: "success",
      actor: {
        type: "admin",
        id: this.store.users.find((entry) => entry.role === "admin")?.id,
        name: this.store.users.find((entry) => entry.role === "admin")?.name ?? "管理员",
        role: "admin"
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
      description: `管理员对订单 ${orderNo} 执行了退款。`,
      detail: `退款金额 ${amount}，交易号 ${transactionId}。`,
      relatedEventId: event.eventId,
      relatedOrderNo: orderNo,
      metadata: {
        amount,
        transactionId
      }
    });

    return {
      movement,
      transactionId
    };
  }

  private createMovementFromLineItem(
    event: CabinetEventRecord,
    goodsId: string,
    goodsName: string,
    quantity: number,
    unitPrice: number,
    typeOverride?: InventoryMovement["type"]
  ): InventoryMovement {
    const localGoods = this.devicesService.findGoods(event.deviceCode, goodsId);
    const category = (localGoods?.category ?? "daily") as GoodsCategory;
    const user = this.store.users.find((entry) => entry.id === event.userId);
    const expiresAt =
      event.role === "merchant"
        ? new Date(
            Date.now() + (user?.merchantProfile?.donationWindowDays ?? 2) * 24 * 60 * 60_000
          ).toISOString()
        : undefined;

    return {
      id: this.store.createId("movement"),
      orderNo: event.orderNo,
      userId: event.userId,
      deviceCode: event.deviceCode,
      goodsId,
      goodsName,
      category,
      quantity,
      unitPrice,
      type: typeOverride ?? (event.role === "merchant" ? "donation" : "pickup"),
      happenedAt: new Date().toISOString(),
      expiresAt
    };
  }
}
