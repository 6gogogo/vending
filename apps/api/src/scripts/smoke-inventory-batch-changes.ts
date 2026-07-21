import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceGoods, DeviceRecord, GoodsCatalogItem, InventoryMovement, UserRecord } from "@vm/shared-types";

import { InventoryBatchChangesService } from "../common/inventory/inventory-batch-changes.service.js";
import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";

const tempSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dataFile = join(tmpdir(), `vm-inventory-smoke-store-${tempSuffix}.json`);
const systemLogFile = join(tmpdir(), `vm-inventory-smoke-audit-${tempSuffix}.ndjson`);

process.env.API_DATA_FILE = dataFile;
process.env.SYSTEM_LOG_FILE = systemLogFile;

const now = "2026-01-01T00:00:00.000Z";
const laterExpiry = "2026-06-01T00:00:00.000Z";
const earlierExpiry = "2026-05-01T00:00:00.000Z";
const originalDateNow = Date.now;

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const stockOf = (store: InMemoryStoreService, deviceCode: string, goodsId: string) =>
  store.devices
    .find((device) => device.deviceCode === deviceCode)
    ?.doors.flatMap((door) => door.goods)
    .find((goods) => goods.goodsId === goodsId)?.stock;

const resetStore = (store: InMemoryStoreService, goods: GoodsCatalogItem, deviceGoods: DeviceGoods) => {
  const users: UserRecord[] = [
    {
      id: "admin-1",
      role: "admin",
      phone: "13800000001",
      name: "管理员",
      status: "active",
      tags: []
    },
    {
      id: "merchant-1",
      role: "merchant",
      phone: "13800000002",
      name: "商户",
      status: "active",
      tags: []
    },
    {
      id: "special-1",
      role: "special",
      phone: "13800000003",
      name: "领取人",
      status: "active",
      tags: []
    }
  ];
  const devices: DeviceRecord[] = [
    {
      deviceCode: "device-a",
      name: "一号柜",
      location: "社区 A",
      status: "online",
      lastSeenAt: now,
      doors: [{ doorNum: "1", label: "1 号门", goods: [deviceGoods] }]
    },
    {
      deviceCode: "device-b",
      name: "二号柜",
      location: "社区 B",
      status: "online",
      lastSeenAt: now,
      doors: [{ doorNum: "1", label: "1 号门", goods: [] }]
    }
  ];

  store.users.splice(0, store.users.length, ...users);
  store.goodsCatalog.splice(0, store.goodsCatalog.length, goods);
  store.devices.splice(0, store.devices.length, ...devices);
  store.goodsBatches.splice(0, store.goodsBatches.length);
  store.batchConsumptionTraces.splice(0, store.batchConsumptionTraces.length);
  store.inventoryTransfers.splice(0, store.inventoryTransfers.length);
  store.inventory.splice(0, store.inventory.length);
  store.logs.splice(0, store.logs.length);
  store.syncDeviceStocksFromBatches();
};

try {
  Date.now = () => Date.parse(now);
  const store = new InMemoryStoreService();
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const goods: GoodsCatalogItem = {
    goodsCode: "goods-a",
    goodsId: "goods-a",
    name: "测试物资",
    category: "food",
    price: 3,
    imageUrl: "https://dummyimage.com/160x160/d8e8ff/0b1220.png&text=test",
    status: "active"
  };
  const deviceGoods: DeviceGoods = {
    ...goods,
    stock: 0
  };
  const createMovement = (payload: Partial<InventoryMovement> & Pick<InventoryMovement, "type" | "quantity">) =>
    ({
      id: store.createId("movement"),
      userId: "admin-1",
      deviceCode: "device-a",
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      unitPrice: goods.price,
      happenedAt: now,
      ...payload
    }) satisfies InventoryMovement;

  resetStore(store, goods, deviceGoods);

  const mainRestock = inventoryBatchChanges.recordRestockMovement({
    movement: createMovement({
      type: "manual-restock",
      quantity: 10,
      expiresAt: laterExpiry
    }),
    deviceGoods,
    batch: {
      sourceType: "admin",
      sourceUserId: "admin-1",
      sourceUserName: "管理员",
      expiresAt: laterExpiry,
      createdAt: now
    }
  });
  const mainBatch = mainRestock.createdBatches[0];
  assert(mainBatch?.remainingQuantity === 10, "补货应创建剩余数量为 10 的批次。");
  assert(mainRestock.movements[0]?.batchId === mainBatch.batchId, "补货流水应指向新批次。");
  assert(stockOf(store, "device-a", goods.goodsId) === 10, "补货后柜机库存应同步为 10。");

  const earlierRestock = inventoryBatchChanges.recordRestockMovement({
    movement: createMovement({
      type: "manual-restock",
      quantity: 5,
      expiresAt: earlierExpiry
    }),
    deviceGoods,
    batch: {
      sourceType: "merchant",
      sourceUserId: "merchant-1",
      sourceUserName: "商户",
      expiresAt: earlierExpiry,
      createdAt: now
    }
  });
  const earlierBatch = earlierRestock.createdBatches[0];

  const pickup = inventoryBatchChanges.recordConsumptiveMovement({
    movement: createMovement({
      type: "pickup",
      userId: "special-1",
      quantity: 7
    }),
    trace: {
      eventId: "event-1",
      orderNo: "order-1"
    }
  });

  assert(pickup.consumedBatches.length === 2, "领取应先消耗临期批次，再消耗后续批次。");
  assert(pickup.consumedBatches[0]?.batchId === earlierBatch?.batchId, "首个消耗批次应为最早保质期批次。");
  assert(pickup.consumedBatches[0]?.quantity === 5, "最早保质期批次应被扣减 5。");
  assert(pickup.consumedBatches[1]?.batchId === mainBatch.batchId, "第二个消耗批次应为后续批次。");
  assert(pickup.consumedBatches[1]?.quantity === 2, "后续批次应被扣减 2。");
  assert(store.batchConsumptionTraces.length === 2, "领取应记录每个消耗批次的消费追踪。");
  assert(stockOf(store, "device-a", goods.goodsId) === 8, "领取后柜机库存应同步为 8。");

  const overdraft = inventoryBatchChanges.recordConsumptiveMovement({
    movement: createMovement({
      type: "adjustment",
      userId: "special-1",
      quantity: 20
    }),
    trace: {
      eventId: "event-2",
      orderNo: "order-2"
    }
  });

  assert(overdraft.negativeBalance?.quantity === 12, "库存不足时应产生正式负库存平衡。");
  assert(
    overdraft.consumedBatches.some((entry) => entry.selectionReason === "negative_balance" && entry.quantity === 12),
    "负库存平衡应出现在消耗批次明细中。"
  );
  assert(stockOf(store, "device-a", goods.goodsId) === -12, "负库存平衡后柜机库存应为 -12。");

  inventoryBatchChanges.undoConsumptiveBatchChange({
    deviceCode: "device-a",
    consumedBatches: overdraft.consumedBatches,
    movement: createMovement({
      type: "manual-restock",
      quantity: 0
    })
  });
  assert(stockOf(store, "device-a", goods.goodsId) === 8, "撤销消耗后应恢复原批次并清理负库存平衡。");

  const transfer = inventoryBatchChanges.recordTransfer({
    id: store.createId("transfer"),
    from: { type: "device", code: "device-a", name: "一号柜" },
    to: { type: "device", code: "device-b", name: "二号柜" },
    goods: deviceGoods,
    quantity: 3,
    sourceBatchId: mainBatch.batchId,
    happenedAt: now,
    actorUserId: "admin-1",
    actorUserName: "管理员",
    note: "烟测调拨"
  });
  const transferredBatch = transfer.createdBatches[0];

  assert(transfer.transfers[0]?.quantity === 3, "调拨记录数量应等于实际调拨数量。");
  assert(transferredBatch?.remainingQuantity === 3, "调入柜机应创建对应批次。");
  assert(stockOf(store, "device-a", goods.goodsId) === 5, "调出柜机库存应减少 3。");
  assert(stockOf(store, "device-b", goods.goodsId) === 3, "调入柜机库存应增加 3。");

  inventoryBatchChanges.undoRestockBatchChange({
    batchId: transferredBatch.batchId,
    quantity: 2,
    movement: createMovement({
      type: "manual-deduction",
      deviceCode: "device-b",
      quantity: 2,
      batchId: transferredBatch.batchId
    })
  });
  assert(stockOf(store, "device-b", goods.goodsId) === 1, "撤销补货批次应扣回调入柜机库存。");

  inventoryBatchChanges.restoreRemovedBatch({
    batchId: transferredBatch.batchId,
    quantity: 2,
    movement: createMovement({
      type: "manual-restock",
      deviceCode: "device-b",
      quantity: 2,
      batchId: transferredBatch.batchId
    })
  });
  assert(stockOf(store, "device-b", goods.goodsId) === 3, "恢复已扣批次应补回库存。");

  const specificDeduction = inventoryBatchChanges.recordSpecificBatchDeduction({
    batchId: transferredBatch.batchId,
    quantity: 1,
    movement: createMovement({
      type: "manual-deduction",
      deviceCode: "device-b",
      quantity: 1,
      batchId: transferredBatch.batchId
    }),
    trace: {
      enabled: false
    }
  });
  const specificTrace = inventoryBatchChanges.recordConsumptionTraces({
    movement: specificDeduction.movements[0]!,
    consumedBatches: specificDeduction.consumedBatches,
    sourceLogId: "operation-log-1",
    consumerUserName: "管理员",
    note: "烟测手工去除批次"
  })[0];
  assert(stockOf(store, "device-b", goods.goodsId) === 2, "指定批次扣减应同步柜机库存。");
  assert(specificTrace?.sourceLogId === "operation-log-1", "消费追踪应能在操作日志生成后补充 sourceLogId。");

  inventoryBatchChanges.markConsumptionTracesReverted("operation-log-1", "undo-log-1");
  assert(specificTrace.revertedByLogId === "undo-log-1", "撤销操作应标记相关消费追踪。");

  inventoryBatchChanges.restoreRemovedBatch({
    batchId: transferredBatch.batchId,
    quantity: 1,
    movement: createMovement({
      type: "manual-restock",
      deviceCode: "device-b",
      quantity: 1,
      batchId: transferredBatch.batchId
    })
  });
  assert(stockOf(store, "device-b", goods.goodsId) === 3, "恢复指定扣减后应补回库存。");

  const movementCountBeforeBatchOnly = store.inventory.length;
  inventoryBatchChanges.recordBatchOnly({
    goodsId: goods.goodsId,
    deviceCode: "device-b",
    quantity: 4,
    sourceType: "system",
    sourceUserId: "admin-1",
    sourceUserName: "管理员"
  });
  inventoryBatchChanges.consumeBatchesOnly({
    goodsId: goods.goodsId,
    deviceCode: "device-b",
    quantity: 1
  });

  assert(store.inventory.length === movementCountBeforeBatchOnly, "只改批次路径不应新增库存流水。");
  assert(stockOf(store, "device-b", goods.goodsId) === 6, "只改批次路径仍应同步柜机库存。");

  inventoryBatchChanges.applyStocktakeCorrection({
    deviceCode: "device-b",
    goods: deviceGoods,
    delta: 2,
    sourceUserId: "admin-1",
    sourceUserName: "管理员",
    note: "烟测盘点补录"
  });
  inventoryBatchChanges.applyStocktakeCorrection({
    deviceCode: "device-b",
    goods: deviceGoods,
    delta: -3,
    sourceUserId: "admin-1",
    sourceUserName: "管理员",
    note: "烟测盘点扣减"
  });

  assert(store.inventory.length === movementCountBeforeBatchOnly, "盘点修正不应新增库存流水。");
  assert(stockOf(store, "device-b", goods.goodsId) === 5, "盘点修正应同步柜机库存。");

  console.log("库存批次变化烟测通过。");
} finally {
  Date.now = originalDateNow;
  for (const filePath of [dataFile, systemLogFile]) {
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }
}
