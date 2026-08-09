import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";

import type {
  CabinetEventRecord,
  InventoryMovement,
  ManualSettlementCandidate,
  ManualSettlementConflictResolutionPayload,
  ManualSettlementCreatePayload,
  ManualSettlementItem,
  ManualSettlementOrderLinkPayload,
  ManualSettlementRecord,
  ManualSettlementRevertPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";

const MANUAL_SETTLEMENT_WAIT_MS = 10 * 60_000;

@Injectable()
export class ManualSettlementRecoveryService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService)
    private readonly inventoryBatchChanges: InventoryBatchChangesService,
    @Inject(AlertsService) private readonly alertsService: AlertsService
  ) {}

  listCandidates(userId: string | undefined, tenantId: string | undefined) {
    if (!tenantId) {
      throw new ForbiddenException("当前后台会话未绑定客户实例。");
    }

    const now = Date.now();
    const candidates: ManualSettlementCandidate[] = [];

    for (const event of this.store.events) {
      if (
        event.role !== "special" ||
        event.status !== "closed" ||
        event.physicalDoorState !== "closed" ||
        (userId && event.userId !== userId) ||
        event.refundedAt ||
        event.refundNo ||
        (event.manualSettlement && event.manualSettlement.status !== "reverted") ||
        this.hasSettlementMovement(event)
      ) {
        continue;
      }

      const user = this.store.users.find((entry) => entry.id === event.userId);
      const device = this.store.devices.find((entry) => entry.deviceCode === event.deviceCode);
      if (
        !user ||
        !device ||
        this.store.getUserTenantId(user) !== tenantId ||
        this.store.getDeviceTenantId(device) !== tenantId
      ) {
        continue;
      }

      const closeLog = this.store.callbackLog.find(
        (entry) =>
          entry.type === "door-status" &&
          entry.payload.eventId === event.eventId &&
          entry.payload.deviceCode === event.deviceCode &&
          entry.payload.status === "CLOSED"
      );
      const closedAt = closeLog?.receivedAt;
      const closedAtMs = closedAt ? Date.parse(closedAt) : Number.NaN;
      if (!closedAt || !Number.isFinite(closedAtMs) || now - closedAtMs < MANUAL_SETTLEMENT_WAIT_MS) {
        continue;
      }

      candidates.push({
        eventId: event.eventId,
        user: {
          id: user.id,
          name: user.name
        },
        device: {
          deviceCode: device.deviceCode,
          name: device.name
        },
        orderState: event.orderNo.startsWith("pending-") ? "awaiting_order" : "recorded",
        platformOrderNo: event.orderNo.startsWith("pending-") ? undefined : event.orderNo,
        closedAt,
        eligibleAt: new Date(closedAtMs + MANUAL_SETTLEMENT_WAIT_MS).toISOString(),
        waitingSeconds: Math.max(0, Math.floor((now - closedAtMs) / 1000)),
        intentItems: structuredClone(event.intentItems ?? [])
      });
    }

    return candidates.sort((left, right) => right.closedAt.localeCompare(left.closedAt));
  }

  create(
    eventId: string,
    payload: ManualSettlementCreatePayload,
    actor?: { id?: string; tenantId?: string }
  ) {
    const actorUserId = actor?.id?.trim();
    if (!actorUserId) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }
    if (!actor?.tenantId) {
      throw new ForbiddenException("当前后台会话未绑定客户实例。");
    }

    const event = this.store.events.find((entry) => entry.eventId === eventId);
    if (!event) {
      throw new NotFoundException("未找到对应开柜事件。");
    }
    this.assertEventTenant(event, actor.tenantId);

    if (event.manualSettlement && event.manualSettlement.status !== "reverted") {
      const requestedItems = this.normalizeItemIdentities(payload.items);
      const requestedPlatformOrderNo = payload.platformOrderNo?.trim() || undefined;
      if (
        event.manualSettlement.reason === payload.reason?.trim() &&
        this.itemIdentitiesEqual(event.manualSettlement.items, requestedItems) &&
        (
          requestedPlatformOrderNo === undefined ||
          requestedPlatformOrderNo === event.manualSettlement.platformOrderNo
        )
      ) {
        return structuredClone(event.manualSettlement);
      }
      throw new ConflictException("该开柜事件已经完成过不同内容的人工结算补记。");
    }

    const eligible = this.findEligibleCandidate(event, actor.tenantId);
    if (!eligible) {
      throw new BadRequestException(
        "只有特殊群体柜门可信关闭满 10 分钟且尚无结算流水的事件才能人工补记。"
      );
    }
    if (payload.confirmed !== true) {
      throw new BadRequestException("请确认实际取走商品后再提交人工结算补记。");
    }

    const reason = payload.reason?.trim();
    if (!reason) {
      throw new BadRequestException("请填写人工结算补记的处理依据。");
    }

    const items = this.normalizeItems(event.deviceCode, payload.items);
    const currentOrderNo = event.orderNo.startsWith("pending-")
      ? payload.platformOrderNo?.trim()
      : event.orderNo;
    if (
      !event.orderNo.startsWith("pending-") &&
      payload.platformOrderNo?.trim() &&
      payload.platformOrderNo.trim() !== event.orderNo
    ) {
      throw new ConflictException("平台订单号与开柜事件已经记录的订单号不一致。");
    }

    return this.store.runAtomicMutation(() => {
      const now = new Date().toISOString();
      if (currentOrderNo) {
        this.assertUniquePlatformOrderNo(currentOrderNo, event.eventId);
      }
      const movementOrderNo = currentOrderNo ?? event.orderNo;
      const movements: InventoryMovement[] = [];

      for (const item of items) {
        const movement: InventoryMovement = {
          id: this.store.createId("movement"),
          orderNo: movementOrderNo,
          eventId: event.eventId,
          userId: event.userId,
          deviceCode: event.deviceCode,
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: item.category,
          quantity: item.quantity,
          quotaQuantity: item.quantity,
          unitPrice: item.unitPrice,
          type: "pickup",
          settlementSource: "manual_recovery",
          happenedAt: eligible.closedAt
        };
        this.inventoryBatchChanges.recordConsumptiveMovement({
          movement,
          trace: {
            eventId: event.eventId,
            orderNo: movementOrderNo,
            note: "人工结算补记"
          }
        });
        movements.push(movement);
      }

      event.status = "settled";
      event.goods = structuredClone(items);
      event.amount = 0;
      event.billingStatus = "admin_confirmed";
      event.billingResolvedAt = now;
      event.billingConfirmedByUserId = actorUserId;
      event.billingResolutionNote = reason;
      event.updatedAt = now;
      if (currentOrderNo) {
        event.orderNo = currentOrderNo;
        event.paymentNotifyStatus = "pending";
        event.paymentNotifyMessage = "本地人工结算补记已完成，等待平台完成回写。";
      }

      const record: ManualSettlementRecord = {
        id: this.store.createId("manual-settlement"),
        eventId: event.eventId,
        status: currentOrderNo ? "awaiting_platform_completion" : "awaiting_order",
        platformOrderNo: currentOrderNo,
        items: structuredClone(items),
        movementIds: movements.map((entry) => entry.id),
        reason,
        handledAt: now,
        handledByUserId: actorUserId
      };
      event.manualSettlement = record;
      this.resolveCandidateAlert(event.eventId, actorUserId, reason);

      const user = this.store.users.find((entry) => entry.id === event.userId);
      this.store.logOperation({
        category: "admin",
        type: "manual-settlement-recovery",
        status: "success",
        actor: {
          type: "admin",
          id: actorUserId,
          name: this.store.users.find((entry) => entry.id === actorUserId)?.name ?? "实例管理员",
          role: "admin"
        },
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: currentOrderNo ?? event.eventId
        },
        secondarySubject: {
          type: "user",
          id: event.userId,
          label: user?.name ?? event.userId
        },
        description: `实例管理员为事件 ${event.eventId} 完成了人工结算补记。`,
        detail: reason,
        relatedEventId: event.eventId,
        relatedOrderNo: currentOrderNo,
        metadata: {
          manualSettlementId: record.id,
          source: "manual_recovery",
          items: items.map((item) => ({ goodsId: item.goodsId, quantity: item.quantity })),
          movementIds: record.movementIds,
          undoState: "undoable"
        }
      });

      return structuredClone(record);
    });
  }

  linkOrder(
    eventId: string,
    payload: ManualSettlementOrderLinkPayload,
    actor?: { id?: string; tenantId?: string }
  ) {
    const actorUserId = actor?.id?.trim();
    if (!actorUserId) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }
    if (!actor?.tenantId) {
      throw new ForbiddenException("当前后台会话未绑定客户实例。");
    }

    const event = this.store.events.find((entry) => entry.eventId === eventId);
    if (!event) {
      throw new NotFoundException("未找到对应开柜事件。");
    }
    this.assertEventTenant(event, actor.tenantId);
    const record = event.manualSettlement;
    if (!record) {
      throw new BadRequestException("该开柜事件尚未完成人工结算补记。");
    }

    const platformOrderNo = payload.platformOrderNo?.trim();
    if (!platformOrderNo || platformOrderNo.length > 128 || platformOrderNo.startsWith("pending-")) {
      throw new BadRequestException("请填写有效的平台订单号。");
    }
    if (record.platformOrderNo === platformOrderNo) {
      return structuredClone(record);
    }
    if (record.status !== "awaiting_order" || record.platformOrderNo) {
      throw new ConflictException("该人工结算补记已经关联其他平台订单号。");
    }
    this.assertUniquePlatformOrderNo(platformOrderNo, event.eventId);
    const linkedOrderNo = platformOrderNo;

    return this.store.runAtomicMutation(() => {
      const now = new Date().toISOString();
      event.orderNo = linkedOrderNo;
      event.updatedAt = now;
      event.paymentNotifyStatus = "pending";
      event.paymentNotifyMessage = "本地人工结算补记已完成，等待平台完成回写。";
      record.platformOrderNo = linkedOrderNo;
      record.status = "awaiting_platform_completion";
      record.orderLinkedAt = now;
      record.orderLinkedByUserId = actorUserId;

      for (const movement of this.store.inventory) {
        if (record.movementIds.includes(movement.id)) {
          movement.orderNo = linkedOrderNo;
        }
      }
      for (const trace of this.store.batchConsumptionTraces) {
        if (trace.movementId && record.movementIds.includes(trace.movementId)) {
          trace.orderNo = linkedOrderNo;
        }
      }

      this.store.logOperation({
        category: "admin",
        type: "manual-settlement-order-link",
        status: "success",
        actor: {
          type: "admin",
          id: actorUserId,
          name: this.store.users.find((entry) => entry.id === actorUserId)?.name ?? "实例管理员",
          role: "admin"
        },
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: linkedOrderNo
        },
        description: `实例管理员为人工结算补记关联了平台订单 ${linkedOrderNo}。`,
        relatedEventId: event.eventId,
        relatedOrderNo: linkedOrderNo,
        metadata: {
          manualSettlementId: record.id,
          undoState: "not_undoable"
        }
      });

      return structuredClone(record);
    });
  }

  getPlatformCompletionRecord(
    eventId: string,
    actor?: { id?: string; tenantId?: string }
  ) {
    if (!actor?.id?.trim()) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }
    if (!actor.tenantId) {
      throw new ForbiddenException("当前后台会话未绑定客户实例。");
    }

    const event = this.store.events.find((entry) => entry.eventId === eventId);
    if (!event) {
      throw new NotFoundException("未找到对应开柜事件。");
    }
    this.assertEventTenant(event, actor.tenantId);
    const record = event.manualSettlement;
    if (!record || !record.platformOrderNo) {
      throw new BadRequestException("请先完成本地补记并关联平台订单号。");
    }
    if (
      record.status !== "awaiting_platform_completion" &&
      record.status !== "platform_completed" &&
      record.status !== "callback_reconciled"
    ) {
      throw new ConflictException("当前人工结算补记状态不能执行平台完成回写。");
    }

    return structuredClone(record);
  }

  recordLateCallback(
    event: CabinetEventRecord,
    payload: SmartVmSettlementPayload,
    callbackLog: { id: string; receivedAt: string }
  ) {
    const record = event.manualSettlement;
    if (!record || record.status === "reverted") {
      return undefined;
    }

    const platformOrderNo = payload.orderNo.trim();
    if (record.platformOrderNo && record.platformOrderNo !== platformOrderNo) {
      throw new ConflictException("迟到结算回调的平台订单号与人工补记记录不一致。");
    }
    const callbackItems = this.normalizeCallbackItems(event.deviceCode, payload.detail ?? []);
    const matched = this.itemsEqualWithPrice(record.items, callbackItems);

    if (record.lateCallback) {
      if (
        record.lateCallback.platformAmount === payload.amount &&
        record.lateCallback.notifyUrl === payload.notifyUrl &&
        this.itemsEqualWithPrice(record.lateCallback.items, callbackItems)
      ) {
        return {
          record: structuredClone(record),
          matched: record.lateCallback.matched,
          duplicated: true
        };
      }
      throw new ConflictException("该事件已经留存另一份可信迟到结算回调，拒绝覆盖。");
    }

    return this.store.runAtomicMutation(() => {
      const now = callbackLog.receivedAt;
      if (!record.platformOrderNo) {
        this.assertUniquePlatformOrderNo(platformOrderNo, event.eventId);
        record.platformOrderNo = platformOrderNo;
        record.orderLinkedAt = now;
        event.orderNo = platformOrderNo;
        for (const movement of this.store.inventory) {
          if (record.movementIds.includes(movement.id)) {
            movement.orderNo = platformOrderNo;
          }
        }
        for (const trace of this.store.batchConsumptionTraces) {
          if (trace.movementId && record.movementIds.includes(trace.movementId)) {
            trace.orderNo = platformOrderNo;
          }
        }
      }

      record.lateCallback = {
        callbackLogId: callbackLog.id,
        receivedAt: now,
        platformAmount: payload.amount,
        notifyUrl: payload.notifyUrl,
        items: structuredClone(callbackItems),
        matched
      };
      record.status = matched ? "callback_reconciled" : "conflict";
      event.platformAmount = payload.amount;
      event.paymentNotifyUrl = payload.notifyUrl;
      event.paymentNotifyMessage = matched
        ? "迟到结算回调与人工补记一致，未重复扣减库存或额度。"
        : "迟到结算回调与人工补记明细不一致，等待实例管理员核对。";
      event.updatedAt = now;

      if (!matched) {
        this.alertsService.create({
          type: "callback",
          grade: "warning",
          title: "人工结算补记与迟到回调明细冲突",
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: now,
          detail: `事件 ${event.eventId} 的人工补记明细与平台迟到结算回调不一致，请人工核对。`,
          relatedEventId: event.eventId
        });
      }

      this.store.logOperation({
        category: "inventory",
        type: matched
          ? "manual-settlement-late-callback-reconciled"
          : "manual-settlement-late-callback-conflict",
        status: matched ? "success" : "warning",
        actor: {
          type: "system",
          name: "柜机结算回调"
        },
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: platformOrderNo
        },
        description: matched
          ? `事件 ${event.eventId} 的迟到结算回调与人工补记一致。`
          : `事件 ${event.eventId} 的迟到结算回调与人工补记存在明细冲突。`,
        relatedEventId: event.eventId,
        relatedOrderNo: platformOrderNo,
        metadata: {
          manualSettlementId: record.id,
          callbackLogId: callbackLog.id,
          matched,
          undoState: "not_undoable"
        }
      });

      return {
        record: structuredClone(record),
        matched,
        duplicated: false
      };
    });
  }

  resolveConflict(
    eventId: string,
    payload: ManualSettlementConflictResolutionPayload,
    actor?: { id?: string; tenantId?: string }
  ) {
    const actorUserId = actor?.id?.trim();
    if (!actorUserId) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }
    if (!actor?.tenantId) {
      throw new ForbiddenException("当前后台会话未绑定客户实例。");
    }
    const event = this.store.events.find((entry) => entry.eventId === eventId);
    if (!event) {
      throw new NotFoundException("未找到对应开柜事件。");
    }
    this.assertEventTenant(event, actor.tenantId);
    const record = event.manualSettlement;
    if (!record?.lateCallback) {
      throw new BadRequestException("该人工结算补记没有可核对的迟到回调。");
    }
    const lateCallback = record.lateCallback;

    const resolution = payload.resolution;
    if (resolution !== "keep_manual" && resolution !== "use_platform") {
      throw new BadRequestException("请选择保留人工结果或按平台结果修正。");
    }
    const reason = payload.reason?.trim();
    if (!reason) {
      throw new BadRequestException("请填写明细冲突的核对依据。");
    }
    if (record.conflictResolution) {
      if (
        record.conflictResolution === resolution &&
        record.conflictResolutionReason === reason
      ) {
        return structuredClone(record);
      }
      throw new ConflictException("该明细冲突已经按其他结果完成核对，拒绝覆盖。");
    }
    if (record.status !== "conflict" || lateCallback.matched) {
      throw new ConflictException("当前人工结算补记不处于待核对的明细冲突状态。");
    }

    return this.store.runAtomicMutation(() => {
      const now = new Date().toISOString();
      if (resolution === "use_platform") {
        const settlementHappenedAt = this.resolveManualSettlementHappenedAt(
          event,
          record
        );
        const reversals = this.reverseManualMovements(event, record);
        record.reversalMovementIds = reversals.map((entry) => entry.id);
        const platformMovements: InventoryMovement[] = [];
        for (const item of lateCallback.items) {
          const movement: InventoryMovement = {
            id: this.store.createId("movement"),
            orderNo: record.platformOrderNo ?? event.orderNo,
            eventId: event.eventId,
            userId: event.userId,
            deviceCode: event.deviceCode,
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            category: item.category,
            quantity: item.quantity,
            quotaQuantity: item.quantity,
            unitPrice: item.unitPrice,
            type: "pickup",
            settlementSource: "platform_callback",
            happenedAt: settlementHappenedAt
          };
          this.inventoryBatchChanges.recordConsumptiveMovement({
            movement,
            trace: {
              eventId: event.eventId,
              orderNo: movement.orderNo,
              note: "人工结算冲突按平台迟到回调修正"
            }
          });
          platformMovements.push(movement);
        }
        record.platformMovementIds = platformMovements.map((entry) => entry.id);
        event.goods = structuredClone(lateCallback.items);
      }

      record.status = "callback_reconciled";
      record.conflictResolution = resolution;
      record.conflictResolvedAt = now;
      record.conflictResolvedByUserId = actorUserId;
      record.conflictResolutionReason = reason;
      event.billingStatus = "admin_confirmed";
      event.billingResolvedAt = now;
      event.billingConfirmedByUserId = actorUserId;
      event.billingResolutionNote = reason;
      event.paymentNotifyMessage =
        "迟到结算回调明细冲突已人工核对，等待平台完成回写。";
      event.updatedAt = now;

      for (const alert of this.store.alerts) {
        if (
          alert.relatedEventId === event.eventId &&
          alert.title === "人工结算补记与迟到回调明细冲突" &&
          alert.status !== "resolved"
        ) {
          this.alertsService.resolve(alert.id, actorUserId, reason);
        }
      }

      this.store.logOperation({
        category: "admin",
        type: "manual-settlement-conflict-resolution",
        status: "success",
        actor: {
          type: "admin",
          id: actorUserId,
          name: this.store.users.find((entry) => entry.id === actorUserId)?.name ?? "实例管理员",
          role: "admin"
        },
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: record.platformOrderNo ?? event.eventId
        },
        description:
          resolution === "use_platform"
            ? `实例管理员按平台迟到回调修正了事件 ${event.eventId} 的人工结算结果。`
            : `实例管理员确认保留事件 ${event.eventId} 的人工结算结果。`,
        detail: reason,
        relatedEventId: event.eventId,
        relatedOrderNo: record.platformOrderNo,
        metadata: {
          manualSettlementId: record.id,
          resolution,
          reversalMovementIds: record.reversalMovementIds,
          platformMovementIds: record.platformMovementIds,
          undoState: "not_undoable"
        }
      });

      return structuredClone(record);
    });
  }

  revert(
    eventId: string,
    payload: ManualSettlementRevertPayload,
    actor?: { id?: string; tenantId?: string }
  ) {
    const actorUserId = actor?.id?.trim();
    if (!actorUserId) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }
    if (!actor?.tenantId) {
      throw new ForbiddenException("当前后台会话未绑定客户实例。");
    }

    const event = this.store.events.find((entry) => entry.eventId === eventId);
    if (!event) {
      throw new NotFoundException("未找到对应开柜事件。");
    }
    this.assertEventTenant(event, actor.tenantId);
    const record = event.manualSettlement;
    if (!record) {
      throw new BadRequestException("该开柜事件尚未完成人工结算补记。");
    }
    if (record.status === "reverted") {
      return structuredClone(record);
    }
    if (
      record.status !== "awaiting_order" &&
      record.status !== "awaiting_platform_completion"
    ) {
      throw new ConflictException("当前人工结算补记状态不能直接撤销。");
    }
    if (event.paymentNotifyStatus === "success" || record.platformCompletedAt) {
      throw new ConflictException("平台完成回写成功后不能直接撤销，请通过冲突核对处理。");
    }

    const reason = payload.reason?.trim();
    if (!reason) {
      throw new BadRequestException("请填写撤销人工结算补记的原因。");
    }

    return this.store.runAtomicMutation(() => {
      const now = new Date().toISOString();
      const reversalMovements: InventoryMovement[] = [];

      for (const movementId of record.movementIds) {
        const source = this.store.inventory.find(
          (entry) =>
            entry.id === movementId &&
            entry.eventId === event.eventId &&
            entry.type === "pickup" &&
            entry.settlementSource === "manual_recovery"
        );
        if (!source?.consumedBatches?.length) {
          throw new ConflictException("人工结算补记缺少完整批次消耗明细，不能安全撤销。");
        }

        const reversal: InventoryMovement = {
          id: this.store.createId("movement"),
          orderNo: source.orderNo ?? event.orderNo,
          sourceOrderNo: source.orderNo ?? event.orderNo,
          eventId: event.eventId,
          userId: event.userId,
          deviceCode: event.deviceCode,
          goodsId: source.goodsId,
          goodsName: source.goodsName,
          category: source.category,
          quantity: source.quantity,
          quotaQuantity: source.quotaQuantity ?? source.quantity,
          unitPrice: source.unitPrice,
          type: "refund",
          happenedAt: source.happenedAt
        };
        this.inventoryBatchChanges.undoConsumptiveBatchChange({
          deviceCode: event.deviceCode,
          consumedBatches: structuredClone(source.consumedBatches),
          movement: reversal
        });
        reversalMovements.push(reversal);
      }

      record.status = "reverted";
      record.reversalMovementIds = reversalMovements.map((entry) => entry.id);
      record.revertedAt = now;
      record.revertedByUserId = actorUserId;
      record.revertReason = reason;
      event.status = "closed";
      event.goods = [];
      event.amount = 0;
      event.platformAmount = undefined;
      event.billingStatus = "pending";
      event.billingResolvedAt = undefined;
      event.billingConfirmedByUserId = undefined;
      event.billingResolutionNote = undefined;
      event.paymentNotifyStatus = undefined;
      event.paymentNotifyMessage = "人工结算补记已撤销，等待重新核对。";
      event.updatedAt = now;
      this.reopenCandidateAlert(event, now);

      this.store.logOperation({
        category: "admin",
        type: "manual-settlement-revert",
        status: "success",
        actor: {
          type: "admin",
          id: actorUserId,
          name: this.store.users.find((entry) => entry.id === actorUserId)?.name ?? "实例管理员",
          role: "admin"
        },
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: record.platformOrderNo ?? event.eventId
        },
        description: `实例管理员撤销了事件 ${event.eventId} 的人工结算补记。`,
        detail: reason,
        relatedEventId: event.eventId,
        relatedOrderNo: record.platformOrderNo,
        metadata: {
          manualSettlementId: record.id,
          sourceMovementIds: record.movementIds,
          reversalMovementIds: record.reversalMovementIds,
          undoState: "undone"
        }
      });

      return structuredClone(record);
    });
  }

  private reverseManualMovements(
    event: CabinetEventRecord,
    record: ManualSettlementRecord
  ) {
    const reversalMovements: InventoryMovement[] = [];
    for (const movementId of record.movementIds) {
      const source = this.store.inventory.find(
        (entry) =>
          entry.id === movementId &&
          entry.eventId === event.eventId &&
          entry.type === "pickup" &&
          entry.settlementSource === "manual_recovery"
      );
      if (!source?.consumedBatches?.length) {
        throw new ConflictException("人工结算补记缺少完整批次消耗明细，不能安全反向恢复。");
      }
      const reversal: InventoryMovement = {
        id: this.store.createId("movement"),
        orderNo: source.orderNo ?? event.orderNo,
        sourceOrderNo: source.orderNo ?? event.orderNo,
        eventId: event.eventId,
        userId: event.userId,
        deviceCode: event.deviceCode,
        goodsId: source.goodsId,
        goodsName: source.goodsName,
        category: source.category,
        quantity: source.quantity,
        quotaQuantity: source.quotaQuantity ?? source.quantity,
        unitPrice: source.unitPrice,
        type: "refund",
        happenedAt: source.happenedAt
      };
      this.inventoryBatchChanges.undoConsumptiveBatchChange({
        deviceCode: event.deviceCode,
        consumedBatches: structuredClone(source.consumedBatches),
        movement: reversal
      });
      reversalMovements.push(reversal);
    }
    return reversalMovements;
  }

  private resolveCandidateAlert(eventId: string, actorUserId: string, reason: string) {
    for (const alert of this.store.alerts) {
      if (
        alert.relatedEventId === eventId &&
        alert.title === "结算回调超时待补记" &&
        alert.status !== "resolved"
      ) {
        this.alertsService.resolve(alert.id, actorUserId, reason);
      }
    }
  }

  private reopenCandidateAlert(event: CabinetEventRecord, dueAt: string) {
    const existing = this.store.alerts.find(
      (entry) =>
        entry.relatedEventId === event.eventId &&
        entry.title === "结算回调超时待补记"
    );
    if (existing) {
      existing.status = "open";
      existing.dueAt = dueAt;
      existing.resolvedAt = undefined;
      existing.resolvedByUserId = undefined;
      existing.resolutionNote = undefined;
      this.store.decorateAlert(existing);
      return;
    }
    this.alertsService.create({
      type: "callback",
      grade: "warning",
      title: "结算回调超时待补记",
      deviceCode: event.deviceCode,
      targetUserId: event.userId,
      dueAt,
      detail: `事件 ${event.eventId} 的人工结算补记已撤销，请重新核对实际取走商品。`,
      relatedEventId: event.eventId
    });
  }

  private hasSettlementMovement(event: CabinetEventRecord) {
    const ignoredMovementIds =
      event.manualSettlement?.status === "reverted"
        ? new Set(event.manualSettlement.movementIds)
        : undefined;

    return this.store.inventory.some(
      (entry) =>
        !ignoredMovementIds?.has(entry.id) &&
        (
          entry.eventId === event.eventId ||
          (
            !entry.eventId &&
            entry.orderNo === event.orderNo &&
            entry.deviceCode === event.deviceCode &&
            entry.userId === event.userId
          )
        ) &&
        (entry.type === "pickup" || entry.type === "donation")
    );
  }

  private findEligibleCandidate(
    event: (typeof this.store.events)[number],
    tenantId: string
  ) {
    return this.listCandidates(event.userId, tenantId).find(
      (entry) => entry.eventId === event.eventId
    );
  }

  private assertEventTenant(event: (typeof this.store.events)[number], tenantId: string) {
    const user = this.store.users.find((entry) => entry.id === event.userId);
    const device = this.store.devices.find((entry) => entry.deviceCode === event.deviceCode);
    if (
      !user ||
      !device ||
      this.store.getUserTenantId(user) !== tenantId ||
      this.store.getDeviceTenantId(device) !== tenantId
    ) {
      throw new NotFoundException("未找到对应开柜事件。");
    }
  }

  private normalizeItems(
    deviceCode: string,
    rawItems: ManualSettlementCreatePayload["items"]
  ): ManualSettlementItem[] {
    const identities = this.normalizeItemIdentities(rawItems);

    return identities.map((rawItem) => {
      const catalogItem = this.store.goodsCatalog.find(
        (entry) => entry.goodsId === rawItem.goodsId && entry.status === "active"
      );
      const listedOnDevice = this.store.devices
        .find((entry) => entry.deviceCode === deviceCode)
        ?.doors.some((door) =>
          door.goods.some((goods) => goods.goodsId === rawItem.goodsId)
        );
      if (!catalogItem || !listedOnDevice) {
        throw new BadRequestException(
          `商品 ${rawItem.goodsId} 尚未在该柜机完成货品建档，不能用于人工结算补记。`
        );
      }

      return {
        goodsId: rawItem.goodsId,
        goodsName: catalogItem.name,
        category: catalogItem.category,
        quantity: rawItem.quantity,
        unitPrice: catalogItem.price
      };
    });
  }

  private normalizeItemIdentities(
    rawItems: ManualSettlementCreatePayload["items"]
  ) {
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 50) {
      throw new BadRequestException("请填写 1 至 50 条实际取走商品明细。");
    }

    const seen = new Set<string>();
    return rawItems.map((rawItem) => {
      const goodsId = rawItem?.goodsId?.trim();
      if (!goodsId) {
        throw new BadRequestException("实际取走商品编号不能为空。");
      }
      if (seen.has(goodsId)) {
        throw new BadRequestException("同一商品只能填写一次，请合并数量。");
      }
      seen.add(goodsId);
      if (!Number.isSafeInteger(rawItem.quantity) || rawItem.quantity <= 0) {
        throw new BadRequestException("实际取走数量必须是正整数。");
      }

      return {
        goodsId,
        quantity: rawItem.quantity
      };
    });
  }

  private itemIdentitiesEqual(
    left: Array<{ goodsId: string; quantity: number }>,
    right: Array<{ goodsId: string; quantity: number }>
  ) {
    const normalize = (items: Array<{ goodsId: string; quantity: number }>) =>
      [...items]
        .map((item) => ({ goodsId: item.goodsId, quantity: item.quantity }))
        .sort((a, b) => a.goodsId.localeCompare(b.goodsId));
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  private itemsEqual(left: ManualSettlementItem[], right: ManualSettlementItem[]) {
    return this.itemIdentitiesEqual(left, right);
  }

  private resolveManualSettlementHappenedAt(
    event: CabinetEventRecord,
    record: ManualSettlementRecord
  ) {
    return (
      record.movementIds
        .map((movementId) =>
          this.store.inventory.find(
            (entry) =>
              entry.id === movementId && entry.eventId === event.eventId
          )
        )
        .find((entry): entry is InventoryMovement => Boolean(entry))
        ?.happenedAt ?? record.handledAt
    );
  }

  private itemsEqualWithPrice(left: ManualSettlementItem[], right: ManualSettlementItem[]) {
    const normalize = (items: ManualSettlementItem[]) =>
      [...items]
        .map((item) => ({
          goodsId: item.goodsId,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        }))
        .sort((a, b) => a.goodsId.localeCompare(b.goodsId));
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  private normalizeCallbackItems(
    deviceCode: string,
    rawItems: NonNullable<SmartVmSettlementPayload["detail"]>
  ): ManualSettlementItem[] {
    if (!rawItems.length) {
      throw new BadRequestException("迟到结算回调缺少商品明细。");
    }

    return rawItems.map((item) => {
      const catalogItem = this.store.goodsCatalog.find(
        (entry) => entry.goodsId === item.goodsId && entry.status === "active"
      );
      const listedOnDevice = this.store.devices
        .find((entry) => entry.deviceCode === deviceCode)
        ?.doors.some((door) => door.goods.some((goods) => goods.goodsId === item.goodsId));
      if (!catalogItem || !listedOnDevice) {
        throw new BadRequestException(
          `平台回调商品 ${item.goodsId} 尚未在该柜机完成货品建档。`
        );
      }
      return {
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: catalogItem.category,
        quantity: item.quantity,
        unitPrice: item.unitPrice
      };
    });
  }

  private assertUniquePlatformOrderNo(orderNo: string, eventId: string) {
    const currentEvent = this.store.events.find((entry) => entry.eventId === eventId);
    const currentUser = this.store.users.find((entry) => entry.id === currentEvent?.userId);
    const currentTenantId = currentUser
      ? this.store.getUserTenantId(currentUser)
      : undefined;
    const conflict = this.store.events.find((entry) => {
      if (
        entry.eventId === eventId ||
        (entry.orderNo !== orderNo && entry.manualSettlement?.platformOrderNo !== orderNo)
      ) {
        return false;
      }
      const user = this.store.users.find((candidate) => candidate.id === entry.userId);
      const device = this.store.devices.find(
        (candidate) => candidate.deviceCode === entry.deviceCode
      );
      return Boolean(
        currentTenantId &&
          user &&
          device &&
          this.store.getUserTenantId(user) === currentTenantId &&
          this.store.getDeviceTenantId(device) === currentTenantId
      );
    });
    if (conflict) {
      throw new ConflictException("平台订单号已关联当前实例中的其他开柜事件。");
    }
  }
}
