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
  let failNotification = false;
  let opens = 0;
  const gateway = {
    openDoor: async () => ({ orderNo: `actual-order-${++opens}` }),
    verifySignedPayload: () => true, isUsingMockTransport: () => false,
    notifyPaymentSuccess: async (payload: SmartVmPaymentPayload) => {
      notifications.push(payload);
      if (failNotification) throw new Error("平台暂不可用");
      return {};
    },
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
    notifications, config, opens: () => opens, setFailNotification: (value: boolean) => { failNotification = value; } };
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
  assert.throws(() => h.service.previewOpenSettlement(h.request, h.actor), /开门权益今日已用完/);
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

test("平台漏返的本地商品查询、预约占用、取消及实际领取使用同一库存与额度", async () => withHarness(async (h) => {
  const devices = new DevicesService(h.store, new InventoryBatchChangesService(h.store), {
    getGoodsInfo: async () => [{ ...h.goods, goodsId: "platform-other", name: "平台另一个商品" }]
  } as never);
  const visibleStock = async () => (await devices.getGoods(h.device.deviceCode, "1", "special"))
    .find((goods) => goods.goodsId === h.goods.goodsId)?.stock;
  const stock = h.store.getReservableStock(h.device.deviceCode, h.goods.goodsId);
  assert.equal(await visibleStock(), stock);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).receivableByGoods?.[h.goods.goodsId], 1);

  const reservation = h.reservations.create({ deviceCode: h.device.deviceCode, doorNum: "1",
    intentItems: [{ goodsId: h.goods.goodsId, goodsName: h.goods.name, category: h.goods.category, quantity: 1 }] }, h.actor);
  assert.equal(await visibleStock(), stock - 1);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
  h.reservations.cancel(reservation.id, h.actor);
  assert.equal(await visibleStock(), stock);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 1);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).dailyPickup?.remaining, 1);
  assert.doesNotThrow(() => h.service.previewOpenSettlement(h.request, h.actor));

  await h.service.openCabinet(h.request, h.actor);
  const { event } = await h.settle(1);
  assert.equal(event.billingStatus, "free");
  assert.equal(event.paymentNotifyStatus, "success");
  assert.equal(await visibleStock(), stock - 1);
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
}));

test("领取权益按实际领取次数限制，商品额度有剩余也不能当天再次开门", async () => withHarness(async (h) => {
  h.user.accessPolicies![0]!.entitlementLimits![0]!.quantity = 3;
  await h.service.openCabinet(h.request, h.actor);
  await h.settle(1);
  const quota = h.rules.getQuotaSummaryForUser(h.user);
  assert.equal(quota.remainingFreeTotal, 2);
  assert.equal(quota.dailyPickup?.used, 1);
  assert.equal(quota.dailyPickup?.remaining, 0);
  assert.throws(() => h.service.previewOpenSettlement(h.request, h.actor), /开门权益今日已用完/);
  await assert.rejects(h.service.openCabinet(h.request, h.actor), /开门权益今日已用完/);
  assert.equal(h.opens(), 1);
  const pickup = h.store.inventory.find((entry) => entry.userId === h.user.id && entry.type === "pickup")!;
  h.store.inventory.push({ ...pickup, id: "returned", type: "refund" });
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).dailyPickup?.remaining, 1);
}));

test("旧版预选差异按实际物资入账并零元完结，回调重放不重复扣库存或外呼", async () => withHarness(async (h) => {
  await h.service.openCabinet(h.request, h.actor);
  const event = h.store.events[0]!;
  event.pickupMode = undefined;
  event.reservationOnlyPickup = true;
  event.intentItems = [{ goodsId: h.goods.goodsId, goodsName: h.goods.name, category: h.goods.category, quantity: 2 }];
  const stock = h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId);
  await h.settle(1);
  assert.equal(event.settlementComparison?.matched, false);
  assert.equal(event.billingStatus, "free");
  assert.equal(event.paymentNotifyStatus, "success");
  assert.equal(h.notifications[0]?.amount, 0);
  assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), stock - 1);
  assert.equal(h.store.paymentOrders.length, 0);
  const inventory = structuredClone(h.store.inventory);
  await h.settle(1);
  assert.deepEqual(h.store.inventory, inventory);
  assert.equal(h.notifications.length, 1);
}));

test("历史已入账的零元差异自动补完，失败退避且复用交易号，不触碰缺少结算的订单", async () => withHarness(async (h) => {
  await h.service.openCabinet(h.request, h.actor);
  h.setFailNotification(true);
  const { event } = await h.settle(1);
  event.pickupMode = undefined;
  event.reservationOnlyPickup = true;
  event.billingStatus = "mismatch";
  event.paymentNotifyStatus = "pending";
  h.store.events.push({ ...structuredClone(event), eventId: "unknown", orderNo: "unknown", platformAmount: undefined,
    paymentTransactionId: undefined });
  const inventory = structuredClone(h.store.inventory);
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 1, completed: 0 });
  assert.equal(event.billingStatus, "free");
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 0, completed: 0 });
  event.zeroCostCompletionAttemptedAt = new Date(Date.now() - 61_000).toISOString();
  h.setFailNotification(false);
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 1, completed: 1 });
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 0, completed: 0 });
  assert.equal(new Set(h.notifications.map((item) => item.transactionId)).size, 1);
  assert.deepEqual(h.store.inventory, inventory);
  assert.equal(h.store.events.find((item) => item.eventId === "unknown")?.paymentNotifyStatus, "pending");
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

test("平台补充的实际商品及时扣库存并零元完结，失败后按同一交易号补发", async () => withHarness(async (h) => {
  await h.service.openCabinet(h.request, h.actor);
  const { event } = await h.settle(1);
  const stock = h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId);
  h.setFailNotification(true);
  const payload = { orgOrderNo: event.orderNo, orderNo: "actual-extra", eventId: event.eventId,
    phone: h.user.phone, deviceCode: h.device.deviceCode, amount: 100,
    detail: [{ goodsId: h.goods.goodsId, goodsName: h.goods.name, quantity: 1, unitPrice: 100 }],
    noticeUrl: "http://127.0.0.1/actual-extra", clientId: "test", nonceStr: "actual-extra",
    timestamp: Math.floor(Date.now() / 1000), sign: "verified" };
  await h.service.handleAdjustment(payload);
  assert.equal(event.billingStatus, "free");
  assert.equal(event.adjustments?.[0]?.paymentNotifyStatus, "failed");
  assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), stock - 1);
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 0, completed: 0 });
  h.setFailNotification(false);
  event.adjustments![0]!.zeroCostCompletionAttemptedAt = new Date(Date.now() - 61_000).toISOString();
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 1, completed: 1 });
  await h.service.handleAdjustment(payload);
  assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), stock - 1);
  const attempts = h.notifications.filter((item) => item.orderNo === payload.orderNo);
  assert.equal(attempts.length, 2);
  assert.equal(new Set(attempts.map((item) => item.transactionId)).size, 1);
  assert.ok(attempts.every((item) => item.amount === 0));
  assert.equal(h.store.paymentOrders.length, 0);
}));

for (const [label, expiresAt] of [
  ["登记已到期", "2000-01-01T00:00:00.000Z"],
  ["未设保质期", undefined]
] as const) {
test(`保质期仅提醒时${label}批次贯通查询、预约、预结算、实际领取及库存扣减`, async () => withHarness(async (h) => {
  const previous = process.env.VM_GOODS_EXPIRY_MODE;
  process.env.VM_GOODS_EXPIRY_MODE = "warning_only";
  try {
    h.store.goodsBatches.splice(0);
    const batches = new InventoryBatchChangesService(h.store);
    const batch = batches.recordBatchOnly({ deviceCode: h.device.deviceCode, goodsId: h.goods.goodsId,
      quantity: 5, expiresAt, sourceType: "system" }).createdBatches[0]!;
    const devices = new DevicesService(h.store, batches, { getGoodsInfo: async () => [] } as never);
    const visible = (await devices.getGoods(h.device.deviceCode, "1", "special")).find((goods) => goods.goodsId === h.goods.goodsId)!;
    assert.equal(visible.stock, 5);
    assert.equal(visible.expiresAt, undefined, "未核实的登记日期只在后台提醒");
    const detail = devices.monitoringDetail(h.device.deviceCode);
    assert.equal(detail.goodsExpiryMode, "warning_only");
    assert.equal(detail.device.doors[0]!.goods.find((goods) => goods.goodsId === h.goods.goodsId)?.expiresAt, expiresAt);
    const intentItems = [{ goodsId: h.goods.goodsId, goodsName: h.goods.name, category: h.goods.category, quantity: 1 }];
    const reservation = h.reservations.create({ deviceCode: h.device.deviceCode, doorNum: "1", intentItems }, h.actor);
    const preview = h.service.previewOpenSettlement({ ...h.request, pickupMode: undefined, reservationId: reservation.id, intentItems }, h.actor);
    assert.ok(preview.quoteId);
    h.reservations.cancel(reservation.id, h.actor);
    await h.service.openCabinet(h.request, h.actor);
    await h.settle(1);
    assert.equal(batch.remainingQuantity, 4);
    assert.equal(h.store.getAvailableStock(h.device.deviceCode, h.goods.goodsId), 4);
    assert.equal(h.store.goodsBatches.some((batch) => batch.remainingQuantity < 0), false);
    assert.equal(h.rules.getQuotaSummaryForUser(h.user).remainingFreeTotal, 0);
    assert.equal(batch.expiresAt, expiresAt);
  } finally {
    if (previous === undefined) delete process.env.VM_GOODS_EXPIRY_MODE;
    else process.env.VM_GOODS_EXPIRY_MODE = previous;
  }
}));
}

test("停用货品即使仍有库存也不能从旧客户端预约或预选开柜，恢复启用后按原额度领取", async () => withHarness(async (h) => {
  h.config.set("VM_RESERVATION_ONLY_PICKUP", "false");
  const catalog = h.store.goodsCatalog.find((goods) => goods.goodsId === h.goods.goodsId)!;
  catalog.status = "inactive";
  const intentItems = [{ goodsId: h.goods.goodsId, goodsName: h.goods.name, category: h.goods.category, quantity: 1 }];
  const beforeStock = h.store.getCurrentStock(h.device.deviceCode, h.goods.goodsId);
  assert.throws(() => h.reservations.create({ deviceCode: h.device.deviceCode, doorNum: "1", intentItems }, h.actor), /已停用/);
  const request = { ...h.request, pickupMode: undefined, intentItems };
  assert.throws(() => h.service.previewOpenSettlement(request, h.actor), /已停用/);
  await assert.rejects(h.service.openCabinet(request, h.actor), /已停用/);
  assert.equal(h.opens(), 0);
  assert.equal(h.store.getCurrentStock(h.device.deviceCode, h.goods.goodsId), beforeStock);
  assert.equal(h.store.reservations.length, 0);

  catalog.status = "active";
  assert.equal(h.rules.getQuotaSummaryForUser(h.user).receivableByGoods?.[h.goods.goodsId], 1);
  const reservation = h.reservations.create({ deviceCode: h.device.deviceCode, doorNum: "1", intentItems }, h.actor);
  assert.equal(reservation.status, "active");
}));
