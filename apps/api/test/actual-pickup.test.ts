import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigService } from "@nestjs/config";
import type { CabinetOpenRequest, SmartVmPaymentPayload } from "@vm/shared-types";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { parseCabinetOpenRequest } from "../src/common/validation/cabinet-operation-input";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import type { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";
import { GoodsTaxonomyService } from "../src/modules/goods/goods-taxonomy.service";

const harness = () => {
  const store = new InMemoryStoreService();
  store.events.splice(0);
  store.reservations.splice(0);
  store.specialAccessPolicies.splice(0);
  const config = new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "true", SMARTVM_CALLBACK_MAX_AGE_SECONDS: "300" });
  const notifications: SmartVmPaymentPayload[] = [];
  let opens = 0;
  const gateway = {
    openDoor: async () => ({ orderNo: `actual-order-${++opens}` }),
    verifySignedPayload: () => true, isUsingMockTransport: () => false,
    notifyPaymentSuccess: async (payload: SmartVmPaymentPayload) => { notifications.push(payload); return {}; },
    extractErrorMessage: (error: Error) => error.message, extractExchangeTrace: () => undefined
  } as unknown as SmartVmGateway;
  const batches = new InventoryBatchChangesService(store);
  const alerts = new AlertsService(store);
  const devices = new DevicesService(store, batches, gateway);
  const inventory = new InventoryOrdersService(store, batches, devices, alerts, config);
  const rules = new AccessRulesService(store);
  const reservations = new ReservationsService(store, rules, config);
  const service = new CabinetEventsService(store, rules, gateway, inventory, alerts, reservations, config);
  const device = store.devices[0]!;
  const goods = device.doors[0]!.goods[0]!;
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active")!;
  const root = new GoodsTaxonomyService(store).createNode({ name: "任意", parentId: null }, undefined, store.getDefaultTenantId());
  assert.ok(root);
  for (const item of store.goodsCatalog) item.taxonomyNodeId = root.id;
  user.accessPolicies = [{ id: "actual-daily-one", name: "任意一件", weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0, endHour: 24, goodsLimits: [], status: "active",
    entitlementLimits: [{ id: "actual-any", targetType: "taxonomy_node", targetId: root.id, quantity: 1 }] }];
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  batches.recordBatchOnly({ deviceCode: device.deviceCode, goodsId: goods.goodsId, quantity: 5, sourceType: "system" });
  const request: CabinetOpenRequest = { phone: user.phone, deviceCode: device.deviceCode,
    doorNum: "1", openMode: "scan", pickupMode: "actual" };
  const actor = { id: user.id, role: "special" as const };
  const settle = async (quantity: number) => {
    const event = store.events[0]!;
    // 模拟可信关门状态；不调用真实柜机。
    event.physicalDoorState = "closed";
    const result = await service.handleSettlement({ eventId: event.eventId, orderNo: event.orderNo,
      phone: user.phone, deviceCode: device.deviceCode, amount: quantity * 100,
      detail: quantity ? [{ goodsId: goods.goodsId, goodsName: goods.name, quantity, unitPrice: 100 }] : [],
      notifyUrl: "http://127.0.0.1/actual-notify", clientId: "test", nonceStr: `actual-${quantity}`,
      timestamp: Math.floor(Date.now() / 1000), sign: "verified" });
    return { event, result };
  };
  return { store, service, rules, reservations, device, goods, user, request, actor, settle,
    notifications, opens: () => opens };
};
const withHarness = async (run: (h: ReturnType<typeof harness>) => Promise<void>) => {
  const path = mkdtempSync(join(tmpdir(), "vm-actual-pickup-"));
  const previous = process.env.API_DATA_FILE;
  process.env.API_DATA_FILE = join(path, "store.json");
  try { await run(harness()); } finally {
    if (previous === undefined) delete process.env.API_DATA_FILE; else process.env.API_DATA_FILE = previous;
    rmSync(path, { recursive: true, force: true });
  }
};

test("无需预约或选品即可开门，重放同一令牌只开一次，实际领取扣库存与共享额度", async () => withHarness(async (h) => {
  const stock = h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId);
  const preview = h.service.previewOpenSettlement(h.request, h.actor);
  assert.ok(preview.quoteId);
  const request = { ...h.request, quoteId: preview.quoteId };
  const opened = await h.service.openCabinet(request, h.actor);
  assert.equal((await h.service.openCabinet(request, h.actor)).eventId, opened.eventId);
  assert.equal(h.opens(), 1);
  assert.equal(h.store.reservations.length, 0);
  const { event } = await h.settle(1);
  assert.deepEqual(event.intentItems, []);
  assert.equal(event.pickupMode, "actual");
  assert.equal(event.billingStatus, "free");
  assert.equal(event.paymentNotifyStatus, "success");
  assert.equal(event.settlementComparison?.matched, true);
  assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), stock - 1);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
  assert.equal(h.notifications[0]?.amount, 0);
  assert.equal(h.reservations.findBlockingBillingEvent(h.user.id), undefined);
  assert.throws(() => h.service.previewOpenSettlement(h.request, h.actor), /额度已用完/);
}));

test("空取货自动完结，库存和任意一件额度均保持不变", async () => withHarness(async (h) => {
  const stock = h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId);
  await h.service.openCabinet(h.request, h.actor);
  const { event } = await h.settle(0);
  assert.equal(event.paymentNotifyStatus, "success");
  assert.equal(event.billingStatus, "free");
  assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), stock);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 1);
  assert.equal(h.reservations.findBlockingBillingEvent(h.user.id), undefined);
}));

test("实际拿走数量完整入账，不因未预选商品生成差异核对任务", async () => withHarness(async (h) => {
  const stock = h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId);
  await h.service.openCabinet(h.request, h.actor);
  const { event } = await h.settle(2);
  assert.equal(event.goods[0]?.quantity, 2);
  assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), stock - 2);
  assert.equal(event.billingStatus, "free");
  assert.equal(event.paymentNotifyStatus, "success");
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
  assert.equal(h.reservations.findBlockingBillingEvent(h.user.id), undefined);
}));

test("旧预约锁定的额度不拦截实际领取，旧版请求仍保留兼容校验", async () => withHarness(async (h) => {
  const now = new Date().toISOString();
  const quota = h.rules.getQuotaSummaryForUser(h.user);
  const pool = quota.remainingPools![0]!;
  h.store.reservations.push({ id: "legacy-reservation", userId: h.user.id, phone: h.user.phone,
    userName: h.user.name, deviceCode: h.device.deviceCode, doorNum: "1", status: "active",
    inventoryReservationMode: "goods_quantity", batchAllocationTiming: "on_open",
    reservedAt: now, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    items: [{ goodsId: h.goods.goodsId, goodsName: h.goods.name, category: h.goods.category, quantity: 1 }],
    entitlementAllocations: [{ ...pool, goodsId: h.goods.goodsId, quantity: 1 }] });
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
  assert.throws(() => h.service.previewOpenSettlement({ ...h.request, pickupMode: undefined }, h.actor), /先预约/);
  await h.service.openCabinet(h.request, h.actor);
  await h.settle(0);
  assert.equal(h.store.reservations[0]?.status, "fulfilled");
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 1);
}));

test("实际领取模式不能绕过身份、领取时段或非法模式校验", async () => withHarness(async (h) => {
  assert.equal(parseCabinetOpenRequest(h.request).pickupMode, "actual");
  assert.throws(() => parseCabinetOpenRequest({ ...h.request, pickupMode: "anything" }));
  assert.throws(() => h.service.previewOpenSettlement(h.request, { id: "other-user", role: "special" }));
  h.user.accessPolicies = [];
  assert.throws(() => h.service.previewOpenSettlement(h.request, h.actor), /时间段/);
  assert.equal(h.opens(), 0);
}));
