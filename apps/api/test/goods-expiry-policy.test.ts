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

test("仅提醒模式可调拨和扣减登记到期批次，后台仍保留到期提醒与原日期", () => {
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
    const expired = batches.recordBatchOnly({ deviceCode: warehouse.code, goodsId: goods.goodsId,
      quantity: 5, expiresAt: "2000-01-01T00:00:00.000Z", sourceType: "system" }).createdBatches[0]!;
    const snapshot = warehouses.getInventory();
    assert.equal(snapshot.goodsExpiryMode, "warning_only");
    assert.equal(snapshot.physicalTotalStock, 5);
    assert.equal(snapshot.transferableTotalStock, 5);
    assert.equal(snapshot.expiredTotalStock, 5, "提醒与可调拨库存可重叠，不能因放行而丢掉后台提醒");
    assert.ok(snapshot.expiredBatches.some((batch) => batch.batchId === expired.batchId));
    const transferred = warehouses.transfer({ fromCode: warehouse.code, toCode: device.deviceCode,
      goodsId: goods.goodsId, quantity: 2, sourceBatchId: expired.batchId });
    assert.equal(transferred.batches[0]!.sourceBatchId, expired.batchId);
    assert.equal(expired.remainingQuantity, 3);
    assert.equal(store.getAvailableStock(device.deviceCode, goods.goodsId), 2);
    const target = store.getGoodsBatches(device.deviceCode, goods.goodsId)[0]!;
    assert.equal(target.expiresAt, expired.expiresAt);
    store.consumeGoodsBatches(device.deviceCode, goods.goodsId, 1);
    assert.equal(target.remainingQuantity, 1);
    assert.equal(store.goodsBatches.some((batch) => batch.remainingQuantity < 0), false);
    store.persist();
    const reloaded = new InMemoryStoreService();
    assert.equal(reloaded.getAvailableStock(device.deviceCode, goods.goodsId), 1);
    assert.equal(reloaded.getGoodsBatches(device.deviceCode, goods.goodsId)[0]!.expiresAt, expired.expiresAt);
    process.env.VM_GOODS_EXPIRY_MODE = "enforced";
    assert.equal(reloaded.getAvailableStock(device.deviceCode, goods.goodsId), 0, "切回严格策略不需要改写批次");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
