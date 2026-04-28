import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  CabinetEventRecord,
  BatchConsumptionLine,
  GoodsCategory,
  InventoryMovement,
  SmartVmAdjustmentPayload,
  SmartVmRefundPayload,
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
    const existingMovements = this.store.inventory.filter(
      (entry) =>
        entry.orderNo === payload.orderNo &&
        (entry.type === "pickup" || entry.type === "donation")
    );

    if (existingMovements.length) {
      return {
        movements: existingMovements,
        duplicated: true
      };
    }

    const movements =
      payload.detail?.map((item) =>
        this.createMovementFromLineItem(event, item.goodsId, item.goodsName, item.quantity, item.unitPrice, {
          orderNo: event.orderNo
        })
      ) ?? [];

    for (const movement of movements) {
      this.store.inventory.unshift(movement);

      if (movement.type === "pickup") {
        const sourceBatches = new Map(
          this.store.getGoodsBatches(movement.deviceCode, movement.goodsId).map((entry) => [entry.batchId, entry])
        );
        const consumed = this.store.consumeGoodsBatches(movement.deviceCode, movement.goodsId, movement.quantity);
        const consumer = this.store.users.find((entry) => entry.id === movement.userId);
        movement.consumedBatches = consumed.consumed;
        movement.batchId = consumed.consumed.length === 1 ? consumed.consumed[0]?.batchId : undefined;

        for (const item of consumed.consumed) {
          const batch =
            sourceBatches.get(item.batchId) ??
            this.store.goodsBatches.find((entry) => entry.batchId === item.batchId);

          if (!batch) {
            continue;
          }

          this.store.recordBatchConsumption({
            id: this.store.createId("consumption-trace"),
            batchId: batch.batchId,
            goodsId: movement.goodsId,
            goodsName: movement.goodsName,
            deviceCode: movement.deviceCode,
            movementId: movement.id,
            operationType: movement.type,
            sourceUserId: batch.sourceUserId,
            sourceUserName: batch.sourceUserName,
            consumerUserId: movement.userId,
            consumerUserName: consumer?.name,
            quantity: item.quantity,
            happenedAt: movement.happenedAt,
            orderNo: movement.orderNo,
            eventId: event.eventId
          });
        }
      } else if (movement.type === "donation") {
        const catalogItem = this.store.ensureGoodsCatalogItem({
          goodsCode: movement.goodsId,
          goodsId: movement.goodsId,
          name: movement.goodsName,
          category: movement.category,
          price: movement.unitPrice,
          imageUrl:
            this.store.goodsCatalog.find((entry) => entry.goodsId === movement.goodsId)?.imageUrl ??
            "https://dummyimage.com/160x160/d8e8ff/0b1220.png&text=%E7%89%A9%E8%B5%84",
          status: "active"
        });
        this.store.ensureDeviceGoodsEntry(movement.deviceCode, {
          goodsCode: catalogItem.goodsCode,
          goodsId: catalogItem.goodsId,
          name: catalogItem.name,
          category: catalogItem.category,
          price: catalogItem.price,
          imageUrl: catalogItem.imageUrl
        });
        this.store.createGoodsBatch({
          goodsId: movement.goodsId,
          deviceCode: movement.deviceCode,
          quantity: movement.quantity,
          expiresAt: movement.expiresAt,
          sourceType: "merchant",
          sourceUserId: movement.userId,
          sourceUserName: this.store.users.find((entry) => entry.id === movement.userId)?.name
        });

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

    return {
      movements,
      duplicated: false
    };
  }

  recordAdjustment(event: CabinetEventRecord, payload: SmartVmAdjustmentPayload) {
    const existingMovements = this.store.inventory.filter(
      (entry) => entry.orderNo === payload.orderNo && entry.type === "adjustment"
    );

    if (existingMovements.length) {
      return {
        movements: existingMovements,
        duplicated: true
      };
    }

    const movements =
      payload.detail?.map((item) =>
        this.createMovementFromLineItem(
          event,
          item.goodsId,
          item.goodsName,
          item.quantity,
          item.unitPrice,
          {
            type: "adjustment",
            orderNo: payload.orderNo,
            sourceOrderNo: payload.orgOrderNo
          }
        )
      ) ?? [];

    for (const movement of movements) {
      if (movement.type === "adjustment" && movement.quantity > 0) {
        const consumed = this.store.consumeGoodsBatches(
          movement.deviceCode,
          movement.goodsId,
          movement.quantity
        );
        movement.consumedBatches = consumed.consumed;
        movement.batchId = consumed.consumed.length === 1 ? consumed.consumed[0]?.batchId : undefined;
        this.recordAdjustmentBatchConsumption(event, movement, consumed.consumed, payload.orderNo);
      }

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

    return {
      movements,
      duplicated: false
    };
  }

  logRefundCallback(payload: unknown) {
    this.store.logCallback("refund", payload);
  }

  handleRefundCallback(payload: SmartVmRefundPayload) {
    const event = this.findEventByPlatformOrderNo(payload.orderNo);

    if (!event) {
      this.store.logOperation({
        category: "inventory",
        type: "refund-callback",
        status: "warning",
        actor: {
          type: "system",
          name: "退款回调"
        },
        primarySubject: {
          type: "device",
          id: payload.deviceCode,
          label: payload.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: payload.orderNo,
          label: payload.orderNo
        },
        description: `订单 ${payload.orderNo} 收到退款回调，但本地未找到对应事件。`,
        detail: `退款单号 ${payload.refundNo}，交易号 ${payload.transactionId}，退款金额 ${payload.amount}。系统已接受回调并保留原始记录。`,
        relatedOrderNo: payload.orderNo,
        metadata: {
          amount: payload.amount,
          transactionId: payload.transactionId,
          refundNo: payload.refundNo,
          deviceCode: payload.deviceCode,
          matchedLocalOrder: false,
          undoState: "not_undoable"
        }
      });

      return {
        accepted: true,
        matchedLocalOrder: false,
        orderNo: payload.orderNo,
        transactionId: payload.transactionId,
        refundNo: payload.refundNo
      };
    }

    return this.markRefund(payload.orderNo, payload.transactionId, payload.amount, {
      source: "callback",
      refundNo: payload.refundNo
    });
  }

  markRefund(
    orderNo: string,
    transactionId: string,
    amount: number,
    options?: {
      source?: "manual" | "callback";
      refundNo?: string;
    }
  ) {
    const event = this.findEventByPlatformOrderNo(orderNo);

    if (!event) {
      throw new NotFoundException("未找到可退款的订单。");
    }

    const existingMovement = this.store.inventory.find(
      (entry) =>
        entry.orderNo === orderNo &&
        entry.type === "refund" &&
        entry.transactionId === transactionId
    );

    if (event.status === "refunded" && existingMovement) {
      return {
        movement: existingMovement,
        transactionId,
        duplicated: true
      };
    }

    const movement: InventoryMovement = {
      id: this.store.createId("movement"),
      orderNo,
      eventId: event.eventId,
      userId: event.userId,
      deviceCode: event.deviceCode,
      goodsId: event.goods[0]?.goodsId ?? "unknown",
      goodsName: event.goods[0]?.goodsName ?? "unknown",
      category: event.goods[0]?.category ?? "daily",
      quantity: event.goods.reduce((sum, item) => sum + item.quantity, 0) || 1,
      unitPrice: amount,
      type: "refund",
      happenedAt: new Date().toISOString(),
      transactionId,
      refundNo: options?.refundNo
    };

    const adjustment = event.adjustments?.find((entry) => entry.orderNo === orderNo);
    const isAdjustmentOrder = Boolean(adjustment);

    if (!isAdjustmentOrder) {
      event.status = "refunded";
    }
    event.updatedAt = new Date().toISOString();
    if (adjustment) {
      adjustment.refundNo = options?.refundNo;
      adjustment.refundTransactionId = transactionId;
      adjustment.refundedAt = event.updatedAt;
      adjustment.updatedAt = event.updatedAt;
      this.syncLatestAdjustmentFields(event);
    } else {
      event.refundNo = options?.refundNo;
      event.refundTransactionId = transactionId;
      event.refundedAt = event.updatedAt;
    }
    this.store.inventory.unshift(movement);

    const isCallback = options?.source === "callback";
    this.store.logOperation({
      category: "inventory",
      type: isCallback ? "refund-callback" : "manual-refund",
      status: "success",
      actor: isCallback
        ? {
            type: "system",
            name: "退款回调"
          }
        : {
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
      description: isCallback ? `订单 ${orderNo} 收到退款回调。` : `管理员对订单 ${orderNo} 执行了退款。`,
      detail: isCallback
        ? `退款单号 ${options?.refundNo ?? "-"}，退款金额 ${amount}，交易号 ${transactionId}。${isAdjustmentOrder ? " 当前退款对象为补扣订单。" : ""}`
        : `退款金额 ${amount}，交易号 ${transactionId}。${isAdjustmentOrder ? " 当前退款对象为补扣订单。" : ""}`,
      relatedEventId: event.eventId,
      relatedOrderNo: orderNo,
      metadata: {
        amount,
        transactionId,
        refundNo: options?.refundNo,
        undoState: "not_undoable"
      }
    });

    return {
      movement,
      transactionId
    };
  }

  findEventByPlatformOrderNo(orderNo: string) {
    return this.store.events.find(
      (entry) =>
        entry.orderNo === orderNo ||
        entry.adjustmentOrderNo === orderNo ||
        entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)
    );
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

  private recordAdjustmentBatchConsumption(
    event: CabinetEventRecord,
    movement: InventoryMovement,
    consumedBatches: BatchConsumptionLine[],
    orderNo: string
  ) {
    const consumer = this.store.users.find((entry) => entry.id === movement.userId);

    for (const item of consumedBatches) {
      const batch = this.store.goodsBatches.find((entry) => entry.batchId === item.batchId);
      this.store.recordBatchConsumption({
        id: this.store.createId("consumption-trace"),
        batchId: item.batchId,
        goodsId: movement.goodsId,
        goodsName: movement.goodsName,
        deviceCode: movement.deviceCode,
        movementId: movement.id,
        operationType: movement.type,
        sourceUserId: batch?.sourceUserId ?? item.sourceUserId,
        sourceUserName: batch?.sourceUserName ?? item.sourceUserName,
        consumerUserId: movement.userId,
        consumerUserName: consumer?.name,
        quantity: item.quantity,
        happenedAt: movement.happenedAt,
        orderNo,
        eventId: event.eventId,
        note: "柜机补扣回调按保质期最短批次扣减"
      });
    }
  }

  private createMovementFromLineItem(
    event: CabinetEventRecord,
    goodsId: string,
    goodsName: string,
    quantity: number,
    unitPrice: number,
    options?: {
      type?: InventoryMovement["type"];
      orderNo?: string;
      sourceOrderNo?: string;
    }
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
      orderNo: options?.orderNo ?? event.orderNo,
      sourceOrderNo: options?.sourceOrderNo,
      eventId: event.eventId,
      userId: event.userId,
      deviceCode: event.deviceCode,
      goodsId,
      goodsName,
      category,
      quantity,
      unitPrice,
      type: options?.type ?? (event.role === "merchant" ? "donation" : "pickup"),
      happenedAt: new Date().toISOString(),
      expiresAt
    };
  }
}
