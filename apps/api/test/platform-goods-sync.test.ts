import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Reflector } from "@nestjs/core";
import type { GoodsCatalogItem } from "@vm/shared-types";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { RoleGuard } from "../src/common/guards/role.guard";
import { GoodsService } from "../src/modules/goods/goods.service";
import { GoodsController } from "../src/modules/goods/goods.controller";
import { PlatformGoodsSyncService } from "../src/modules/goods/platform-goods-sync.service";

const directories: string[] = [];
const previous = process.env.API_DATA_FILE;
after(() => {
  if (previous === undefined) delete process.env.API_DATA_FILE; else process.env.API_DATA_FILE = previous;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "vm-platform-goods-sync-"));
  directories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  const store = new InMemoryStoreService();
  store.events.splice(0); store.reservations.splice(0);
  const device = store.devices[0]!;
  store.devices.splice(1);
  device.doors = [{ doorNum: "1", label: "右门", goods: [] }, { doorNum: "2", label: "左门", goods: [] }];
  const item: GoodsCatalogItem = { goodsId: "sync-platform-item", goodsCode: "6900000000001", name: "平台测试货品", price: 100, category: "food", imageUrl: "" };
  let query: (args: { deviceCode: string; doorNum: string }) => Promise<GoodsCatalogItem[] | undefined> = async () => [item];
  const calls: string[] = [];
  const goods = new GoodsService(store, new InventoryBatchChangesService(store), { getGoodsInfo: async (args: { deviceCode: string; doorNum: string }) => {
    calls.push(`${args.deviceCode}/${args.doorNum}`); return query(args);
  } } as never);
  let held = true;
  const writer = { getStatus: () => ({ held }), assertHeld: () => assert.ok(held) };
  const audit = { isReady: () => true };
  const service = () => new PlatformGoodsSyncService(goods, store, writer as never, audit as never);
  return { store, device, item, goods, calls, service, setQuery: (fn: typeof query) => { query = fn; }, loseLease: () => { held = false; } };
}

async function finish(service: PlatformGoodsSyncService) {
  for (let i = 0; i < 100 && service.getStatus().report?.status === "running"; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.notEqual(service.getStatus().report?.status, "running");
  return service.getStatus().report!;
}

test("遍历当前实例所有柜门，重复货品汇总一次，新增柜机在下一次自动纳入", async () => {
  const h = harness();
  h.store.devices.push({ ...structuredClone(h.device), deviceCode: "other-tenant", tenantId: "other" });
  const sync = h.service();
  sync.start();
  let report = await finish(sync);
  assert.equal(report.status, "success");
  assert.equal(report.deviceCount, 1); assert.equal(report.doors.length, 2); assert.equal(report.goodsCount, 1);
  assert.equal(h.device.doors[0]!.goods[0]!.goodsId, h.item.goodsId);
  assert.equal(h.device.doors[1]!.goods[0]!.goodsId, h.item.goodsId);
  assert.equal(h.calls.some((call) => call.startsWith("other-tenant")), false);
  h.store.devices.push({ ...structuredClone(h.device), deviceCode: "new-device" });
  sync.start(); report = await finish(sync);
  assert.equal(report.deviceCount, 2); assert.equal(report.doors.length, 4); assert.equal(report.goodsCount, 1);
});

test("单门失败不中止其他柜门；空列表保留本地货品，未配置平台不报成功", async () => {
  const h = harness();
  h.device.doors[0]!.goods.push({ ...h.item, stock: 0 });
  h.store.ensureGoodsCatalogItem(h.item);
  h.setQuery(async ({ doorNum }) => { if (doorNum === "2") throw new Error("secret upstream response"); return []; });
  const sync = h.service(); sync.start();
  const report = await finish(sync);
  assert.equal(report.status, "partial");
  assert.equal(report.goodsCount, 0);
  assert.equal(h.store.devices[0]!.doors[0]!.goods.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  h.setQuery(async () => undefined); sync.start();
  assert.equal((await finish(sync)).status, "failed");
});

test("同编号改名更新默认全名，保留专门维护的全名、库存、分类及领取规则", async () => {
  const h = harness();
  const existing = h.store.goodsCatalog[0]!;
  h.item.goodsId = existing.goodsId; h.item.goodsCode = existing.goodsCode;
  existing.fullName = existing.name;
  const before = { batches: structuredClone(h.store.goodsBatches), inventory: structuredClone(h.store.inventory), users: structuredClone(h.store.users), category: existing.category, taxonomy: existing.taxonomyNodeId };
  await h.goods.syncDeviceGoods(h.device.deviceCode, "2");
  assert.equal(existing.name, h.item.name); assert.equal(existing.fullName, h.item.name);
  assert.equal(existing.category, before.category); assert.equal(existing.taxonomyNodeId, before.taxonomy);
  assert.deepEqual(h.store.goodsBatches, before.batches); assert.deepEqual(h.store.inventory, before.inventory); assert.deepEqual(h.store.users, before.users);
  existing.fullName = "本地维护的详细名称"; h.item.name = "平台再次改名";
  await h.goods.syncDeviceGoods(h.device.deviceCode, "2");
  assert.equal(existing.fullName, "本地维护的详细名称");
  assert.equal(h.device.doors[0]!.goods.length, 0);
});

test("北京时间23点每晚一次，部分失败及重启不重复，下一晚可执行", async () => {
  const h = harness(); const sync = h.service();
  h.setQuery(async () => { throw new Error("offline"); });
  assert.equal(sync.runNightly(new Date("2026-09-22T14:59:59Z")), false);
  assert.equal(sync.runNightly(new Date("2026-09-22T15:00:00Z")), true);
  assert.equal(sync.runNightly(new Date("2026-09-22T15:00:01Z")), false);
  await finish(sync);
  const restartedStore = new InMemoryStoreService();
  const restarted = new PlatformGoodsSyncService(h.goods, restartedStore, { getStatus: () => ({ held: true }), assertHeld: () => {} } as never, {} as never);
  assert.equal(restarted.runNightly(new Date("2026-09-22T15:59:00Z")), false);
  assert.equal(sync.runNightly(new Date("2026-09-23T15:00:00Z")), true);
  await finish(sync); assert.equal(h.calls.length, 4);
});

test("手动与夜间任务复用同次运行；查询后丢失租约不写商品，持久进度标为中断", async () => {
  const h = harness(); const sync = h.service();
  let release: () => void = () => {};
  h.setQuery(async () => { await new Promise<void>((resolve) => { release = resolve; }); return [h.item]; });
  const first = sync.start();
  assert.equal(sync.start().report!.id, first.report!.id);
  assert.equal(sync.runNightly(new Date("2026-09-22T15:00:00Z")), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.loseLease(); release();
  assert.equal((await finish(sync)).status, "interrupted");
  assert.equal(h.store.goodsCatalog.some((item) => item.goodsId === h.item.goodsId), false);
  assert.equal(h.calls.length, 1);
  assert.throws(() => sync.start());
});

test("同名合并被未结算订单阻止时整个柜门回滚，不留下半份同步资料", async () => {
  const h = harness();
  const source = h.store.goodsCatalog[0]!;
  h.store.events.push({ status: "opened", goods: [{ goodsId: source.goodsId }] } as never);
  // 本测试只检查内存事务回滚，不持久化故意简化的在途事件。
  h.setQuery(async () => [h.item, { ...h.item, goodsId: "another-id", name: source.name }]);
  await assert.rejects(h.goods.syncDeviceGoods(h.device.deviceCode), /未结算/);
  assert.equal(h.store.goodsCatalog.some((item) => item.goodsId === h.item.goodsId), false);
});

test("同步接口只能由当前实例有货品管理权限的后台账号调用", () => {
  function allowed(method: "syncAll" | "syncStatus", permissions: string[], tenantId = "default", role = "admin", authenticated = true) {
    const session = { backofficeRole: "admin", tenantId };
    const user = { id: "admin", name: "管理员", role };
    const guard = new RoleGuard(new Reflector(), {
      getSession: () => authenticated ? session : undefined,
      getBackofficeSessionUser: () => ({ user }), getSessionUser: () => undefined,
      getBackofficeSessionPermissions: () => permissions, getDefaultTenantId: () => "default"
    } as never);
    return guard.canActivate({ getHandler: () => GoodsController.prototype[method], getClass: () => GoodsController,
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, query: {} }) }) } as never);
  }
  assert.equal(allowed("syncAll", ["goods:manage"]), true);
  assert.equal(allowed("syncStatus", ["goods:view"]), true);
  assert.throws(() => allowed("syncAll", ["goods:view"]));
  assert.throws(() => allowed("syncAll", ["goods:manage"], "other"));
  assert.throws(() => allowed("syncAll", ["goods:manage"], "default", "special"));
  assert.throws(() => allowed("syncAll", [], "default", "admin", false));
});

test("生产同步必须先有审计意图，审计失败时既不查平台也不写执行日期", () => {
  const h = harness();
  const previousEnvironment = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    const sync = new PlatformGoodsSyncService(h.goods, h.store, {
      getStatus: () => ({ held: true }), assertHeld: () => {}
    } as never, {
      isReady: () => true, beginCriticalIntent: () => { throw new Error("审计不可用"); }
    } as never);
    h.store.isPersistedStateIntegrityReady = () => true;
    const count = h.store.logs.length;
    assert.throws(() => sync.start(), /审计不可用/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.logs.length, count);
  } finally {
    if (previousEnvironment === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previousEnvironment;
  }
});
