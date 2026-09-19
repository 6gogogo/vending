import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigService } from "@nestjs/config";
import type { CabinetEventRecord, SmartVmPaymentPayload } from "@vm/shared-types";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";
import { ManualSettlementRecoveryService } from "../src/modules/cabinet-events/manual-settlement-recovery.service";
import { validatePersistedState } from "../src/common/store/persisted-state-integrity";
import { readFileSync } from "node:fs";

const withHarness = async (run: (h: ReturnType<typeof harness>) => Promise<void>) => {
  const path = mkdtempSync(join(tmpdir(), "vm-empty-pickup-"));
  const previous = process.env.API_DATA_FILE;
  process.env.API_DATA_FILE = join(path, "store.json");
  try { await run(harness()); } finally {
    if (previous === undefined) delete process.env.API_DATA_FILE;
    else process.env.API_DATA_FILE = previous;
    rmSync(path, { recursive: true, force: true });
  }
};
const harness = () => {
  const store = new InMemoryStoreService();
  const config = new ConfigService({ SMARTVM_CALLBACK_MAX_AGE_SECONDS: "300" });
  const notifications: SmartVmPaymentPayload[] = [];
  let fail = false;
  const gateway = {
    verifySignedPayload: () => true, isUsingMockTransport: () => false,
    notifyPaymentSuccess: async (payload: SmartVmPaymentPayload) => {
      notifications.push(payload);
      if (fail) throw new Error("平台暂时不可用");
      return {};
    },
    extractErrorMessage: (error: Error) => error.message,
    extractExchangeTrace: () => undefined
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
  const user = store.users.find((entry) => entry.role === "special")!;
  store.events.splice(0);
  const event: CabinetEventRecord = {
    eventId: "empty-event", orderNo: "empty-order", userId: user.id, phone: user.phone,
    role: "special", deviceCode: device.deviceCode, doorNum: "1", status: "closed",
    physicalDoorState: "closed", reservationOnlyPickup: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), amount: 0,
    goods: [], intentItems: [{ goodsId: goods.goodsId, goodsName: goods.name,
      category: goods.category, quantity: 1 }]
  };
  store.events.push(event);
  const payload = { eventId: event.eventId, orderNo: event.orderNo, phone: user.phone,
    deviceCode: device.deviceCode, amount: 0, detail: [],
    notifyUrl: "http://127.0.0.1/empty-pickup-notify", clientId: "test-client",
    nonceStr: "empty-nonce", timestamp: Math.floor(Date.now() / 1000), sign: "verified" };
  return { store, service, reservations, event, payload, notifications, setFail: (value: boolean) => { fail = value; } };
};

test("选一件但实际空取货自动零元上报，库存额度不变，重放不重复结算", async () => withHarness(async (h) => {
  const before = structuredClone({ inventory: h.store.inventory, batches: h.store.goodsBatches });
  const first = await h.service.handleSettlement(h.payload);
  const duplicate = await h.service.handleSettlement({ ...h.payload, nonceStr: "empty-replay" });
  assert.equal(first.duplicated, false);
  assert.equal(duplicate.duplicated, true);
  assert.equal(h.event.billingStatus, "free");
  assert.equal(h.event.paymentNotifyStatus, "success");
  assert.equal(h.event.settlementComparison?.matched, false);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0]!.amount, 0);
  assert.deepEqual({ inventory: h.store.inventory, batches: h.store.goodsBatches }, before);
  assert.equal(h.reservations.findBlockingBillingEvent(h.event.userId), undefined);
  assert.equal(h.store.alerts.some((alert) => alert.relatedEventId === h.event.eventId), false);
}));

test("空取货回写失败不阻断用户，重试复用交易号且成功后幂等", async () => withHarness(async (h) => {
  h.setFail(true);
  await h.service.handleSettlement(h.payload);
  assert.equal(h.event.paymentNotifyStatus, "failed");
  assert.equal(h.reservations.findBlockingBillingEvent(h.event.userId), undefined);
  h.setFail(false);
  await h.service.completeEmptyPickup(h.event.eventId);
  await h.service.completeEmptyPickup(h.event.eventId);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[0]!.transactionId, h.notifications[1]!.transactionId);
}));

test("历史空取货解除差异任务，非零金额或未结算事件仍拒绝自动处理", async () => withHarness(async (h) => {
  await h.service.handleSettlement(h.payload);
  h.event.billingStatus = "mismatch";
  h.event.paymentNotifyStatus = "pending";
  delete h.event.billingResolvedAt;
  new AlertsService(h.store).create({ type: "callback", title: "实际领取与用户选择不一致",
    detail: "少领一件", deviceCode: h.event.deviceCode, relatedEventId: h.event.eventId,
    dueAt: new Date().toISOString() });
  await h.service.completeEmptyPickup(h.event.eventId);
  assert.equal(h.event.billingStatus, "free");
  assert.equal(h.store.alerts.find((alert) => alert.relatedEventId === h.event.eventId)?.status, "resolved");
  h.event.platformAmount = 1;
  await assert.rejects(h.service.completeEmptyPickup(h.event.eventId), /仅允许完成/);
  h.event.platformAmount = 0;
  h.event.status = "closed";
  await assert.rejects(h.service.completeEmptyPickup(h.event.eventId), /仅允许完成/);
}));

test("已关门且回调超时的空取货可据现场事实补记，持久化与迟到回调均不产生领取流水", async () => withHarness(async (h) => {
  const closedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  h.event.createdAt = new Date(Date.now() - 15 * 60_000).toISOString();
  h.store.callbackLog.unshift({ id: "closed-evidence", type: "door-status", receivedAt: closedAt,
    payload: { eventId: h.event.eventId, deviceCode: h.event.deviceCode, status: "CLOSED" } });
  const recovery = new ManualSettlementRecoveryService(h.store,
    new InventoryBatchChangesService(h.store), new AlertsService(h.store));
  const actor = { id: "system-maintenance", tenantId: h.store.getDefaultTenantId() };
  const before = structuredClone({ inventory: h.store.inventory, batches: h.store.goodsBatches });
  const payload = { items: [], confirmed: true, reason: "现场确认未取走任何商品。" };
  const record = recovery.create(h.event.eventId, payload, actor);
  assert.deepEqual(record.movementIds, []);
  assert.equal(recovery.create(h.event.eventId, payload, actor).id, record.id);
  h.store.persist();
  assert.deepEqual(validatePersistedState(JSON.parse(readFileSync(process.env.API_DATA_FILE!, "utf8"))).errors, []);
  const callback = h.store.logCallback("settlement", h.payload);
  const result = recovery.recordLateCallback(h.event, h.payload, callback);
  assert.equal(result?.matched, true);
  h.store.persist();
  assert.deepEqual(validatePersistedState(JSON.parse(readFileSync(process.env.API_DATA_FILE!, "utf8"))).errors, []);
  assert.deepEqual({ inventory: h.store.inventory, batches: h.store.goodsBatches }, before);
}));

test("零元补发按分钟退避并复用交易号，成功后停止重试", async () => withHarness(async (h) => {
  h.setFail(true);
  await h.service.handleSettlement(h.payload);
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 1, completed: 0 });
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 0, completed: 0 });
  h.setFail(false);
  h.event.zeroCostCompletionAttemptedAt = new Date(Date.now() - 61_000).toISOString();
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 1, completed: 1 });
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 0, completed: 0 });
  assert.equal(new Set(h.notifications.map((entry) => entry.transactionId)).size, 1);
}));

test("历史零元空取货无需意向明细也可补完，但未收到结算与非零订单不自动处理", async () => withHarness(async (h) => {
  h.event.status = "settled";
  h.event.platformAmount = 0;
  h.event.billingStatus = "mismatch";
  h.event.paymentNotifyStatus = "pending";
  h.event.paymentNotifyUrl = h.payload.notifyUrl;
  delete h.event.reservationOnlyPickup;
  delete h.event.intentItems;
  const unknown = { ...h.event, eventId: "unknown", orderNo: "unknown", platformAmount: undefined,
    status: "closed" as const };
  const charged = { ...h.event, eventId: "charged", orderNo: "charged", amount: 1, platformAmount: 1 };
  h.store.events.push(unknown, charged);
  assert.deepEqual(await h.service.completePendingZeroCostOrders(), { attempted: 1, completed: 1 });
  assert.equal(h.event.billingStatus, "free");
  assert.equal(h.reservations.findBlockingBillingEvent(h.event.userId)?.eventId, "unknown");
  assert.equal(h.notifications.length, 1);
  assert.equal(unknown.billingStatus, "mismatch");
  assert.equal(charged.paymentNotifyStatus, "pending");
}));
