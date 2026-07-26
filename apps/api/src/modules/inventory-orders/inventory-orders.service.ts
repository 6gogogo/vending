import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  CabinetAdjustmentRecord,
  CabinetEventRecord,
  GoodsCategory,
  InventoryMovement,
  SmartVmAdjustmentPayload,
  SmartVmRefundPayload,
  SmartVmSettlementPayload,
  UserRole
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";
import { DevicesService } from "../devices/devices.service";

export interface InventoryQuotaAllocationItem {
  goodsId: string;
  freeQuantity: number;
}

export interface InventoryQuotaAccountingOptions {
  /**
   * 调用方已经完成计价后得到的实际免费数量。
   * 传入空数组表示本次全部付费；省略则兼容未保存额度拆分的旧调用方。
   */
  quotaItems?: readonly InventoryQuotaAllocationItem[];
  /**
   * 物资变动仍需如实入账，但当前业务不再要求用户付款时，调用方关闭“待支付”告警。
   */
  suppressPaymentFollowup?: boolean;
}

@Injectable()
export class InventoryOrdersService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService) private readonly inventoryBatchChanges: InventoryBatchChangesService,
    @Inject(DevicesService) private readonly devicesService: DevicesService,
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  list(userId?: string, role?: UserRole, tenantId?: string) {
    return this.store.inventory.filter((entry) => {
      if (tenantId && !this.inventoryMovementBelongsToTenant(entry, tenantId)) {
        return false;
      }

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

  getMerchantSummary(userId: string, tenantId?: string) {
    const user = this.store.users.find((entry) => entry.id === userId);

    if (
      !user ||
      (tenantId && this.store.getUserTenantId(user) !== tenantId)
    ) {
      throw new NotFoundException("未找到对应人员。");
    }

    const records = this.store.inventory.filter(
      (entry) =>
        entry.userId === userId &&
        (!tenantId || this.inventoryMovementBelongsToTenant(entry, tenantId))
    );
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

  private inventoryMovementBelongsToTenant(
    entry: InventoryMovement,
    tenantId: string
  ) {
    const tenantIds: string[] = [];
    const user = this.store.users.find((candidate) => candidate.id === entry.userId);
    const device = this.store.devices.find(
      (candidate) => candidate.deviceCode === entry.deviceCode
    );

    if (user) {
      tenantIds.push(this.store.getUserTenantId(user));
    }

    if (device) {
      tenantIds.push(this.store.getDeviceTenantId(device));
    }

    return tenantIds.length > 0 && tenantIds.every((value) => value === tenantId);
  }

  validateSettlementPayload(event: CabinetEventRecord, payload: SmartVmSettlementPayload) {
    this.assertMoneyAmount(payload.amount, "结算金额");
    this.assertValidInventoryLines(event, payload.detail ?? [], this.resolveSettlementMovementType(event));
  }

  validateAdjustmentPayload(event: CabinetEventRecord, payload: SmartVmAdjustmentPayload) {
    this.assertMoneyAmount(payload.amount, "补扣金额");
    this.assertValidInventoryLines(event, payload.detail ?? [], "adjustment");
  }

  recordSettlement(
    event: CabinetEventRecord,
    payload: SmartVmSettlementPayload,
    quotaOptions?: InventoryQuotaAccountingOptions
  ) {
    this.validateSettlementPayload(event, payload);
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

    if (this.shouldSkipAutomaticSettlementInventory(event)) {
      return {
        movements: [],
        duplicated: Boolean(event.settlementComparison)
      };
    }

    const movementType = this.resolveSettlementMovementType(event);
    const quotaQuantityByGoods = this.buildQuotaQuantityByGoods(
      payload.detail ?? [],
      quotaOptions
    );
    const movements =
      payload.detail?.map((item) =>
        this.createMovementFromLineItem(event, item.goodsId, item.goodsName, item.quantity, item.unitPrice, {
          orderNo: event.orderNo,
          type: movementType,
          quotaQuantity:
            event.role === "special"
              ? this.takeQuotaQuantity(quotaQuantityByGoods, item.goodsId, item.quantity)
              : 0
        })
      ) ?? [];

    for (const movement of movements) {
      if (movement.type === "pickup") {
        this.inventoryBatchChanges.recordConsumptiveMovement({
          movement,
          trace: {
            eventId: event.eventId,
            orderNo: movement.orderNo
          }
        });
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
        this.inventoryBatchChanges.recordRestockMovement({
          movement,
          deviceGoods: catalogItem,
          batch: {
            expiresAt: movement.expiresAt,
            sourceType: "merchant",
            sourceUserId: movement.userId,
            sourceUserName: this.store.users.find((entry) => entry.id === movement.userId)?.name
          }
        });

        if (movement.expiresAt) {
          this.alertsService.create({
            type: "expiry",
            title: "商家投放物资待过期处理",
            deviceCode: movement.deviceCode,
            targetUserId: movement.userId,
            dueAt: movement.expiresAt,
            detail: `商品 ${movement.goodsId} 即将超过领取期限，请及时处理。`
          });
        }
      } else {
        this.store.inventory.unshift(movement);
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

  recordAdjustment(
    event: CabinetEventRecord,
    payload: SmartVmAdjustmentPayload,
    quotaOptions?: InventoryQuotaAccountingOptions
  ) {
    this.validateAdjustmentPayload(event, payload);
    const existingMovements = this.store.inventory.filter(
      (entry) => entry.orderNo === payload.orderNo && entry.type === "adjustment"
    );

    if (existingMovements.length) {
      return {
        movements: existingMovements,
        duplicated: true
      };
    }

    const happenedAt = this.resolveAdjustmentQuotaHappenedAt(event);
    const quotaQuantityByGoods = this.buildQuotaQuantityByGoods(
      payload.detail ?? [],
      quotaOptions
    );
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
            sourceOrderNo: payload.orgOrderNo,
            happenedAt,
            quotaQuantity:
              event.role !== "special"
                ? 0
                : quotaOptions?.quotaItems !== undefined
                  ? this.takeQuotaQuantity(quotaQuantityByGoods, item.goodsId, item.quantity)
                  : payload.amount > 0
                    ? 0
                    : item.quantity
          }
        )
      ) ?? [];

    for (const movement of movements) {
      if (movement.type === "adjustment" && movement.quantity > 0) {
        this.inventoryBatchChanges.recordConsumptiveMovement({
          movement,
          trace: {
            eventId: event.eventId,
            orderNo: payload.orderNo,
            note: "柜机补扣回调按保质期最短批次扣减"
          }
        });
      } else {
        this.store.inventory.unshift(movement);
      }
    }

    if (payload.amount > 0 && !quotaOptions?.suppressPaymentFollowup) {
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
      refundNo: payload.refundNo,
      deviceCode: payload.deviceCode
    });
  }

  previewRefund(
    orderNo: string,
    transactionId: string,
    amount: number,
    options?: { refundNo?: string; deviceCode?: string }
  ) {
    const validated = this.validateFullRefund(orderNo, transactionId, amount, options);
    return this.findRefundReplay(
      validated.event,
      validated.orderNo,
      validated.transactionId,
      validated.amount,
      validated.refundNo
    );
  }

  prepareManualRefund(body: unknown) {
    const payload = this.normalizeManualRefundPayload(body);
    const replay = this.reserveRefundIntent(
      payload.orderNo,
      payload.transactionId,
      payload.amount,
      {
        refundNo: payload.refundNo,
        deviceCode: payload.deviceCode
      }
    );

    return {
      payload,
      replay
    };
  }

  reserveRefundIntent(
    orderNo: string,
    transactionId: string,
    amount: number,
    options?: { refundNo?: string; deviceCode?: string }
  ) {
    const validated = this.validateFullRefund(orderNo, transactionId, amount, options);
    const replay = this.findRefundReplay(
      validated.event,
      validated.orderNo,
      validated.transactionId,
      validated.amount,
      validated.refundNo
    );

    if (replay) {
      this.reconcileManualRefundIntent(
        validated.event,
        validated.orderNo,
        validated.transactionId,
        validated.refundNo
      );
      return replay;
    }

    const pendingIntent = this.findPendingManualRefundIntent(validated.orderNo);

    if (pendingIntent) {
      throw new ConflictException(
        "该订单退款结果待确认，请先核对原退款意图或等待可信回调，不能更换退款号重复提交。"
      );
    }

    const admin = this.store.users.find((entry) => entry.role === "admin");
    const intent = this.store.logOperation({
      category: "inventory",
      type: "manual-refund-intent",
      status: "pending",
      actor: {
        type: "admin",
        id: admin?.id,
        name: admin?.name ?? "管理员",
        role: "admin"
      },
      primarySubject: {
        type: "device",
        id: validated.event.deviceCode,
        label: validated.event.deviceCode
      },
      secondarySubject: {
        type: "event",
        id: validated.event.eventId,
        label: validated.orderNo
      },
      description: `管理员准备对订单 ${validated.orderNo} 发起退款，渠道结果尚待确认。`,
      detail: `退款单号 ${validated.refundNo ?? "-"}，退款金额 ${validated.amount}，交易号 ${validated.transactionId}。在可信结果落地前禁止再次外呼。`,
      relatedEventId: validated.event.eventId,
      relatedOrderNo: validated.orderNo,
      metadata: {
        amount: validated.amount,
        transactionId: validated.transactionId,
        refundNo: validated.refundNo,
        deviceCode: validated.event.deviceCode,
        undoState: "not_undoable"
      }
    });

    // 退款外呼可能已经被渠道受理却丢失响应，因此必须先把幂等意图落盘。
    // 若持久化失败，在外呼前移除未落盘意图并失败，避免制造当前进程中的幽灵锁。
    try {
      this.store.persist();
    } catch (error) {
      const intentIndex = this.store.logs.findIndex((entry) => entry.id === intent.id);
      if (intentIndex >= 0) {
        this.store.logs.splice(intentIndex, 1);
      }
      throw error;
    }
    return undefined;
  }

  failManualRefundIntent(
    orderNo: string,
    transactionId: string,
    refundNo: string
  ) {
    const pendingIntent = this.findPendingManualRefundIntent(orderNo);

    if (
      !pendingIntent ||
      pendingIntent.metadata?.transactionId !== transactionId ||
      pendingIntent.metadata?.refundNo !== refundNo
    ) {
      return false;
    }

    const beforeMutation = structuredClone(pendingIntent);
    const failedAt = new Date().toISOString();
    pendingIntent.status = "failed";
    pendingIntent.description = `订单 ${orderNo} 的退款请求被渠道明确拒绝。`;
    pendingIntent.detail = "渠道已明确返回未受理；失败状态落盘后允许管理员重新核对并发起新请求。";
    pendingIntent.metadata = {
      ...(pendingIntent.metadata ?? {}),
      failedAt,
      outcome: "rejected",
      undoState: "not_undoable"
    };

    try {
      this.store.persist();
    } catch (error) {
      Object.assign(pendingIntent, beforeMutation);
      throw error;
    }

    return true;
  }

  markRefund(
    orderNo: string,
    transactionId: string,
    amount: number,
    options?: {
      source?: "manual" | "callback" | "payment-service";
      refundNo?: string;
      deviceCode?: string;
      actor?: { id: string; role: UserRole; name?: string };
    }
  ) {
    const validated = this.validateFullRefund(
      orderNo,
      transactionId,
      amount,
      options
    );
    const {
      event,
      adjustment,
      orderNo: normalizedOrderNo,
      transactionId: normalizedTransactionId,
      refundNo,
      amount: refundAmount
    } = validated;
    const replay = this.findRefundReplay(
      event,
      normalizedOrderNo,
      normalizedTransactionId,
      refundAmount,
      refundNo
    );

    if (replay) {
      this.reconcileManualRefundIntent(
        event,
        normalizedOrderNo,
        normalizedTransactionId,
        refundNo
      );
      return replay;
    }

    if (options?.source === "callback") {
      const pendingIntent = this.findPendingManualRefundIntent(normalizedOrderNo);
      if (
        pendingIntent &&
        (
          pendingIntent.metadata?.transactionId !== normalizedTransactionId ||
          pendingIntent.metadata?.refundNo !== refundNo
        )
      ) {
        this.recordManualRefundIntentIdentityConflict(
          event,
          normalizedOrderNo,
          pendingIntent,
          normalizedTransactionId,
          refundNo
        );
        throw new ConflictException(
          "退款回调与待确认退款意图标识不一致，已保留原锁并生成核对告警。"
        );
      }
    }

    const isAdjustmentOrder = Boolean(adjustment);
    const beforeMutation = {
      events: structuredClone(this.store.events),
      inventory: structuredClone(this.store.inventory),
      logs: structuredClone(this.store.logs),
      alerts: structuredClone(this.store.alerts)
    };

    try {
      const happenedAt = new Date().toISOString();
      const movements = this.buildRefundMovements(event, {
        orderNo: normalizedOrderNo,
        amount: refundAmount,
        transactionId: normalizedTransactionId,
        refundNo,
        adjustment,
        happenedAt
      });

      if (!isAdjustmentOrder) {
        event.status = "refunded";
      }
      event.updatedAt = happenedAt;
      if (adjustment) {
        adjustment.refundNo = refundNo;
        adjustment.refundTransactionId = normalizedTransactionId;
        adjustment.refundedAt = event.updatedAt;
        adjustment.updatedAt = event.updatedAt;
        this.syncLatestAdjustmentFields(event);
      } else {
        event.refundNo = refundNo;
        event.refundTransactionId = normalizedTransactionId;
        event.refundedAt = event.updatedAt;
      }
      this.store.inventory.unshift(...movements);
      this.reconcileManualRefundIntent(
        event,
        normalizedOrderNo,
        normalizedTransactionId,
        refundNo
      );

      const isCallback = options?.source === "callback";
      const requestActor = options?.actor;
      this.store.logOperation({
        category: "inventory",
        type: isCallback ? "refund-callback" : "manual-refund",
        status: "success",
        actor: isCallback
          ? {
              type: "system",
              name: "退款回调"
            }
          : requestActor
            ? {
                type: requestActor.role,
                id: requestActor.id,
                name:
                  requestActor.name ??
                  this.store.users.find((entry) => entry.id === requestActor.id)?.name ??
                  requestActor.id,
                role: requestActor.role
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
        description: isCallback
          ? `订单 ${normalizedOrderNo} 收到退款回调。`
          : `管理员对订单 ${normalizedOrderNo} 执行了退款。`,
        detail: isCallback
          ? `退款单号 ${refundNo ?? "-"}，退款金额 ${refundAmount}，交易号 ${normalizedTransactionId}。${isAdjustmentOrder ? " 当前退款对象为补扣订单。" : ""}`
          : `退款金额 ${refundAmount}，交易号 ${normalizedTransactionId}。${isAdjustmentOrder ? " 当前退款对象为补扣订单。" : ""}`,
        relatedEventId: event.eventId,
        relatedOrderNo: normalizedOrderNo,
        metadata: {
          amount: refundAmount,
          transactionId: normalizedTransactionId,
          refundNo,
          undoState: "not_undoable"
        }
      });

      this.alertsService.create({
        type: "callback",
        grade: "feedback",
        title: isAdjustmentOrder ? "补扣订单已退款" : "订单退款已完成",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: [
          `订单 ${normalizedOrderNo}`,
          `退款单号 ${refundNo ?? "-"}`,
          `退款金额 ${refundAmount}`,
          isAdjustmentOrder ? "当前退款对象为补扣订单。" : "系统已退回本次领取占用的免费额度。"
        ].join("；"),
        relatedEventId: event.eventId
      });

      return {
        movement: movements[0],
        movements,
        transactionId: normalizedTransactionId
      };
    } catch (error) {
      this.store.events.splice(0, this.store.events.length, ...beforeMutation.events);
      this.store.inventory.splice(0, this.store.inventory.length, ...beforeMutation.inventory);
      this.store.logs.splice(0, this.store.logs.length, ...beforeMutation.logs);
      this.store.alerts.splice(0, this.store.alerts.length, ...beforeMutation.alerts);
      throw error;
    }
  }

  private validateFullRefund(
    orderNo: string,
    transactionId: string,
    amount: number,
    options?: {
      refundNo?: string;
      deviceCode?: string;
      source?: "manual" | "callback" | "payment-service";
    }
  ) {
    const normalizedOrderNo = String(orderNo ?? "").trim();
    const normalizedTransactionId = String(transactionId ?? "").trim();
    const normalizedRefundNo = options?.refundNo?.trim();
    const normalizedAmount = Number(amount);

    if (!normalizedOrderNo || !normalizedTransactionId) {
      throw new BadRequestException("退款订单号和交易号不能为空。");
    }

    if (!Number.isFinite(normalizedAmount) || !Number.isInteger(normalizedAmount) || normalizedAmount <= 0) {
      throw new BadRequestException("退款金额必须是以分计的正整数。");
    }

    const event = this.findEventByPlatformOrderNo(normalizedOrderNo);

    if (!event) {
      throw new NotFoundException("未找到可退款的订单。");
    }

    if (options?.deviceCode && event.deviceCode !== options.deviceCode.trim()) {
      throw new BadRequestException("退款订单与柜机不匹配。");
    }

    const adjustment = event.adjustments?.find((entry) => entry.orderNo === normalizedOrderNo);
    const platformPaymentStatus = adjustment
      ? adjustment.paymentNotifyStatus
      : event.paymentNotifyStatus;
    const platformTransactionId = adjustment
      ? adjustment.paymentTransactionId
      : event.paymentTransactionId;
    const matchingPaymentOrders = this.store.paymentOrders.filter(
      (entry) =>
        entry.eventId === event.eventId &&
        (entry.adjustmentOrderNo ?? entry.orderNo) === normalizedOrderNo &&
        entry.status !== "failed" &&
        entry.status !== "closed"
    );
    const confirmedPaymentOrder = matchingPaymentOrders.find(
      (entry) =>
        (entry.status === "paid" || entry.status === "refunded") &&
        entry.providerTransactionId === normalizedTransactionId
    );
    const platformPaymentConfirmed =
      platformPaymentStatus === "success" &&
      platformTransactionId === normalizedTransactionId;

    if (!platformPaymentConfirmed && !confirmedPaymentOrder) {
      const knownTransactionId =
        platformTransactionId ??
        matchingPaymentOrders
          .map((entry) => entry.providerTransactionId)
          .find((entry): entry is string => Boolean(entry));
      if (knownTransactionId) {
        throw new BadRequestException("退款原支付交易号与已确认付款记录不一致。");
      }
      throw new BadRequestException("该业务订单尚未确认付款，不能发起退款。");
    }

    if (options?.source === "payment-service") {
      const coordinatorRefund = this.store.paymentRefunds.find(
        (entry) =>
          entry.refundNo === normalizedRefundNo &&
          entry.paymentOrderId === confirmedPaymentOrder?.id &&
          entry.providerOutcome === "success" &&
          entry.status === "pending"
      );
      if (!coordinatorRefund) {
        throw new ConflictException("缺少已确认的支付退款协调记录，拒绝应用退款副作用。");
      }
    } else {
      const coordinatedRefundExists = matchingPaymentOrders.some((paymentOrder) =>
        this.store.paymentRefunds.some(
          (entry) =>
            entry.paymentOrderId === paymentOrder.id &&
            (entry.status === "pending" || entry.status === "success")
        )
      );
      if (coordinatedRefundExists) {
        throw new ConflictException(
          "该订单已由支付退款协调器处理或等待确认，旧退款入口不能再次应用。"
        );
      }
    }

    const refundableAmount = Number(adjustment?.amount ?? event.amount);

    if (
      !Number.isFinite(refundableAmount) ||
      !Number.isInteger(refundableAmount) ||
      refundableAmount <= 0
    ) {
      throw new BadRequestException("该业务订单没有可执行的全额退款金额。");
    }

    if (normalizedAmount !== refundableAmount) {
      throw new BadRequestException(
        `旧退款入口仅支持整单全额退款，本单应退 ${refundableAmount} 分；部分退款请使用支付单退款接口。`
      );
    }

    const identityCollision = this.store.inventory.find(
      (entry) =>
        entry.type === "refund" &&
        entry.orderNo !== normalizedOrderNo &&
        ((normalizedRefundNo && entry.refundNo === normalizedRefundNo) ||
          entry.transactionId === normalizedTransactionId)
    );

    if (identityCollision) {
      throw new ConflictException("退款标识已被另一业务订单使用，拒绝重复应用退款副作用。");
    }

    const intentIdentityCollision = this.store.logs.find(
      (entry) =>
        entry.type === "manual-refund-intent" &&
        entry.relatedOrderNo !== normalizedOrderNo &&
        ((normalizedRefundNo && entry.metadata?.refundNo === normalizedRefundNo) ||
          entry.metadata?.transactionId === normalizedTransactionId)
    );

    if (intentIdentityCollision) {
      throw new ConflictException("退款标识已被另一业务订单的退款意图占用，拒绝重复外呼。");
    }

    return {
      event,
      adjustment,
      orderNo: normalizedOrderNo,
      transactionId: normalizedTransactionId,
      refundNo: normalizedRefundNo,
      amount: normalizedAmount
    };
  }

  private findRefundReplay(
    event: CabinetEventRecord,
    orderNo: string,
    transactionId: string,
    amount: number,
    refundNo?: string
  ) {
    const existingMovements = this.store.inventory.filter(
      (entry) =>
        entry.orderNo === orderNo &&
        entry.type === "refund" &&
        ((refundNo && entry.refundNo === refundNo) || entry.transactionId === transactionId)
    );

    if (existingMovements.length) {
      const matchingLog = this.store.logs.find(
        (entry) =>
          entry.relatedOrderNo === orderNo &&
          (entry.type === "refund-callback" || entry.type === "manual-refund") &&
          (entry.metadata?.refundNo === refundNo || entry.metadata?.transactionId === transactionId)
      );
      const loggedAmount = Number(matchingLog?.metadata?.amount);

      if (Number.isFinite(loggedAmount) && loggedAmount !== amount) {
        throw new ConflictException("相同退款标识已记录不同金额，拒绝冲突重放。");
      }

      return {
        movement: existingMovements[0],
        movements: existingMovements,
        transactionId: existingMovements[0]?.transactionId ?? transactionId,
        duplicated: true
      };
    }

    const targetAlreadyRefunded = event.adjustments?.some(
      (entry) => entry.orderNo === orderNo && Boolean(entry.refundedAt)
    )
      ? true
      : event.orderNo === orderNo && Boolean(event.refundedAt);

    if (targetAlreadyRefunded) {
      throw new ConflictException("该业务订单已退款，但本地退款流水不完整，请先人工核对，不能重复退款。");
    }

    return undefined;
  }

  private findPendingManualRefundIntent(orderNo: string) {
    return this.store.logs.find(
      (entry) =>
        entry.type === "manual-refund-intent" &&
        entry.relatedOrderNo === orderNo &&
        entry.status === "pending"
    );
  }

  private reconcileManualRefundIntent(
    event: CabinetEventRecord,
    orderNo: string,
    transactionId: string,
    refundNo?: string
  ) {
    const pendingIntent = this.findPendingManualRefundIntent(orderNo);

    if (!pendingIntent) {
      return;
    }

    if (
      pendingIntent.metadata?.transactionId !== transactionId ||
      pendingIntent.metadata?.refundNo !== refundNo
    ) {
      this.recordManualRefundIntentIdentityConflict(
        event,
        orderNo,
        pendingIntent,
        transactionId,
        refundNo
      );
      return;
    }

    const completedAt = new Date().toISOString();
    pendingIntent.status = "success";
    pendingIntent.description = `订单 ${orderNo} 的退款意图已由可信结果确认完成。`;
    pendingIntent.detail = `退款结果已确认，交易号 ${transactionId}，退款单号 ${refundNo ?? "-"}。`;
    pendingIntent.metadata = {
      ...(pendingIntent.metadata ?? {}),
      completedAt,
      resultTransactionId: transactionId,
      resultRefundNo: refundNo,
      undoState: "not_undoable"
    };
  }

  private recordManualRefundIntentIdentityConflict(
    event: CabinetEventRecord,
    orderNo: string,
    pendingIntent: { id: string; metadata?: Record<string, unknown> },
    transactionId: string,
    refundNo?: string
  ) {
    const alreadyLogged = this.store.logs.some(
      (entry) =>
        entry.type === "manual-refund-intent-identity-conflict" &&
        entry.relatedOrderNo === orderNo &&
        entry.metadata?.pendingIntentId === pendingIntent.id &&
        entry.metadata?.callbackTransactionId === transactionId &&
        entry.metadata?.callbackRefundNo === refundNo
    );

    if (!alreadyLogged) {
      this.store.logOperation({
        category: "inventory",
        type: "manual-refund-intent-identity-conflict",
        status: "warning",
        actor: {
          type: "system",
          name: "退款核对"
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
        description: `订单 ${orderNo} 的退款结果与待确认退款意图标识不一致。`,
        detail: "系统已记录可信退款结果，但保留原待确认意图，需人工核对是否存在两笔渠道退款。",
        relatedEventId: event.eventId,
        relatedOrderNo: orderNo,
        metadata: {
          pendingIntentId: pendingIntent.id,
          intentTransactionId: pendingIntent.metadata?.transactionId,
          intentRefundNo: pendingIntent.metadata?.refundNo,
          callbackTransactionId: transactionId,
          callbackRefundNo: refundNo,
          undoState: "not_undoable"
        }
      });
    }

    this.alertsService.create({
      type: "callback",
      grade: "fault",
      title: "退款回调与待确认意图不一致",
      deviceCode: event.deviceCode,
      dueAt: new Date().toISOString(),
      detail: `订单 ${orderNo} 的退款结果标识与原待确认意图不一致，请立即核对支付渠道，确认是否存在重复退款。`,
      relatedEventId: event.eventId,
      sourceLogId: pendingIntent.id
    });
  }

  private normalizeManualRefundPayload(body: unknown): SmartVmRefundPayload {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(body))
    ) {
      throw new BadRequestException("退款请求体必须是普通对象。");
    }

    const record = body as Record<string, unknown>;
    const allowedFields = new Set([
      "orderNo",
      "transactionId",
      "deviceCode",
      "refundNo",
      "amount"
    ]);
    const unexpectedField = Object.keys(record).find(
      (field) => !allowedFields.has(field)
    );

    if (unexpectedField) {
      throw new BadRequestException(`不支持的退款字段：${unexpectedField}。`);
    }

    const normalizeReference = (value: unknown, label: string) => {
      if (typeof value !== "string") {
        throw new BadRequestException(`${label}必须是字符串。`);
      }

      const normalized = value.trim();
      if (
        !normalized ||
        normalized.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(normalized)
      ) {
        throw new BadRequestException(`${label}不能为空、不能包含控制字符，且不能超过 128 个字符。`);
      }
      return normalized;
    };

    if (
      typeof record.amount !== "number" ||
      !Number.isSafeInteger(record.amount) ||
      record.amount <= 0
    ) {
      throw new BadRequestException("退款金额必须是以分计的正整数。");
    }

    return {
      orderNo: normalizeReference(record.orderNo, "退款订单号"),
      transactionId: normalizeReference(record.transactionId, "退款交易号"),
      deviceCode: normalizeReference(record.deviceCode, "柜机编号"),
      refundNo: normalizeReference(record.refundNo, "退款请求单号"),
      amount: record.amount
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

  private buildRefundMovements(
    event: CabinetEventRecord,
    payload: {
      orderNo: string;
      amount: number;
      transactionId: string;
      refundNo?: string;
      adjustment?: CabinetAdjustmentRecord;
      happenedAt: string;
    }
  ): InventoryMovement[] {
    const sourceMovements = this.store.inventory.filter(
      (entry) =>
        entry.orderNo === payload.orderNo &&
        entry.type === (payload.adjustment ? "adjustment" : "pickup")
    );
    const quotaQuantityByGoods = new Map<string, number>();
    for (const movement of sourceMovements) {
      quotaQuantityByGoods.set(
        movement.goodsId,
        (quotaQuantityByGoods.get(movement.goodsId) ?? 0) +
          this.resolveStoredQuotaQuantity(movement)
      );
    }

    const adjustmentGoods =
      payload.adjustment?.goods?.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: this.getGoodsCategory(event.deviceCode, item.goodsId),
        quantity: item.quantity,
        unitPrice: item.unitPrice
      })) ?? [];
    const sourceGoods = adjustmentGoods.length
      ? adjustmentGoods
      : event.goods.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: item.category,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        }));
    const fallbackGoods = sourceGoods.length
      ? sourceGoods
      : [
          {
            goodsId: "unknown",
            goodsName: "unknown",
            category: "daily" as GoodsCategory,
            quantity: 1,
            unitPrice: payload.amount
          }
        ];

    return fallbackGoods.map((item) => ({
      id: this.store.createId("movement"),
      orderNo: payload.orderNo,
      eventId: event.eventId,
      userId: event.userId,
      deviceCode: event.deviceCode,
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      category: item.category,
      quantity: item.quantity,
      quotaQuantity: sourceMovements.length
        ? this.takeQuotaQuantity(quotaQuantityByGoods, item.goodsId, item.quantity)
        : undefined,
      unitPrice: item.unitPrice,
      type: "refund",
      happenedAt: payload.happenedAt,
      transactionId: payload.transactionId,
      refundNo: payload.refundNo
    }));
  }

  private resolveStoredQuotaQuantity(movement: InventoryMovement) {
    const rawQuantity = movement.quotaQuantity ?? movement.quantity;

    if (!Number.isFinite(rawQuantity) || !Number.isInteger(rawQuantity)) {
      return 0;
    }

    return Math.min(Math.max(0, rawQuantity), Math.max(0, movement.quantity));
  }

  private getGoodsCategory(deviceCode: string, goodsId: string, fallback: GoodsCategory = "daily") {
    return (
      this.devicesService.findGoods(deviceCode, goodsId)?.category ??
      this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId)?.category ??
      fallback
    );
  }

  private resolveAdjustmentQuotaHappenedAt(event: CabinetEventRecord) {
    const mode = this.configService
      .get<string>("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE")
      ?.trim()
      .toLowerCase();
    const reservation = event.reservationId
      ? this.store.reservations.find((entry) => entry.id === event.reservationId)
      : undefined;

    if (mode === "callback_time") {
      return new Date().toISOString();
    }

    if (mode === "reservation_time") {
      return reservation?.reservedAt ?? event.createdAt;
    }

    if (mode === "transaction_time") {
      return event.createdAt;
    }

    return reservation?.reservedAt ?? event.createdAt;
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
      happenedAt?: string;
      quotaQuantity?: number;
    }
  ): InventoryMovement {
    const localGoods = this.devicesService.findGoods(event.deviceCode, goodsId);
    const catalogGoods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);
    const category = (localGoods?.category ?? catalogGoods?.category ?? "daily") as GoodsCategory;
    const user = this.store.users.find((entry) => entry.id === event.userId);
    const movementType = options?.type ?? (event.role === "merchant" ? "donation" : "pickup");
    const expiresAt =
      movementType === "donation" && event.role === "merchant"
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
      goodsName: localGoods?.name ?? catalogGoods?.name ?? goodsName,
      category,
      quantity,
      quotaQuantity: options?.quotaQuantity,
      unitPrice,
      type: movementType,
      happenedAt: options?.happenedAt ?? new Date().toISOString(),
      expiresAt
    };
  }

  private buildQuotaQuantityByGoods(
    detail: ReadonlyArray<{ goodsId: string; quantity: number }>,
    options?: InventoryQuotaAccountingOptions
  ) {
    if (options?.quotaItems === undefined) {
      return undefined;
    }

    const availableQuantityByGoods = new Map<string, number>();
    for (const item of detail) {
      availableQuantityByGoods.set(
        item.goodsId,
        (availableQuantityByGoods.get(item.goodsId) ?? 0) + item.quantity
      );
    }

    const quotaQuantityByGoods = new Map<string, number>();
    for (const item of options.quotaItems) {
      const goodsId = String(item.goodsId ?? "").trim();
      const freeQuantity = Number(item.freeQuantity);

      if (!goodsId || !availableQuantityByGoods.has(goodsId)) {
        throw new BadRequestException("免费额度分配包含本次库存明细之外的货品。");
      }

      if (
        !Number.isFinite(freeQuantity) ||
        !Number.isInteger(freeQuantity) ||
        freeQuantity < 0
      ) {
        throw new BadRequestException("免费额度分配数量必须是非负整数。");
      }

      const allocatedQuantity = (quotaQuantityByGoods.get(goodsId) ?? 0) + freeQuantity;
      if (allocatedQuantity > (availableQuantityByGoods.get(goodsId) ?? 0)) {
        throw new BadRequestException("免费额度分配数量不能超过本次货品数量。");
      }

      quotaQuantityByGoods.set(goodsId, allocatedQuantity);
    }

    return quotaQuantityByGoods;
  }

  private takeQuotaQuantity(
    quotaQuantityByGoods: Map<string, number> | undefined,
    goodsId: string,
    quantity: number
  ) {
    if (!quotaQuantityByGoods) {
      return undefined;
    }

    const remaining = quotaQuantityByGoods.get(goodsId) ?? 0;
    const allocated = Math.min(quantity, remaining);
    quotaQuantityByGoods.set(goodsId, Math.max(0, remaining - allocated));
    return allocated;
  }

  private shouldSkipAutomaticSettlementInventory(event: CabinetEventRecord) {
    return event.role !== "special" && event.hasInboundGoods === true;
  }

  private resolveSettlementMovementType(event: CabinetEventRecord): InventoryMovement["type"] | undefined {
    if (event.role !== "special" && event.hasInboundGoods === false) {
      return "pickup";
    }

    return undefined;
  }

  private assertValidInventoryLines(
    event: CabinetEventRecord,
    detail: SmartVmSettlementPayload["detail"] | SmartVmAdjustmentPayload["detail"],
    movementType: InventoryMovement["type"] | undefined
  ) {
    for (const item of detail ?? []) {
      const goodsId = String(item.goodsId ?? "").trim();
      const goodsName = String(item.goodsName ?? "").trim();
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);

      if (!goodsId) {
        throw new BadRequestException("库存回调货品编号不能为空。");
      }

      if (!goodsName) {
        throw new BadRequestException("库存回调货品名称不能为空。");
      }

      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
        throw new BadRequestException("库存回调货品数量必须是正整数。");
      }

      this.assertMoneyAmount(unitPrice, "库存回调货品单价");

      if (
        (movementType === "pickup" || movementType === "adjustment") &&
        !this.devicesService.findGoods(event.deviceCode, goodsId)
      ) {
        throw new BadRequestException(`柜机 ${event.deviceCode} 不包含货品 ${goodsId}，拒绝库存扣减。`);
      }
    }
  }

  private assertMoneyAmount(value: number, fieldName: string) {
    const amount = Number(value);

    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException(`${fieldName}必须是以分计的非负整数。`);
    }
  }
}
