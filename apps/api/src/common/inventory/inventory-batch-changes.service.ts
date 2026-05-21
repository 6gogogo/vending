import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  BatchConsumptionLine,
  BatchConsumptionTrace,
  DeviceGoods,
  GoodsBatchRecord,
  GoodsBatchSource,
  InventoryLocationType,
  InventoryMovement,
  InventoryTransferRecord
} from "@vm/shared-types";

import { InMemoryStoreService } from "../store/in-memory-store.service";

type InventoryBatchGoods = Pick<DeviceGoods, "goodsCode" | "goodsId" | "name" | "category" | "price" | "imageUrl">;

interface ConsumptionTraceOptions {
  enabled?: boolean;
  sourceLogId?: string;
  orderNo?: string;
  eventId?: string;
  note?: string;
  consumerUserName?: string;
}

interface RecordConsumptiveMovementPayload {
  movement: InventoryMovement;
  requestedBatches?: Array<{
    batchId: string;
    quantity: number;
  }>;
  trace?: ConsumptionTraceOptions;
}

interface RecordRestockMovementPayload {
  movement: InventoryMovement;
  deviceGoods?: InventoryBatchGoods;
  batch: {
    sourceType: GoodsBatchSource;
    sourceUserId?: string;
    sourceUserName?: string;
    sourcePolicyId?: string;
    note?: string;
    expiresAt?: string;
    createdAt?: string;
    batchId?: string;
  };
}

interface RecordSpecificBatchDeductionPayload {
  batchId: string;
  quantity: number;
  movement: InventoryMovement;
  trace?: ConsumptionTraceOptions;
}

interface RecordBatchOnlyPayload {
  goodsId: string;
  deviceCode: string;
  quantity: number;
  expiresAt?: string;
  sourceType: GoodsBatchSource;
  sourceUserId?: string;
  sourceUserName?: string;
  sourcePolicyId?: string;
  note?: string;
  createdAt?: string;
  batchId?: string;
}

interface ConsumeBatchesOnlyPayload {
  deviceCode: string;
  goodsId: string;
  quantity: number;
}

interface InventoryBatchChangeLocation {
  type: InventoryLocationType;
  code: string;
  name: string;
}

interface RecordTransferPayload {
  id: string;
  from: InventoryBatchChangeLocation;
  to: InventoryBatchChangeLocation;
  goods: InventoryBatchGoods;
  quantity: number;
  sourceBatchId?: string;
  happenedAt: string;
  actorUserId?: string;
  actorUserName?: string;
  note?: string;
}

interface ApplyStocktakeCorrectionPayload {
  deviceCode: string;
  goods: InventoryBatchGoods;
  delta: number;
  sourceUserId?: string;
  sourceUserName?: string;
  note?: string;
}

interface UndoRestockBatchChangePayload {
  batchId: string;
  quantity: number;
  movement: InventoryMovement;
}

interface UndoConsumptiveBatchChangePayload {
  deviceCode: string;
  consumedBatches: BatchConsumptionLine[];
  movement: InventoryMovement;
}

interface RestoreRemovedBatchPayload {
  batchId: string;
  quantity: number;
  movement: InventoryMovement;
}

export interface InventoryBatchChangeResult {
  movements: InventoryMovement[];
  transfers: InventoryTransferRecord[];
  createdBatches: GoodsBatchRecord[];
  consumedBatches: BatchConsumptionLine[];
  consumptionTraces: BatchConsumptionTrace[];
  negativeBalance?: {
    goodsId: string;
    deviceCode: string;
    quantity: number;
  };
}

@Injectable()
export class InventoryBatchChangesService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  recordConsumptiveMovement(payload: RecordConsumptiveMovementPayload): InventoryBatchChangeResult {
    const { movement } = payload;
    const consumed = this.store.consumeGoodsBatches(
      movement.deviceCode,
      movement.goodsId,
      movement.quantity,
      payload.requestedBatches
    );
    const consumedBatches = this.cloneConsumedBatches(consumed.consumed);

    movement.consumedBatches = consumedBatches;
    movement.batchId = consumedBatches.length === 1 ? consumedBatches[0]?.batchId : undefined;
    this.recordMovement(movement);

    const consumptionTraces = this.recordConsumptionTracesForChange(movement, consumedBatches, payload.trace);

    return this.change({
      movements: [movement],
      consumedBatches,
      consumptionTraces,
      negativeBalance: this.summarizeNegativeBalance(movement.deviceCode, movement.goodsId, consumedBatches)
    });
  }

  recordRestockMovement(payload: RecordRestockMovementPayload): InventoryBatchChangeResult {
    const { movement } = payload;

    if (payload.deviceGoods) {
      this.store.ensureDeviceGoodsEntry(movement.deviceCode, this.pickDeviceGoods(payload.deviceGoods));
    }

    const batch = this.store.createGoodsBatch({
      goodsId: movement.goodsId,
      deviceCode: movement.deviceCode,
      quantity: movement.quantity,
      expiresAt: payload.batch.expiresAt ?? movement.expiresAt,
      sourceType: payload.batch.sourceType,
      sourceUserId: payload.batch.sourceUserId,
      sourceUserName: payload.batch.sourceUserName,
      sourcePolicyId: payload.batch.sourcePolicyId,
      note: payload.batch.note,
      createdAt: payload.batch.createdAt,
      batchId: payload.batch.batchId
    });

    movement.batchId = batch.batchId;
    movement.expiresAt = batch.expiresAt;
    this.recordMovement(movement);

    return this.change({
      movements: [movement],
      createdBatches: [batch]
    });
  }

  recordSpecificBatchDeduction(payload: RecordSpecificBatchDeductionPayload): InventoryBatchChangeResult {
    const removed = this.store.removeBatchQuantity(payload.batchId, payload.quantity);

    if (!removed) {
      throw new NotFoundException("未找到对应批次。");
    }

    const consumedBatches = this.buildSpecifiedConsumption(removed.batch, removed.actualQuantity);

    payload.movement.batchId = removed.batch.batchId;
    payload.movement.quantity = removed.actualQuantity;
    payload.movement.consumedBatches = consumedBatches;
    this.recordMovement(payload.movement);

    const consumptionTraces = this.recordConsumptionTracesForChange(payload.movement, consumedBatches, payload.trace);

    return this.change({
      movements: [payload.movement],
      consumedBatches,
      consumptionTraces
    });
  }

  recordBatchOnly(payload: RecordBatchOnlyPayload): InventoryBatchChangeResult {
    const batch = this.store.createGoodsBatch({
      goodsId: payload.goodsId,
      deviceCode: payload.deviceCode,
      quantity: payload.quantity,
      expiresAt: payload.expiresAt,
      sourceType: payload.sourceType,
      sourceUserId: payload.sourceUserId,
      sourceUserName: payload.sourceUserName,
      sourcePolicyId: payload.sourcePolicyId,
      note: payload.note,
      createdAt: payload.createdAt,
      batchId: payload.batchId
    });

    return this.change({
      createdBatches: [batch]
    });
  }

  consumeBatchesOnly(payload: ConsumeBatchesOnlyPayload): InventoryBatchChangeResult {
    const consumed = this.store.consumeGoodsBatches(payload.deviceCode, payload.goodsId, payload.quantity);
    const consumedBatches = this.cloneConsumedBatches(consumed.consumed);

    return this.change({
      consumedBatches,
      negativeBalance: this.summarizeNegativeBalance(payload.deviceCode, payload.goodsId, consumedBatches)
    });
  }

  recordTransfer(payload: RecordTransferPayload): InventoryBatchChangeResult {
    if (payload.to.type === "device") {
      this.store.ensureDeviceGoodsEntry(payload.to.code, this.pickDeviceGoods(payload.goods));
    }

    const sourceBatches = new Map(
      this.store.getGoodsBatches(payload.from.code, payload.goods.goodsId).map((entry) => [entry.batchId, entry])
    );
    const consumed = payload.sourceBatchId
      ? this.consumeSpecificBatch(payload.sourceBatchId, payload.quantity)
      : this.store.consumeGoodsBatches(payload.from.code, payload.goods.goodsId, payload.quantity);
    const consumedBatches = this.cloneConsumedBatches(consumed.consumed);
    const createdBatches = consumedBatches.map((entry) => {
      const sourceBatch = sourceBatches.get(entry.batchId);

      return this.store.createGoodsBatch({
        goodsId: payload.goods.goodsId,
        deviceCode: payload.to.code,
        quantity: entry.quantity,
        expiresAt: sourceBatch?.expiresAt,
        sourceType: "system",
        sourceUserId: payload.actorUserId,
        sourceUserName: payload.actorUserName,
        note: payload.note || `调拨自 ${payload.from.name}`
      });
    });
    const record: InventoryTransferRecord = {
      id: payload.id,
      fromType: payload.from.type,
      fromCode: payload.from.code,
      fromName: payload.from.name,
      toType: payload.to.type,
      toCode: payload.to.code,
      toName: payload.to.name,
      goodsId: payload.goods.goodsId,
      goodsName: payload.goods.name,
      quantity: consumed.actualQuantity,
      happenedAt: payload.happenedAt,
      actorUserId: payload.actorUserId,
      actorUserName: payload.actorUserName,
      note: payload.note,
      batches: consumedBatches.map((entry) => ({
        sourceBatchId: entry.batchId,
        quantity: entry.quantity,
        expiresAt: sourceBatches.get(entry.batchId)?.expiresAt
      }))
    };

    this.store.inventoryTransfers.unshift(record);

    return this.change({
      transfers: [record],
      createdBatches,
      consumedBatches
    });
  }

  applyStocktakeCorrection(payload: ApplyStocktakeCorrectionPayload): InventoryBatchChangeResult {
    if (payload.delta < 0) {
      const consumed = this.store.consumeGoodsBatches(
        payload.deviceCode,
        payload.goods.goodsId,
        Math.abs(payload.delta)
      );
      const consumedBatches = this.cloneConsumedBatches(consumed.consumed);

      return this.change({
        consumedBatches,
        negativeBalance: this.summarizeNegativeBalance(payload.deviceCode, payload.goods.goodsId, consumedBatches)
      });
    }

    if (payload.delta > 0) {
      this.store.ensureDeviceGoodsEntry(payload.deviceCode, this.pickDeviceGoods(payload.goods));
      const batch = this.store.createGoodsBatch({
        goodsId: payload.goods.goodsId,
        deviceCode: payload.deviceCode,
        quantity: payload.delta,
        sourceType: "system",
        sourceUserId: payload.sourceUserId,
        sourceUserName: payload.sourceUserName,
        note: payload.note || "盘点补录"
      });

      return this.change({
        createdBatches: [batch]
      });
    }

    return this.change();
  }

  undoRestockBatchChange(payload: UndoRestockBatchChangePayload): InventoryBatchChangeResult {
    const removed = this.store.removeBatchQuantity(payload.batchId, payload.quantity);

    if (!removed) {
      throw new NotFoundException("未找到可撤销的批次记录。");
    }

    payload.movement.quantity = removed.actualQuantity;
    payload.movement.batchId = payload.movement.batchId ?? payload.batchId;
    this.recordMovement(payload.movement);

    return this.change({
      movements: [payload.movement],
      consumedBatches: this.buildSpecifiedConsumption(removed.batch, removed.actualQuantity)
    });
  }

  undoConsumptiveBatchChange(payload: UndoConsumptiveBatchChangePayload): InventoryBatchChangeResult {
    this.store.restoreGoodsBatchConsumption(payload.deviceCode, payload.consumedBatches);
    const restoredQuantity = payload.consumedBatches.reduce((sum, entry) => sum + entry.quantity, 0);

    payload.movement.quantity = restoredQuantity;
    this.recordMovement(payload.movement);

    return this.change({
      movements: [payload.movement]
    });
  }

  restoreRemovedBatch(payload: RestoreRemovedBatchPayload): InventoryBatchChangeResult {
    const restored = this.store.restoreBatchQuantity(payload.batchId, payload.quantity);

    if (!restored) {
      throw new NotFoundException("未找到可恢复的批次。");
    }

    payload.movement.quantity = payload.quantity;
    payload.movement.batchId = payload.movement.batchId ?? payload.batchId;
    this.recordMovement(payload.movement);

    return this.change({
      movements: [payload.movement]
    });
  }

  markConsumptionTracesReverted(sourceLogId: string, undoLogId: string) {
    const now = new Date().toISOString();

    for (const trace of this.store.batchConsumptionTraces) {
      if (trace.sourceLogId !== sourceLogId || trace.revertedAt) {
        continue;
      }

      trace.revertedAt = now;
      trace.revertedByLogId = undoLogId;
    }
  }

  recordConsumptionTraces(payload: {
    movement: InventoryMovement;
    consumedBatches?: BatchConsumptionLine[];
  } & ConsumptionTraceOptions) {
    const consumedBatches = payload.consumedBatches ?? payload.movement.consumedBatches ?? [];
    const consumerUserName =
      payload.consumerUserName ??
      this.store.users.find((entry) => entry.id === payload.movement.userId)?.name;
    const traces: BatchConsumptionTrace[] = [];

    for (const item of consumedBatches) {
      const batch = this.store.goodsBatches.find((entry) => entry.batchId === item.batchId);
      const trace = this.store.recordBatchConsumption({
        id: this.store.createId("consumption-trace"),
        batchId: item.batchId,
        goodsId: payload.movement.goodsId,
        goodsName: payload.movement.goodsName,
        deviceCode: payload.movement.deviceCode,
        movementId: payload.movement.id,
        sourceLogId: payload.sourceLogId,
        operationType: payload.movement.type,
        sourceUserId: item.sourceUserId ?? batch?.sourceUserId,
        sourceUserName: item.sourceUserName ?? batch?.sourceUserName,
        consumerUserId: payload.movement.userId,
        consumerUserName,
        quantity: item.quantity,
        happenedAt: payload.movement.happenedAt,
        orderNo: payload.orderNo ?? payload.movement.orderNo,
        eventId: payload.eventId ?? payload.movement.eventId,
        note: payload.note
      });

      traces.push(trace);
    }

    return traces;
  }

  private summarizeNegativeBalance(
    deviceCode: string,
    goodsId: string,
    consumedBatches: BatchConsumptionLine[]
  ): InventoryBatchChangeResult["negativeBalance"] {
    const quantity = consumedBatches
      .filter((entry) => entry.selectionReason === "negative_balance")
      .reduce((sum, entry) => sum + entry.quantity, 0);

    if (quantity <= 0) {
      return undefined;
    }

    return {
      goodsId,
      deviceCode,
      quantity
    };
  }

  private consumeSpecificBatch(batchId: string, quantity: number) {
    const batch = this.store.getGoodsBatches().find((entry) => entry.batchId === batchId);

    if (!batch || batch.remainingQuantity <= 0) {
      throw new BadRequestException("未找到对应来源批次，或该批次已无库存。");
    }

    if (batch.remainingQuantity < quantity) {
      throw new BadRequestException("调拨数量超过所选批次当前库存。");
    }

    const removed = this.store.removeBatchQuantity(batchId, quantity);

    if (!removed || removed.actualQuantity !== quantity) {
      throw new BadRequestException("调拨数量超过所选批次当前库存。");
    }

    return {
      actualQuantity: removed.actualQuantity,
      consumed: this.buildSpecifiedConsumption(removed.batch, removed.actualQuantity),
      shortage: Math.max(0, quantity - removed.actualQuantity)
    };
  }

  private change(payload: Partial<InventoryBatchChangeResult> = {}): InventoryBatchChangeResult {
    const result: InventoryBatchChangeResult = {
      movements: payload.movements ?? [],
      transfers: payload.transfers ?? [],
      createdBatches: payload.createdBatches ?? [],
      consumedBatches: payload.consumedBatches ?? [],
      consumptionTraces: payload.consumptionTraces ?? []
    };

    if (payload.negativeBalance) {
      result.negativeBalance = payload.negativeBalance;
    }

    return result;
  }

  private recordMovement(movement: InventoryMovement) {
    this.store.inventory.unshift(movement);
    return movement;
  }

  private pickDeviceGoods(goods: InventoryBatchGoods): InventoryBatchGoods {
    return {
      goodsCode: goods.goodsCode,
      goodsId: goods.goodsId,
      name: goods.name,
      category: goods.category,
      price: goods.price,
      imageUrl: goods.imageUrl
    };
  }

  private cloneConsumedBatches(consumedBatches: BatchConsumptionLine[]) {
    return consumedBatches.map((entry) => ({ ...entry }));
  }

  private buildSpecifiedConsumption(batch: GoodsBatchRecord, quantity: number): BatchConsumptionLine[] {
    return [
      {
        batchId: batch.batchId,
        quantity,
        expiresAt: batch.expiresAt,
        sourceUserId: batch.sourceUserId,
        sourceUserName: batch.sourceUserName,
        selectionReason: "specified" as const
      }
    ].filter((entry) => entry.quantity > 0);
  }

  private recordConsumptionTracesForChange(
    movement: InventoryMovement,
    consumedBatches: BatchConsumptionLine[],
    trace?: ConsumptionTraceOptions
  ) {
    if (trace?.enabled === false) {
      return [];
    }

    return this.recordConsumptionTraces({
      movement,
      consumedBatches,
      ...trace
    });
  }
}
