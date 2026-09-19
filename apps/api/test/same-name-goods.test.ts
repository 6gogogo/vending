import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ConfigService } from "@nestjs/config";
import type { CabinetEventRecord } from "@vm/shared-types";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { validatePersistedState } from "../src/common/store/persisted-state-integrity";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { GoodsService } from "../src/modules/goods/goods.service";
import { GoodsTaxonomyService } from "../src/modules/goods/goods-taxonomy.service";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";

const directories: string[] = [];
const previous = process.env.API_DATA_FILE;
after(() => {
  if (previous === undefined) delete process.env.API_DATA_FILE;
  else process.env.API_DATA_FILE = previous;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const harness = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-same-name-goods-"));
  directories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  const store = new InMemoryStoreService();
  store.events.splice(0); store.reservations.splice(0);
  store.inventory.splice(0); store.goodsBatches.splice(0); store.batchConsumptionTraces.splice(0);
  const device = store.devices[0]!;
  const user = store.users.find((entry) => entry.role === "special")!;
  const source = store.goodsCatalog.find((entry) => entry.goodsId === device.doors[0]!.goods[0]!.goodsId)!;
  const taxonomy = new GoodsTaxonomyService(store);
  store.goodsTaxonomyNodes.splice(0);
  for (const goods of store.goodsCatalog) delete goods.taxonomyNodeId;
  const root = taxonomy.createNode({ name: "任意", parentId: null }, undefined, store.getDefaultTenantId());
  source.taxonomyNodeId = root.id;
  user.accessPolicies = [{ id: "same-name-policy", name: "每日共享两件", status: "active",
    weekdays: [0,1,2,3,4,5,6], startHour: 0, endHour: 24, goodsLimits: [],
    entitlementLimits: [{ id: "same-name-limit", targetType: "goods", targetId: source.goodsId, quantity: 2 }] }];
  const remote = { ...source, goodsId: "platform-canonical", goodsCode: "platform-code", price: 500 };
  const gateway = { getGoodsInfo: async () => [remote] };
  const batches = new InventoryBatchChangesService(store);
  const goodsService = new GoodsService(store, batches, gateway as never);
  const devices = new DevicesService(store, batches, gateway as never);
  const orders = new InventoryOrdersService(store, batches, devices, new AlertsService(store), new ConfigService({}));
  const rules = new AccessRulesService(store);
  goodsService.addBatch(source.goodsId, { deviceCode: device.deviceCode, quantity: 5,
    expiresAt: "2100-01-01T00:00:00.000Z", confirmed: true });
  const now = new Date().toISOString();
  const event: CabinetEventRecord = {
    eventId: "merge-event", orderNo: "merge-order", userId: user.id, phone: user.phone,
    role: "special", deviceCode: device.deviceCode, doorNum: "1", status: "settled",
    createdAt: now, updatedAt: now, amount: 500, paymentNotifyStatus: "success",
    paymentTransactionId: "merge-payment", goods: [{ goodsId: source.goodsId,
      goodsName: source.name, category: source.category, quantity: 1, unitPrice: 500 }]
  };
  return { store, device, user, source, remote, goodsService, devices, orders, rules, event };
};

test("平台已有同名货品时手工新增复用原条目，不覆盖平台价格和编号", () => {
  const h = harness();
  const before = h.store.goodsCatalog.length;
  const created = h.goodsService.createCatalogItem({ goodsCode: "another-code", name: ` ${h.source.name} `,
    price: 12, category: "daily", imageUrl: "" });
  assert.equal(created.goodsId, h.source.goodsId);
  assert.notEqual(created.goodsCode, "another-code");
  assert.equal(h.store.goodsCatalog.length, before);
});

test("平台同步归并手工库存和已用额度，原始订单及回调重放保持有效，重启不恢复重复商品", async () => {
  const h = harness();
  h.store.events.push(h.event);
  const pool = h.rules.getQuotaSummaryForUser(h.user).remainingPools![0]!;
  const payload = { orderNo: h.event.orderNo, eventId: h.event.eventId, phone: h.event.phone,
    deviceCode: h.device.deviceCode, amount: 500, notifyUrl: "http://127.0.0.1/test",
    detail: h.event.goods };
  h.orders.recordSettlement(h.event, payload, { quotaItems: [{ goodsId: h.source.goodsId, freeQuantity: 1,
    entitlementAllocations: [{ ...pool, goodsId: h.source.goodsId, quantity: 1 }] }] });
  const originalEvent = structuredClone(h.event);
  const remainingBefore = h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal;
  assert.equal(remainingBefore, 1);
  await h.goodsService.syncDeviceGoods(h.device.deviceCode);
  assert.equal(h.source.status, "inactive");
  assert.equal(h.source.mergedIntoGoodsId, h.remote.goodsId);
  assert.equal(h.store.getCurrentStock(h.device.deviceCode, h.remote.goodsId), 4);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, remainingBefore);
  assert.equal(h.user.accessPolicies![0]!.entitlementLimits![0]!.targetId, h.remote.goodsId);
  assert.deepEqual(h.event, originalEvent, "保存平台原始订单身份，便于迟到回调核验");
  const canonical = h.store.goodsCatalog.find((g) => g.goodsId === h.remote.goodsId)!;
  assert.equal(canonical.taxonomyNodeId, h.source.taxonomyNodeId);
  assert.equal(canonical.category, h.source.category);
  assert.equal(h.orders.recordSettlement(h.event, payload).duplicated, true);
  const batchesBeforeReplay = structuredClone(h.store.goodsBatches);
  await h.goodsService.syncDeviceGoods(h.device.deviceCode);
  assert.deepEqual(h.store.goodsBatches, batchesBeforeReplay);
  assert.equal(h.goodsService.listCatalog().filter((g) => g.name === h.source.name).length, 1);
  assert.deepEqual(validatePersistedState(h.store.snapshot()).errors, []);
  h.store.persist();
  const reloaded = new InMemoryStoreService();
  assert.equal(reloaded.resolveGoodsId(h.source.goodsId), h.remote.goodsId);
  assert.equal(reloaded.getCurrentStock(h.device.deviceCode, h.remote.goodsId), 4);

  const refunded = h.orders.markRefund(h.event.orderNo, "merge-payment", 500, {
    source: "manual", refundNo: "merge-refund", deviceCode: h.device.deviceCode });
  assert.equal(refunded.movements[0]!.goodsId, h.remote.goodsId);
  assert.equal(refunded.movements[0]!.quotaQuantity, 1);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 2);
  h.store.inventory.reverse();
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 2, "退款释放额度不依赖流水存储顺序");
  h.orders.markRefund(h.event.orderNo, "merge-payment", 500, {
    source: "callback", refundNo: "merge-refund", deviceCode: h.device.deviceCode });
  assert.equal(h.store.inventory.filter((m) => m.type === "refund").length, 1);
});

test("同名货品尚在开柜中时同步拒绝合并且不改变库存、配置或订单", async () => {
  const h = harness();
  h.event.status = "opened";
  h.store.events.push(h.event);
  const before = structuredClone(h.store.snapshot());
  await assert.rejects(h.goodsService.syncDeviceGoods(h.device.deviceCode), /未结算的开柜/);
  assert.deepEqual(h.store.snapshot(), before);
});

test("当天更换领取规则后旧池的真实领取仍扣额度，随后退款按原身份释放", () => {
  const h = harness();
  h.store.events.push(h.event);
  const pool = h.rules.getQuotaSummaryForUser(h.user).remainingPools![0]!;
  h.orders.recordSettlement(h.event, { orderNo: h.event.orderNo, eventId: h.event.eventId,
    phone: h.event.phone, deviceCode: h.device.deviceCode, amount: 500,
    notifyUrl: "http://127.0.0.1/test", detail: h.event.goods }, {
    quotaItems: [{ goodsId: h.source.goodsId, freeQuantity: 1,
      entitlementAllocations: [{ ...pool, goodsId: h.source.goodsId, quantity: 1 }] }]
  });
  h.user.accessPolicies![0]!.id = "replacement-policy";
  h.user.accessPolicies![0]!.entitlementLimits![0]!.quantity = 1;
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
  h.orders.markRefund(h.event.orderNo, "merge-payment", 500, {
    source: "manual", refundNo: "replacement-refund", deviceCode: h.device.deviceCode });
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 1);
});

test("清理错误重复批次后归并只保留平台原库存，平台重复返回别名也只显示一次", async () => {
  const h = harness();
  h.store.ensureGoodsCatalogItem(h.remote);
  h.goodsService.addBatch(h.remote.goodsId, { deviceCode: h.device.deviceCode, quantity: 20,
    expiresAt: "2100-01-01T00:00:00.000Z", confirmed: true });
  const wrong = h.store.goodsBatches.find((batch) => batch.goodsId === h.source.goodsId)!;
  h.goodsService.removeBatch(wrong.batchId, { quantity: wrong.remainingQuantity,
    confirmed: true, note: "用户确认手工条目重复，保留平台商品" });
  await h.goodsService.syncDeviceGoods(h.device.deviceCode);
  assert.equal(h.store.getCurrentStock(h.device.deviceCode, h.remote.goodsId), 20);
  assert.equal(wrong.remainingQuantity, 0);
  assert.equal(h.device.doors.flatMap((d) => d.goods).filter((g) => g.name === h.source.name).length, 1);
  const devices = new DevicesService(h.store, new InventoryBatchChangesService(h.store), {
    getGoodsInfo: async () => [h.source, h.remote]
  } as never);
  const visible = await devices.getGoods(h.device.deviceCode);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.goodsId, h.remote.goodsId);
  assert.equal(visible[0]!.stock, 20);
  assert.equal(visible[0]!.price, h.remote.price);
  assert.deepEqual(validatePersistedState(h.store.snapshot()).errors, []);
  h.source.mergedIntoGoodsId = h.source.goodsId;
  assert.ok(validatePersistedState(h.store.snapshot()).errors.some((e) => e.includes("mergedIntoGoodsId")));
});
