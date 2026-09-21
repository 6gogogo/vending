import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { PublicProduct } from "@vm/shared-types";

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

test("游客只看到去重的商品图片与名称，不读取或泄露柜机、库存、可领状态及业务记录", () => {
  isolate();
  const store = new InMemoryStoreService();
  const catalog = new PublicCatalogService(store);
  const device = store.devices[0]!;
  store.devices.splice(1);
  const source = store.goodsCatalog[0]!;
  const addProduct = (goodsId: string, status: "active" | "inactive" = "active") =>
    store.ensureGoodsCatalogItem({ ...source, goodsId, goodsCode: goodsId, status });
  const goods = addProduct("guest-good");
  const inactive = addProduct("guest-inactive", "inactive");
  const negative = addProduct("guest-negative");
  const empty = addProduct("guest-empty");
  const unassigned = addProduct("guest-unassigned");
  store.goodsCatalog.push({ ...goods, goodsId: "guest-alias", mergedIntoGoodsId: goods.goodsId });
  device.address = "private-address";
  device.doors = [{ doorNum: "1", label: "private-door", goods: [
    { ...goods, stock: 999 }, { ...goods, goodsId: "guest-alias", stock: 999 },
    { ...inactive, stock: 999 }, { ...negative, stock: -3 }, { ...empty, stock: 0 }
  ] }];
  store.devices.push({ ...structuredClone(device), deviceCode: "PRIVATE-SECOND" });
  store.goodsBatches.splice(0);
  store.reservations.splice(0);
  const batches = new InventoryBatchChangesService(store);
  batches.recordBatchOnly({ deviceCode: device.deviceCode, goodsId: goods.goodsId, quantity: 7,
    expiresAt: "2000-01-01T00:00:00.000Z", sourceType: "system" });
  store.consumeGoodsBatches(device.deviceCode, negative.goodsId, 3);
  store.getReservableStock = () => { throw new Error("游客橱窗不得读取可用库存"); };
  let baseline: PublicProduct[] | undefined;
  for (const mode of ["warning_only", "enforced"]) {
    process.env.VM_GOODS_EXPIRY_MODE = mode;
    const before = structuredClone(store.snapshot());
    const result = catalog.list(store.getDefaultTenantId());
    assert.deepEqual(result.map((item) => item.goodsId), [goods.goodsId, negative.goodsId, empty.goodsId]);
    assert.ok(!result.some((item) => item.goodsId === inactive.goodsId || item.goodsId === unassigned.goodsId));
    for (const product of result) {
      assert.deepEqual(Object.keys(product).sort(), ["goodsId", "imageUrl", "name"]);
    }
    assert.doesNotMatch(JSON.stringify(result), /private-address|private-door|PRIVATE-SECOND|stock|deviceCode|tenantId|status|phone|batchId/);
    assert.deepEqual(store.snapshot(), before, "游客浏览不写入任何业务记录");
    if (baseline) assert.deepEqual(result, baseline, "商品橱窗不随保质期或库存策略暴露可领状态");
    baseline = result;
  }
  store.goodsBatches.splice(0);
  device.status = "offline";
  for (const item of device.doors[0]!.goods) item.stock = 0;
  assert.deepEqual(catalog.list(store.getDefaultTenantId()), baseline, "库存和设备状态改变不影响游客商品信息");
});

test("商品橱窗按域名隔离实例；旧公开库存接口已移除，私人接口与开门仍拒绝匿名调用", async () => {
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
    const goodsB = store.ensureGoodsCatalogItem({ ...store.goodsCatalog[0]!, goodsId: "guest-b-product", goodsCode: "guest-b-product", status: "active" });
    store.devices.push({ ...structuredClone(deviceA), deviceCode: "GUEST-B", tenantId: tenantB.id,
      doors: [{ doorNum: "1", label: "B 门", goods: [{ ...goodsB, stock: 123 }] }] });
    const request = (path: string, host = "guest-a.example.test", method = "GET") =>
      fetch("http://127.0.0.1:" + port + "/api" + path, {
        method, headers: { "x-forwarded-host": host, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ deviceCode: deviceA.deviceCode, phone: "19900000001" }) } : {})
      });
    const before = structuredClone(store.snapshot());
    const response = await request("/public/products?tenantId=guest-tenant-b&deviceCode=GUEST-B");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as { data: PublicProduct[] };
    assert.ok(payload.data.length > 0);
    assert.ok(!payload.data.some((product) => product.goodsId === goodsB.goodsId));
    for (const product of payload.data) assert.deepEqual(Object.keys(product).sort(), ["goodsId", "imageUrl", "name"]);
    const responseB = await request("/public/products", "guest-b.example.test");
    assert.equal(responseB.status, 200);
    const payloadB = await responseB.json() as { data: PublicProduct[] };
    assert.deepEqual(payloadB.data.map((item) => item.goodsId), [goodsB.goodsId]);
    assert.equal((await request("/public/products", "unbound.example.test")).status, 404);
    for (const path of ["/public/devices", "/public/devices/" + deviceA.deviceCode, "/public/devices/GUEST-B"]) {
      assert.equal((await request(path)).status, 404, "旧游客接口不能继续暴露柜机库存");
    }
    assert.deepEqual(store.snapshot(), before);
    tenantB.status = "paused";
    assert.equal((await request("/public/products", "guest-b.example.test")).status, 404);
    tenantB.status = tenantA.status;
    tenantB.instanceUrl = tenantA.instanceUrl;
    assert.equal((await request("/public/products")).status, 404);
    tenantB.instanceUrl = "https://guest-b.example.test";
    for (const path of ["/devices", "/devices/" + deviceA.deviceCode, "/users", "/inventory-orders", "/access-rules/summary"]) {
      assert.equal((await request(path)).status, 403, path);
    }
    const beforeProtected = structuredClone(store.snapshot());
    for (const path of ["/cabinet-events/open", "/cabinet-events/open/pre-settlement", "/public/products", "/devices/" + deviceA.deviceCode + "/goods/query"]) {
      assert.ok([403, 404].includes((await request(path, "guest-a.example.test", "POST")).status), path);
    }
    assert.deepEqual(store.snapshot(), beforeProtected, "匿名请求不能开门或生成订单、扣库存");
  } finally {
    await app.close();
  }
});
