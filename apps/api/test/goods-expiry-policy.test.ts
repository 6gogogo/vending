import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getGoodsExpiryMode } from "../src/common/config/goods-expiry-policy";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { WarehousesService } from "../src/modules/warehouses/warehouses.service";

test("保质期策略默认严格校验，错误配置不能静默放行", () => {
  assert.equal(getGoodsExpiryMode({}), "enforced");
  assert.equal(getGoodsExpiryMode({ VM_GOODS_EXPIRY_MODE: "warning_only" }), "warning_only");
  assert.throws(() => getGoodsExpiryMode({ VM_GOODS_EXPIRY_MODE: "typo" }), /VM_GOODS_EXPIRY_MODE/);
});

for (const [label, expiresAt] of [
  ["登记已到期", "2000-01-01T00:00:00.000Z"],
  ["未设保质期", undefined]
] as const) {
test(`仅提醒模式下${label}批次可见、可调拨和扣减，持久化后保留日期原值`, () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-expiry-warning-"));
  const previous = { API_DATA_FILE: process.env.API_DATA_FILE, VM_GOODS_EXPIRY_MODE: process.env.VM_GOODS_EXPIRY_MODE };
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.VM_GOODS_EXPIRY_MODE = "warning_only";
  try {
    const store = new InMemoryStoreService();
    store.goodsBatches.splice(0);
    const batches = new InventoryBatchChangesService(store);
    const warehouses = new WarehousesService(store, batches);
    const warehouse = store.warehouses.find((entry) => entry.status === "active")!;
    const device = store.devices[0]!;
    const goods = store.goodsCatalog[0]!;
    const source = batches.recordBatchOnly({ deviceCode: warehouse.code, goodsId: goods.goodsId,
      quantity: 5, expiresAt, sourceType: "system" }).createdBatches[0]!;
    const snapshot = warehouses.getInventory();
    assert.equal(snapshot.goodsExpiryMode, "warning_only");
    assert.equal(snapshot.physicalTotalStock, 5);
    assert.equal(snapshot.transferableTotalStock, 5);
    assert.equal(snapshot.expiredTotalStock, expiresAt ? 5 : 0, "到期库存保留提醒，无日期用品不应被误报为过期");
    assert.ok(snapshot.physicalBatches.some((batch) => batch.batchId === source.batchId));
    assert.ok(snapshot.transferableBatches.some((batch) => batch.batchId === source.batchId));
    assert.equal(snapshot.expiredBatches.some((batch) => batch.batchId === source.batchId), Boolean(expiresAt));
    const transferred = warehouses.transfer({ fromCode: warehouse.code, toCode: device.deviceCode,
      goodsId: goods.goodsId, quantity: 2, sourceBatchId: source.batchId });
    assert.equal(transferred.batches[0]!.sourceBatchId, source.batchId);
    assert.equal(source.remainingQuantity, 3);
    assert.equal(store.getAvailableStock(device.deviceCode, goods.goodsId), 2);
    const target = store.getGoodsBatches(device.deviceCode, goods.goodsId)[0]!;
    assert.equal(target.expiresAt, expiresAt);
    store.consumeGoodsBatches(device.deviceCode, goods.goodsId, 1);
    assert.equal(target.remainingQuantity, 1);
    assert.equal(store.goodsBatches.some((batch) => batch.remainingQuantity < 0), false);
    store.persist();
    const reloaded = new InMemoryStoreService();
    assert.equal(reloaded.getAvailableStock(device.deviceCode, goods.goodsId), 1);
    assert.equal(reloaded.getGoodsBatches(device.deviceCode, goods.goodsId)[0]!.expiresAt, expiresAt);
    process.env.VM_GOODS_EXPIRY_MODE = "enforced";
    assert.equal(reloaded.getAvailableStock(device.deviceCode, goods.goodsId), expiresAt ? 0 : 1, "无日期用品在严格模式下也不能被当成过期");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
}
