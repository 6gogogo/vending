import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  ExpiredBatchDispositionMethod,
  ExpiredBatchDispositionRecord,
  GoodsBatchRecord,
  GoodsCatalogItem,
  StocktakeRecord,
  WarehouseInventorySnapshot,
  WarehouseInventoryItem,
  WarehouseRecord
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { toSafeFilenameSegment, toSafeSpreadsheetCell } from "../../common/export/html-workbook";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { findActiveWarehouse } from "../../common/store/default-warehouse";

@Injectable()
export class WarehousesService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService) private readonly inventoryBatchChanges: InventoryBatchChangesService
  ) {}

  list() {
    return this.store.warehouses.slice();
  }

  getInventory() {
    const warehouse = this.getDefaultWarehouse();
    const items = this.buildWarehouseItems(warehouse.code);
    const now = Date.now();
    const physicalBatches = this.listActiveGoodsBatches();
    const transferableBatches = physicalBatches.filter((entry) =>
      this.store.isGoodsBatchAvailable(entry, now)
    );
    const expiredBatches = physicalBatches.filter(
      (entry) => !this.store.isGoodsBatchAvailable(entry, now)
    );
    const warehousePhysicalBatches = physicalBatches.filter(
      (entry) => entry.deviceCode === warehouse.code
    );
    const warehouseTransferableBatches = transferableBatches.filter(
      (entry) => entry.deviceCode === warehouse.code
    );
    const warehouseExpiredBatches = expiredBatches.filter(
      (entry) => entry.deviceCode === warehouse.code
    );
    const physicalTotalStock = this.sumBatchStock(warehousePhysicalBatches);

    return {
      warehouse,
      totalStock: physicalTotalStock,
      physicalTotalStock,
      transferableTotalStock: this.sumBatchStock(warehouseTransferableBatches),
      expiredTotalStock: this.sumBatchStock(warehouseExpiredBatches),
      goodsKinds: items.length,
      items,
      physicalBatches,
      transferableBatches,
      expiredBatches,
      availableBatches: physicalBatches,
      recentExpiredDispositions: this.store.expiredBatchDispositions.slice(0, 20),
      transfers: this.store.inventoryTransfers.slice(0, 20),
      stocktakes: this.store.stocktakes.slice(0, 20),
      recentLogs: this.store.logs
        .filter(
          (entry) =>
            entry.primarySubject?.id === warehouse.code ||
            entry.secondarySubject?.id === warehouse.code ||
            entry.metadata?.warehouseCode === warehouse.code ||
            entry.metadata?.fromCode === warehouse.code ||
            entry.metadata?.toCode === warehouse.code
        )
        .slice(0, 20)
    } satisfies WarehouseInventorySnapshot;
  }

  transfer(
    payload: {
      fromCode: string;
      toCode: string;
      goodsId: string;
      quantity: number;
      sourceBatchId?: string;
      note?: string;
    },
    actorUserId?: string
  ) {
    const fromCode = String(payload.fromCode ?? "").trim();
    const toCode = String(payload.toCode ?? "").trim();
    const goodsId = String(payload.goodsId ?? "").trim();
    const quantity = Number(payload.quantity);
    const sourceBatchId = payload.sourceBatchId?.trim() || undefined;

    if (!fromCode || !toCode || !goodsId) {
      throw new BadRequestException("调拨来源、去向和货品编号不能为空。");
    }

    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException("调拨数量必须是正整数。");
    }

    const from = this.resolveLocation(fromCode);
    const to = this.resolveLocation(toCode);

    if (from.code === to.code) {
      throw new BadRequestException("调拨来源和去向不能相同。");
    }

    const goods = this.findGoods(goodsId);
    const now = Date.now();
    const currentStock = this.store.getAvailableStock(from.code, goods.goodsId, now);
    const positiveSourceBatches = this.listActiveGoodsBatches(from.code, goods.goodsId);
    const requestedSourceBatch = sourceBatchId
      ? positiveSourceBatches.find((entry) => entry.batchId === sourceBatchId)
      : undefined;
    const activeSourceBatches = this.listTransferableGoodsBatches(from.code, goods.goodsId, now);

    if (
      requestedSourceBatch?.expiresAt &&
      !this.store.isGoodsBatchAvailable(requestedSourceBatch, now)
    ) {
      throw new BadRequestException("所选来源批次已到期，不能执行正常调拨。");
    }

    if (currentStock < quantity) {
      throw new BadRequestException("调拨数量超过可调拨的有效批次库存。");
    }

    if (!activeSourceBatches.length) {
      throw new BadRequestException("当前货品没有可调拨的有效批次。");
    }

    const selectedBatch = sourceBatchId
      ? activeSourceBatches.find((entry) => entry.batchId === sourceBatchId)
      : activeSourceBatches.length === 1
        ? activeSourceBatches[0]
        : undefined;

    if (sourceBatchId && !selectedBatch) {
      throw new BadRequestException("未找到对应来源批次，或该批次已无可调拨库存。");
    }

    if (!selectedBatch && activeSourceBatches.length > 1) {
      throw new BadRequestException("当前货品存在多个保质期批次，请按批次选择后再调拨。");
    }

    const beforeMutation = {
      devices: structuredClone(this.store.devices),
      goodsBatches: structuredClone(this.store.goodsBatches),
      inventoryTransfers: structuredClone(this.store.inventoryTransfers),
      logs: structuredClone(this.store.logs)
    };

    try {
      const change = this.inventoryBatchChanges.recordTransfer({
        id: this.store.createId("transfer"),
        from,
        to,
        goods,
        quantity,
        happenedAt: new Date().toISOString(),
        sourceBatchId: selectedBatch?.batchId,
        actorUserId,
        actorUserName: this.getActorName(actorUserId),
        note: payload.note
      });
      const record = change.transfers[0];

      if (!record) {
        throw new BadRequestException("调拨未产生库存变化。");
      }

      this.store.logOperation({
        category: "inventory",
        type: "inventory-transfer",
        status: "success",
        actor: this.getActor(actorUserId),
        primarySubject: {
          type: from.type === "warehouse" ? "warehouse" : "device",
          id: from.code,
          label: from.name
        },
        secondarySubject: {
          type: to.type === "warehouse" ? "warehouse" : "device",
          id: to.code,
          label: to.name
        },
        metadata: {
          fromCode: from.code,
          toCode: to.code,
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: record.quantity,
          sourceBatchId: selectedBatch?.batchId,
          sourceBatchExpiresAt: selectedBatch?.expiresAt,
          note: payload.note ?? "",
          undoState: "not_undoable"
        }
      });

      return record;
    } catch (error) {
      this.store.devices.splice(0, this.store.devices.length, ...beforeMutation.devices);
      this.store.goodsBatches.splice(0, this.store.goodsBatches.length, ...beforeMutation.goodsBatches);
      this.store.inventoryTransfers.splice(
        0,
        this.store.inventoryTransfers.length,
        ...beforeMutation.inventoryTransfers
      );
      this.store.logs.splice(0, this.store.logs.length, ...beforeMutation.logs);
      throw error;
    }
  }

  disposeExpiredBatch(
    batchId: string,
    payload: {
      confirmed: boolean;
      quantity: number;
      method: ExpiredBatchDispositionMethod;
      reason: string;
      idempotencyKey?: string;
    },
    actorUserId?: string
  ) {
    const normalizedBatchId = String(batchId ?? "").trim();
    const quantity = Number(payload.quantity);
    const reason = String(payload.reason ?? "").trim();
    const idempotencyKey = String(payload.idempotencyKey ?? "").trim() || undefined;
    const supportedMethods: ExpiredBatchDispositionMethod[] = ["destroy", "return_supplier", "other"];

    if (payload.confirmed !== true) {
      throw new BadRequestException("处置过期物资前必须完成最终确认。");
    }

    if (!normalizedBatchId) {
      throw new BadRequestException("过期批次编号不能为空。");
    }

    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException("处置数量必须是正整数。");
    }

    if (!supportedMethods.includes(payload.method)) {
      throw new BadRequestException("请选择有效的处置方式。");
    }

    if (!reason) {
      throw new BadRequestException("请填写处置理由。");
    }

    if (reason.length > 300) {
      throw new BadRequestException("处置理由不能超过 300 个字符。");
    }

    if (idempotencyKey && idempotencyKey.length > 128) {
      throw new BadRequestException("幂等键长度不能超过 128 个字符。");
    }

    const existingDisposition = idempotencyKey
      ? this.store.expiredBatchDispositions.find(
          (entry) => entry.idempotencyKey === idempotencyKey
        )
      : undefined;

    if (existingDisposition) {
      if (
        existingDisposition.batchId !== normalizedBatchId ||
        existingDisposition.quantity !== quantity ||
        existingDisposition.method !== payload.method ||
        existingDisposition.reason !== reason
      ) {
        throw new BadRequestException("该幂等键已用于其他过期物资处置请求。");
      }

      return existingDisposition;
    }

    const batch = this.store.goodsBatches.find((entry) => entry.batchId === normalizedBatchId);

    if (!batch) {
      throw new NotFoundException("未找到对应过期批次。");
    }

    const expiresAt = batch.expiresAt ? Date.parse(batch.expiresAt) : Number.NaN;

    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
      throw new BadRequestException("该批次尚未过期，不能进入过期处置流程。");
    }

    if (batch.remainingQuantity <= 0) {
      throw new BadRequestException("该批次已无待处置库存。");
    }

    if (quantity > batch.remainingQuantity) {
      throw new BadRequestException("处置数量不能超过该批次待处置数量。");
    }

    const goods = this.findGoods(batch.goodsId);
    const locationType = this.store.isWarehouseCode(batch.deviceCode) ? "warehouse" : "device";
    const locationName = this.store.getLocationName(batch.deviceCode);
    const beforeMutation = {
      devices: structuredClone(this.store.devices),
      goodsBatches: structuredClone(this.store.goodsBatches),
      inventory: structuredClone(this.store.inventory),
      batchConsumptionTraces: structuredClone(this.store.batchConsumptionTraces),
      expiredBatchDispositions: structuredClone(this.store.expiredBatchDispositions),
      logs: structuredClone(this.store.logs)
    };

    try {
      const disposedAt = new Date().toISOString();
      const movementId = this.store.createId("movement");
      const change = this.inventoryBatchChanges.recordSpecificBatchDeduction({
        batchId: batch.batchId,
        quantity,
        movement: {
          id: movementId,
          userId:
            actorUserId ??
            this.store.users.find((entry) => entry.role === "admin")?.id ??
            "system",
          deviceCode: batch.deviceCode,
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          quantity,
          unitPrice: goods.price,
          type: "expired",
          happenedAt: disposedAt
        },
        trace: {
          enabled: false
        }
      });
      const movement = change.movements[0];

      if (!movement || movement.quantity !== quantity) {
        throw new BadRequestException("处置数量与批次实际库存不一致，请刷新后重试。");
      }

      const record: ExpiredBatchDispositionRecord = {
        id: this.store.createId("expired-disposition"),
        movementId,
        idempotencyKey,
        batchId: batch.batchId,
        goodsId: goods.goodsId,
        goodsName: goods.name,
        locationType,
        locationCode: batch.deviceCode,
        locationName,
        expiresAt: batch.expiresAt!,
        quantity,
        remainingQuantity: batch.remainingQuantity,
        method: payload.method,
        reason,
        disposedAt,
        actorUserId,
        actorUserName: this.getActorName(actorUserId)
      };

      this.store.expiredBatchDispositions.unshift(record);
      this.store.logOperation({
        category: "inventory",
        type: "dispose-expired-batch",
        status: "success",
        actor: this.getActor(actorUserId),
        primarySubject: {
          type: locationType,
          id: batch.deviceCode,
          label: locationName
        },
        secondarySubject: {
          type: "goods",
          id: goods.goodsId,
          label: goods.name
        },
        metadata: {
          dispositionId: record.id,
          movementId,
          batchId: batch.batchId,
          expiresAt: batch.expiresAt,
          quantity,
          remainingQuantity: batch.remainingQuantity,
          method: payload.method,
          reason,
          undoState: "not_undoable"
        }
      });

      return record;
    } catch (error) {
      this.store.devices.splice(0, this.store.devices.length, ...beforeMutation.devices);
      this.store.goodsBatches.splice(0, this.store.goodsBatches.length, ...beforeMutation.goodsBatches);
      this.store.inventory.splice(0, this.store.inventory.length, ...beforeMutation.inventory);
      this.store.batchConsumptionTraces.splice(
        0,
        this.store.batchConsumptionTraces.length,
        ...beforeMutation.batchConsumptionTraces
      );
      this.store.expiredBatchDispositions.splice(
        0,
        this.store.expiredBatchDispositions.length,
        ...beforeMutation.expiredBatchDispositions
      );
      this.store.logs.splice(0, this.store.logs.length, ...beforeMutation.logs);
      throw error;
    }
  }

  stocktake(
    payload: {
      deviceCode: string;
      note?: string;
      items: Array<{
        goodsId: string;
        actualQuantity: number;
      }>;
    },
    actorUserId?: string
  ) {
    if (!payload.items.length) {
      throw new BadRequestException("盘点明细不能为空，不能用空盘点覆盖现有库存。");
    }

    const normalizedItems = payload.items.map((item) => ({
      goodsId: item.goodsId.trim(),
      actualQuantity: Number(item.actualQuantity)
    }));
    const suppliedGoodsIds = new Set<string>();

    for (const item of normalizedItems) {
      const actualQuantity = item.actualQuantity;

      if (!item.goodsId) {
        throw new BadRequestException("盘点货品编号不能为空。");
      }

      if (!Number.isFinite(actualQuantity) || actualQuantity < 0) {
        throw new BadRequestException("实盘数量不能为负数。");
      }

      if (!Number.isInteger(actualQuantity)) {
        throw new BadRequestException("实盘数量必须是整数。");
      }

      if (suppliedGoodsIds.has(item.goodsId)) {
        throw new BadRequestException(`盘点明细存在重复货品：${item.goodsId}`);
      }

      suppliedGoodsIds.add(item.goodsId);
    }

    const device = this.store.devices.find((entry) => entry.deviceCode === payload.deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const expectedGoodsIds = Array.from(
      new Set([
        ...device.doors.flatMap((door) => door.goods.map((goods) => goods.goodsId)),
        ...this.store
          .getGoodsBatches(device.deviceCode)
          .filter((entry) => entry.remainingQuantity !== 0)
          .map((entry) => entry.goodsId)
      ])
    );
    const missingGoodsIds = expectedGoodsIds.filter((goodsId) => !suppliedGoodsIds.has(goodsId));

    if (missingGoodsIds.length) {
      throw new BadRequestException(`盘点明细不完整，缺少货品：${missingGoodsIds.join("、")}`);
    }

    const goodsIds = Array.from(new Set([...expectedGoodsIds, ...suppliedGoodsIds]));
    const actualMap = new Map(normalizedItems.map((entry) => [entry.goodsId, entry.actualQuantity]));
    const plannedItems = goodsIds.map((goodsId) => {
      const goods = this.findGoods(goodsId);
      const systemQuantity = this.store.getCurrentStock(device.deviceCode, goodsId);
      const actualQuantity = actualMap.get(goodsId);

      if (actualQuantity === undefined) {
        throw new BadRequestException(`盘点明细不完整，缺少货品：${goodsId}`);
      }

      return {
        goods,
        goodsId,
        systemQuantity,
        actualQuantity,
        delta: actualQuantity - systemQuantity,
        nearestExpiryAt: this.store.getNearestExpiryAt(device.deviceCode, goodsId),
        batchCount: this.store
          .getGoodsBatches(device.deviceCode, goodsId)
          .filter((entry) => entry.remainingQuantity > 0).length
      };
    });
    const beforeMutation = {
      devices: structuredClone(this.store.devices),
      goodsBatches: structuredClone(this.store.goodsBatches),
      stocktakes: structuredClone(this.store.stocktakes),
      logs: structuredClone(this.store.logs)
    };

    try {
      const items = plannedItems.map((item) => {
        this.inventoryBatchChanges.applyStocktakeCorrection({
          deviceCode: device.deviceCode,
          goods: item.goods,
          delta: item.delta,
          sourceUserId: actorUserId,
          sourceUserName: this.getActorName(actorUserId),
          note: payload.note
        });

        return {
          goodsId: item.goodsId,
          goodsName: item.goods.name,
          category: item.goods.category,
          systemQuantity: item.systemQuantity,
          actualQuantity: item.actualQuantity,
          delta: item.delta,
          nearestExpiryAt: item.nearestExpiryAt,
          batchCount: item.batchCount
        };
      });

      const record: StocktakeRecord = {
        id: this.store.createId("stocktake"),
        deviceCode: device.deviceCode,
        deviceName: device.name,
        createdAt: new Date().toISOString(),
        actorUserId,
        actorUserName: this.getActorName(actorUserId),
        note: payload.note,
        items
      };

      this.store.stocktakes.unshift(record);
      this.store.logOperation({
        category: "inventory",
        type: "stocktake-device",
        status: "success",
        actor: this.getActor(actorUserId),
        primarySubject: {
          type: "device",
          id: device.deviceCode,
          label: device.name
        },
        secondarySubject: {
          type: "stocktake",
          id: record.id,
          label: `盘点 ${record.id}`
        },
        metadata: {
          deviceCode: device.deviceCode,
          itemCount: items.length,
          note: payload.note ?? "",
          undoState: "not_undoable"
        }
      });

      return record;
    } catch (error) {
      this.store.devices.splice(0, this.store.devices.length, ...beforeMutation.devices);
      this.store.goodsBatches.splice(0, this.store.goodsBatches.length, ...beforeMutation.goodsBatches);
      this.store.stocktakes.splice(0, this.store.stocktakes.length, ...beforeMutation.stocktakes);
      this.store.logs.splice(0, this.store.logs.length, ...beforeMutation.logs);
      throw error;
    }
  }

  buildStocktakeExport(stocktakeId: string) {
    const record = this.store.stocktakes.find((entry) => entry.id === stocktakeId);

    if (!record) {
      throw new NotFoundException("未找到对应盘点记录。");
    }

    const rows = record.items
      .map(
        (item) => `
          <tr>
            <td>${toSafeSpreadsheetCell(record.deviceCode)}</td>
            <td>${toSafeSpreadsheetCell(record.deviceName)}</td>
            <td>${toSafeSpreadsheetCell(item.goodsId)}</td>
            <td>${toSafeSpreadsheetCell(item.goodsName)}</td>
            <td>${toSafeSpreadsheetCell(item.systemQuantity)}</td>
            <td>${toSafeSpreadsheetCell(item.actualQuantity)}</td>
            <td>${toSafeSpreadsheetCell(item.delta)}</td>
            <td>${toSafeSpreadsheetCell(item.nearestExpiryAt?.slice(0, 10))}</td>
            <td>${toSafeSpreadsheetCell(record.createdAt)}</td>
            <td>${toSafeSpreadsheetCell(record.actorUserName ?? "管理员")}</td>
          </tr>`
      )
      .join("");

    return {
      filename: `stocktake-${toSafeFilenameSegment(record.deviceCode, "device")}-${toSafeFilenameSegment(record.id, "record")}.xls`,
      contentType: "application/vnd.ms-excel; charset=utf-8",
      body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<table border="1">
  <tr>
    <th>柜机编号</th>
    <th>柜机名称</th>
    <th>货品编号</th>
    <th>货品名称</th>
    <th>系统数量</th>
    <th>实盘数量</th>
    <th>差异</th>
    <th>最短保质期</th>
    <th>盘点时间</th>
    <th>盘点人</th>
  </tr>
  ${rows}
</table>
</body>
</html>`
    };
  }

  private buildWarehouseItems(warehouseCode: string): WarehouseInventoryItem[] {
    const goodsIds = Array.from(
      new Set(
        this.store
          .getGoodsBatches(warehouseCode)
          .filter((entry) => entry.remainingQuantity > 0)
          .map((entry) => entry.goodsId)
      )
    );

    return goodsIds
      .map((goodsId) => {
        const goods = this.findGoods(goodsId);
        const batches = this.listActiveGoodsBatches(warehouseCode, goodsId);

        return {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          totalStock: batches.reduce((sum, entry) => sum + entry.remainingQuantity, 0),
          nearestExpiryAt: batches.find((entry) => entry.expiresAt)?.expiresAt,
          batchCount: batches.length,
          batches
        };
      })
      .sort((left, right) => left.goodsId.localeCompare(right.goodsId));
  }

  private listActiveGoodsBatches(deviceCode?: string, goodsId?: string) {
    return this.store
      .getGoodsBatches(deviceCode, goodsId)
      .filter((entry) => entry.remainingQuantity > 0)
      .map((entry) => this.decorateGoodsBatch(entry))
      .sort((left, right) => this.compareGoodsBatchByExpiry(left, right));
  }

  private listTransferableGoodsBatches(deviceCode?: string, goodsId?: string, now = Date.now()) {
    return this.listActiveGoodsBatches(deviceCode, goodsId).filter((entry) =>
      this.store.isGoodsBatchAvailable(entry, now)
    );
  }

  private sumBatchStock(batches: GoodsBatchRecord[]) {
    return batches.reduce((sum, entry) => sum + entry.remainingQuantity, 0);
  }

  private decorateGoodsBatch(entry: GoodsBatchRecord): GoodsBatchRecord {
    return {
      ...entry,
      locationType: entry.locationType ?? (this.store.isWarehouseCode(entry.deviceCode) ? "warehouse" : "device"),
      locationName: entry.locationName ?? this.store.getLocationName(entry.deviceCode)
    };
  }

  private compareGoodsBatchByExpiry(left: GoodsBatchRecord, right: GoodsBatchRecord) {
    const leftExpiry = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
    const normalizedLeft = Number.isFinite(leftExpiry) ? leftExpiry : Number.POSITIVE_INFINITY;
    const normalizedRight = Number.isFinite(rightExpiry) ? rightExpiry : Number.POSITIVE_INFINITY;
    const expiryOrder = normalizedLeft - normalizedRight;

    if (expiryOrder !== 0 && !Number.isNaN(expiryOrder)) {
      return expiryOrder;
    }

    if (left.goodsId !== right.goodsId) {
      return left.goodsId.localeCompare(right.goodsId);
    }

    if (left.deviceCode !== right.deviceCode) {
      return left.deviceCode.localeCompare(right.deviceCode);
    }

    return left.createdAt.localeCompare(right.createdAt);
  }

  private resolveLocation(code: string) {
    const warehouse = this.store.getWarehouse(code);

    if (warehouse) {
      if (warehouse.status !== "active") {
        throw new BadRequestException("仓库当前已停用，不能参与库存调拨。");
      }

      return {
        type: "warehouse" as const,
        code: warehouse.code,
        name: warehouse.name
      };
    }

    const device = this.store.devices.find((entry) => entry.deviceCode === code);

    if (!device) {
      throw new NotFoundException("未找到对应位置。");
    }

    return {
      type: "device" as const,
      code: device.deviceCode,
      name: device.name
    };
  }

  private getDefaultWarehouse(): WarehouseRecord {
    const warehouse = findActiveWarehouse(this.store.warehouses);

    if (!warehouse) {
      throw new NotFoundException("未配置启用的本地仓库。");
    }

    return warehouse;
  }

  private findGoods(goodsId: string): GoodsCatalogItem {
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);

    if (!goods) {
      throw new NotFoundException("未找到对应货品。");
    }

    return goods;
  }

  private getActor(actorUserId?: string) {
    const actor =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (actor) {
      return {
        type: "admin" as const,
        id: actor.id,
        name: actor.name,
        role: actor.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }

  private getActorName(actorUserId?: string) {
    return (
      this.store.users.find((entry) => entry.id === actorUserId)?.name ??
      this.store.users.find((entry) => entry.role === "admin")?.name ??
      "管理员"
    );
  }
}
