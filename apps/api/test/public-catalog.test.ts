import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { PublicDevice } from "@vm/shared-types";

import { AppModule } from "../src/app.module";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { PublicCatalogService } from "../src/modules/public-catalog/public-catalog.service";
import { listenOnFetchSafeLoopbackPort } from "./support/fetch-safe-api-listener";

const directories: string[] = [];
const original = { API_DATA_FILE: process.env.API_DATA_FILE, VM_GOODS_EXPIRY_MODE: process.env.VM_GOODS_EXPIRY_MODE };
after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const isolate = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-public-catalog-"));
  directories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
};

test("游客库存使用真实账本，合并旧货号，保留停用和负库存边界，且不改变任何业务记录", () => {
  isolate();
  const store = new InMemoryStoreService();
  const catalog = new PublicCatalogService(store);
  const device = store.devices[0]!;
  const source = store.goodsCatalog[0]!;
  const goods = store.ensureGoodsCatalogItem({ ...source, goodsId: "guest-good", goodsCode: "guest-good", status: "active" });
  const inactive = store.ensureGoodsCatalogItem({ ...source, goodsId: "guest-inactive", goodsCode: "guest-inactive", status: "inactive" });
  const negative = store.ensureGoodsCatalogItem({ ...source, goodsId: "guest-negative", goodsCode: "guest-negative", status: "active" });
  store.goodsCatalog.push({ ...goods, goodsId: "guest-alias", mergedIntoGoodsId: goods.goodsId });
  device.doors = [{ doorNum: "1", label: "一号门", goods: [
    { ...goods, stock: 999 }, { ...goods, goodsId: "guest-alias", stock: 999 },
    { ...inactive, stock: 999 }, { ...negative, stock: 999 }
  ] }];
  store.goodsBatches.splice(0);
  store.reservations.splice(0);
  const batches = new InventoryBatchChangesService(store);
  const add = (goodsId: string, quantity: number, expiresAt?: string) =>
    batches.recordBatchOnly({ deviceCode: device.deviceCode, goodsId, quantity, expiresAt, sourceType: "system" });
  add(goods.goodsId, 5);
  add(goods.goodsId, 2, "2000-01-01T00:00:00.000Z");
  add(inactive.goodsId, 10);
  store.consumeGoodsBatches(device.deviceCode, negative.goodsId, 3);
  const now = new Date().toISOString();
  store.reservations.push({
    id: "private-reservation", userId: "private-person", phone: "19900000001", userName: "私人姓名",
    deviceCode: device.deviceCode, doorNum: "1", status: "active",
    inventoryReservationMode: "goods_quantity", batchAllocationTiming: "on_open",
    items: [{ goodsId: goods.goodsId, goodsName: goods.name, category: goods.category, quantity: 1 }], reservedAt: now, createdAt: now, updatedAt: now,
    expiresAt: "2100-01-01T00:00:00.000Z"
  });
  for (const [mode, expectedStock] of [["warning_only", 6], ["enforced", 4]] as const) {
    process.env.VM_GOODS_EXPIRY_MODE = mode;
    const before = structuredClone(store.snapshot());
    const result = catalog.detail(device.deviceCode, store.getDefaultTenantId());
    assert.equal(result.doors[0]!.goods.length, 3);
    assert.equal(result.doors[0]!.goods.find((item) => item.goodsId === goods.goodsId)?.stock, expectedStock);
    assert.equal(result.doors[0]!.goods.find((item) => item.goodsId === inactive.goodsId)?.stock, 0);
    assert.equal(result.doors[0]!.goods.find((item) => item.goodsId === negative.goodsId)?.stock, 0);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(Object.keys(result.doors[0]!.goods[0]!).sort(), ["category", "goodsId", "imageUrl", "name", "status", "stock"]);
    assert.doesNotMatch(JSON.stringify(result), /private-person|private-reservation|私人姓名|tenantId|runtime|lastSeenAt|threshold|phone|sourceUser|batchId/);
  }
});

test("匿名 HTTP 查询仅能读取域名所属实例，未知、重名、暂停入口及跨实例编号均拒绝，写入仍需登录", async () => {
  isolate();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  app.setGlobalPrefix("api");
  app.set("trust proxy", 1);
  const port = await listenOnFetchSafeLoopbackPort(app);
  const store = app.get(InMemoryStoreService);
  try {
    const tenantA = store.platformTenants[0]!;
    tenantA.instanceUrl = "https://guest-a.example.test";
    const tenantB = { ...tenantA, id: "guest-tenant-b", code: "guest-b", instanceUrl: "https://guest-b.example.test" };
    store.platformTenants.push(tenantB);
    const deviceA = store.devices[0]!;
    const deviceB = { ...structuredClone(deviceA), deviceCode: "GUEST-B", tenantId: tenantB.id };
    store.devices.push(deviceB);
    const request = (path: string, host = "guest-a.example.test", method = "GET") =>
      fetch(`http://127.0.0.1:${port}/api${path}`, {
        method, headers: { "x-forwarded-host": host, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ deviceCode: deviceA.deviceCode, phone: "19900000001" }) } : {})
      });
    const before = structuredClone(store.snapshot());
    const response = await request("/public/devices?tenantId=guest-tenant-b");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as { data: PublicDevice[] };
    assert.ok(payload.data.some((device) => device.deviceCode === deviceA.deviceCode));
    assert.ok(!payload.data.some((device) => device.deviceCode === deviceB.deviceCode));
    assert.equal((await request(`/public/devices/${deviceA.deviceCode}`)).status, 200);
    assert.equal((await request(`/public/devices/${deviceB.deviceCode}`)).status, 404);
    assert.equal((await request(`/public/devices/${deviceB.deviceCode}`, "guest-b.example.test")).status, 200);
    assert.equal((await request("/public/devices", "unbound.example.test")).status, 404);
    assert.deepEqual(store.snapshot(), before, "公开 GET 不得写入任何业务数据");
    tenantB.status = "paused";
    assert.equal((await request("/public/devices", "guest-b.example.test")).status, 404);
    tenantB.status = tenantA.status;
    tenantB.instanceUrl = tenantA.instanceUrl;
    assert.equal((await request("/public/devices")).status, 404);
    tenantB.instanceUrl = "https://guest-b.example.test";
    for (const path of ["/devices", `/devices/${deviceA.deviceCode}`, "/users", "/inventory-orders", "/access-rules/summary"]) {
      assert.equal((await request(path)).status, 403, path);
    }
    const beforeProtected = structuredClone(store.snapshot());
    for (const path of ["/cabinet-events/open", "/cabinet-events/open/pre-settlement", "/public/devices", `/devices/${deviceA.deviceCode}/goods/query`]) {
      assert.ok([403, 404].includes((await request(path, "guest-a.example.test", "POST")).status), path);
    }
    assert.deepEqual(store.snapshot(), beforeProtected, "匿名请求不能开门或生成订单、扣库存");
  } finally {
    await app.close();
  }
});
