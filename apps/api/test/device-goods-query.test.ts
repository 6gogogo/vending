import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { DeviceGoods } from "@vm/shared-types";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { GoodsTaxonomyService } from "../src/modules/goods/goods-taxonomy.service";

const directories: string[] = [];
const originalDataFile = process.env.API_DATA_FILE;
after(() => {
  if (originalDataFile === undefined) delete process.env.API_DATA_FILE;
  else process.env.API_DATA_FILE = originalDataFile;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const harness = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-device-goods-query-"));
  directories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  const store = new InMemoryStoreService();
  store.goodsBatches.splice(0);
  store.reservations.splice(0);
  store.events.splice(0);
  store.inventory.splice(0);
  const device = store.devices[0]!;
  const batches = new InventoryBatchChangesService(store);
  const root = store.goodsTaxonomyNodes.find((node) => node.parentId === null) ??
    new GoodsTaxonomyService(store).createNode({ name: "任意", parentId: null }, undefined, store.getDefaultTenantId());
  const items = [
    ["9232701", "爱心盲盒"], ["9240463", "康师傅3+2苏打夹心饼干柠檬味"],
    ["9110016", "三得利乌龙茶_500ml"], ["8242266", "挂耳咖啡"], ["9220354", "奶油白酱培根意面"]
  ].map(([goodsId, name]) => ({ ...store.ensureGoodsCatalogItem({
    goodsId: goodsId!, goodsCode: `barcode-${goodsId}`, name: name!, price: 100,
    category: "food", imageUrl: "", status: "active", taxonomyNodeId: root.id
  }), stock: 0 }));
  device.doors.splice(0, device.doors.length, { doorNum: "1", label: "门 1", goods: items });
  const stock = (goodsId: string, quantity: number, expiresAt?: string) => batches.recordBatchOnly({
    deviceCode: device.deviceCode, goodsId, quantity, expiresAt, sourceType: "system"
  });
  stock("9232701", 19, "2100-01-01T00:00:00.000Z");
  stock("9240463", 10);
  stock("9110016", 6);
  stock("9110016", 1, "2000-01-01T00:00:00.000Z");
  store.consumeGoodsBatches(device.deviceCode, "8242266", 3);
  return { store, device, batches, items, root };
};

test("平台只返回部分货品时仍返回柜内完整清单，库存与首页及预约口径一致", async () => {
  const h = harness();
  const remote = [{ ...h.items[0]!, stock: 999, price: 500 }];
  const service = new DevicesService(h.store, h.batches, { getGoodsInfo: async () => remote } as never);
  const before = structuredClone(h.store.snapshot());
  const goods = await service.getGoods(h.device.deviceCode, "1", "special");
  assert.deepEqual(new Set(goods.map((item) => item.goodsId)), new Set(h.items.map((item) => item.goodsId)));
  const quantities = Object.fromEntries(goods.map((item) => [item.goodsId, item.stock]));
  assert.deepEqual(quantities, { "9232701": 19, "9240463": 10, "9110016": 6, "8242266": 0, "9220354": 0 });
  assert.equal(goods.find((item) => item.goodsId === "9232701")?.price, 500, "平台价格仍来自平台观测");
  assert.equal(goods.find((item) => item.goodsId === "9110016")?.expiresAt, undefined);
  assert.deepEqual(h.store.snapshot(), before, "查询不能同步配置、商品状态或改写库存");
  const home = service.list(undefined, "special").find((item) => item.deviceCode === h.device.deviceCode)!;
  for (const item of goods) {
    assert.equal(item.stock, h.store.getReservableStock(h.device.deviceCode, item.goodsId));
    assert.equal(item.stock, home.doors[0]!.goods.find((entry) => entry.goodsId === item.goodsId)?.stock);
    assert.equal(item.taxonomyNodeId, h.root.id);
  }
  const adminGoods = await service.getGoods(h.device.deviceCode, "1", "admin");
  assert.equal(adminGoods.find((item) => item.goodsId === "9110016")?.stock, 7);
  assert.equal(adminGoods.find((item) => item.goodsId === "8242266")?.stock, -3);
});

test("空响应和平台故障均保留本地清单，指定柜门不带出其他柜门的货品", async () => {
  const h = harness();
  const secondDoorGoods = h.device.doors[0]!.goods.pop()!;
  h.device.doors.push({ doorNum: "2", label: "门 2", goods: [secondDoorGoods] });
  for (const mode of ["partial", "empty", "unconfigured", "failed"]) {
    const service = new DevicesService(h.store, h.batches, { getGoodsInfo: async (payload: { doorNum: string }) => {
      assert.equal(payload.doorNum, "1");
      if (mode === "failed") throw new Error("平台暂不可用");
      return mode === "partial" ? [h.items[0]!] : mode === "empty" ? [] : undefined;
    } } as never);
    const goods = await service.getGoods(h.device.deviceCode, "1", "special");
    assert.deepEqual(new Set(goods.map((item) => item.goodsId)), new Set(h.device.doors[0]!.goods.map((item) => item.goodsId)), mode);
    assert.ok(!goods.some((item) => item.goodsId === secondDoorGoods.goodsId));
  }
});

test("补回本地商品时保留停用状态，平台观测与历史别名均不产生重复或写入", async () => {
  const h = harness();
  const biscuits = h.store.goodsCatalog.find((item) => item.goodsId === "9240463")!;
  biscuits.status = "inactive";
  const canonical = h.items[0]!;
  const alias = { ...canonical, goodsId: "old-blind-box", status: "inactive" as const, mergedIntoGoodsId: canonical.goodsId };
  h.store.goodsCatalog.push(alias);
  const remoteOnly: DeviceGoods = { ...canonical, goodsId: "remote-only", goodsCode: "remote-only", name: "仅平台观测货品", stock: 999 };
  const service = new DevicesService(h.store, h.batches, { getGoodsInfo: async () => [alias, canonical, remoteOnly] } as never);
  const before = structuredClone(h.store.snapshot());
  const goods = await service.getGoods(h.device.deviceCode, "1", "special");
  assert.equal(goods.filter((item) => item.goodsId === canonical.goodsId).length, 1);
  assert.ok(!goods.some((item) => item.goodsId === alias.goodsId));
  assert.equal(goods.find((item) => item.goodsId === biscuits.goodsId)?.status, "inactive");
  assert.equal(goods.find((item) => item.goodsId === biscuits.goodsId)?.stock, 0);
  assert.equal(goods.find((item) => item.goodsId === remoteOnly.goodsId)?.stock, 0);
  assert.deepEqual(h.store.snapshot(), before);
  const adminGoods = await service.getGoods(h.device.deviceCode, "1", "admin");
  assert.equal(adminGoods.find((item) => item.goodsId === biscuits.goodsId)?.stock, 10);
  const home = service.list(undefined, "special").find((item) => item.deviceCode === h.device.deviceCode)!;
  const homeBiscuits = home.doors[0]!.goods.find((item) => item.goodsId === biscuits.goodsId)!;
  assert.equal(homeBiscuits.status, "inactive");
  assert.equal(homeBiscuits.stock, 0);
});
