import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  GoodsBatchRecord,
  GoodsCatalogItem,
  StocktakeRecord,
  WarehouseInventorySnapshot,
  WarehouseInventoryItem,
  WarehouseRecord
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

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
    const availableBatches = this.listActiveGoodsBatches();

    return {
      warehouse,
      totalStock: items.reduce((sum, item) => sum + item.totalStock, 0),
      goodsKinds: items.length,
      items,
      availableBatches,
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
    const from = this.resolveLocation(payload.fromCode);
    const to = this.resolveLocation(payload.toCode);

    if (from.code === to.code) {
      throw new BadRequestException("调拨来源和去向不能相同。");
    }

    if (payload.quantity <= 0) {
      throw new BadRequestException("调拨数量必须大于 0。");
    }

    const goods = this.findGoods(payload.goodsId);
    const currentStock = this.store.getCurrentStock(from.code, goods.goodsId);
    const activeSourceBatches = this.listActiveGoodsBatches(from.code, goods.goodsId);

    if (currentStock < payload.quantity) {
      throw new BadRequestException("调拨数量超过当前库存。");
    }

    if (!activeSourceBatches.length) {
      throw new BadRequestException("当前货品没有可调拨的有效批次。");
    }

    const selectedBatch = payload.sourceBatchId
      ? activeSourceBatches.find((entry) => entry.batchId === payload.sourceBatchId)
      : activeSourceBatches.length === 1
        ? activeSourceBatches[0]
        : undefined;

    if (payload.sourceBatchId && !selectedBatch) {
      throw new BadRequestException("未找到对应来源批次，或该批次已无库存。");
    }

    if (!selectedBatch && activeSourceBatches.length > 1) {
      throw new BadRequestException("当前货品存在多个保质期批次，请按批次选择后再调拨。");
    }

    const change = this.inventoryBatchChanges.recordTransfer({
      id: this.store.createId("transfer"),
      from,
      to,
      goods,
      quantity: payload.quantity,
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
    for (const item of payload.items) {
      const actualQuantity = Number(item.actualQuantity);

      if (!Number.isFinite(actualQuantity) || actualQuantity < 0) {
        throw new BadRequestException("实盘数量不能为负数。");
      }
    }

    const device = this.store.devices.find((entry) => entry.deviceCode === payload.deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const goodsIds = Array.from(
      new Set([
        ...device.doors.flatMap((door) => door.goods.map((goods) => goods.goodsId)),
        ...this.store.getGoodsBatches(device.deviceCode).map((entry) => entry.goodsId),
        ...payload.items.map((entry) => entry.goodsId)
      ])
    );

    const actualMap = new Map(payload.items.map((entry) => [entry.goodsId, entry.actualQuantity]));
    const items = goodsIds.map((goodsId) => {
      const goods = this.findGoods(goodsId);
      const systemQuantity = this.store.getCurrentStock(device.deviceCode, goodsId);
      const actualQuantity = actualMap.get(goodsId) ?? 0;
      const delta = actualQuantity - systemQuantity;
      const nearestExpiryAt = this.store.getNearestExpiryAt(device.deviceCode, goodsId);
      const batchCount = this.store
        .getGoodsBatches(device.deviceCode, goodsId)
        .filter((entry) => entry.remainingQuantity > 0).length;

      this.inventoryBatchChanges.applyStocktakeCorrection({
        deviceCode: device.deviceCode,
        goods,
        delta,
        sourceUserId: actorUserId,
        sourceUserName: this.getActorName(actorUserId),
        note: payload.note
      });

      return {
        goodsId,
        goodsName: goods.name,
        category: goods.category,
        systemQuantity,
        actualQuantity,
        delta,
        nearestExpiryAt,
        batchCount
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
            <td>${record.deviceCode}</td>
            <td>${record.deviceName}</td>
            <td>${item.goodsId}</td>
            <td>${item.goodsName}</td>
            <td>${item.systemQuantity}</td>
            <td>${item.actualQuantity}</td>
            <td>${item.delta}</td>
            <td>${item.nearestExpiryAt?.slice(0, 10) ?? ""}</td>
            <td>${record.createdAt}</td>
            <td>${record.actorUserName ?? "管理员"}</td>
          </tr>`
      )
      .join("");

    return {
      filename: `stocktake-${record.deviceCode}-${record.id}.xls`,
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

  private decorateGoodsBatch(entry: GoodsBatchRecord): GoodsBatchRecord {
    return {
      ...entry,
      locationType: entry.locationType ?? (this.store.isWarehouseCode(entry.deviceCode) ? "warehouse" : "device"),
      locationName: entry.locationName ?? this.store.getLocationName(entry.deviceCode)
    };
  }

  private compareGoodsBatchByExpiry(left: GoodsBatchRecord, right: GoodsBatchRecord) {
    const leftExpiry = left.expiresAt ?? "9999-12-31T23:59:59.999Z";
    const rightExpiry = right.expiresAt ?? "9999-12-31T23:59:59.999Z";

    if (leftExpiry !== rightExpiry) {
      return leftExpiry.localeCompare(rightExpiry);
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
    const warehouse = this.store.warehouses[0];

    if (!warehouse) {
      throw new NotFoundException("未配置本地仓库。");
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
