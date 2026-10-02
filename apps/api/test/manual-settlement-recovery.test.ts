import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NestFactory } from "@nestjs/core";
import type { CabinetEventRecord } from "@vm/shared-types";

import { AppModule } from "../src/app.module";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { PersistedStateWriteError } from "../src/common/store/persistence";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { SettlementRecoveryService } from "../src/modules/cabinet-events/settlement-recovery.service";
import { GoodsService } from "../src/modules/goods/goods.service";
import { SpecialAccessPoliciesService } from "../src/modules/special-access-policies/special-access-policies.service";
import { getActiveWindowEntitlementQuota } from "../src/common/policies/special-access-policy.utils";
import { validatePersistedState } from "../src/common/store/persisted-state-integrity";
import { listenOnFetchSafeLoopbackPort } from "./support/fetch-safe-api-listener";

const withApi = async (
  run: (context: {
    baseUrl: string;
    store: InMemoryStoreService;
    inventoryBatchChanges: InventoryBatchChangesService;
    alertsService: AlertsService;
    devicesService: DevicesService;
    smartVmGateway: SmartVmGateway;
    inventoryOrdersService: InventoryOrdersService;
    accessRulesService: AccessRulesService;
    cabinetEvents: CabinetEventsService;
    goodsService: GoodsService;
    token: string;
  }) => Promise<void>
) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-manual-settlement-"));
  const originalDataFile = process.env.API_DATA_FILE;
  const originalBootstrap = process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  const port = await listenOnFetchSafeLoopbackPort(app);

  try {
    const store = app.get(InMemoryStoreService);
    const credential = store.backofficeCredentials.find(
      (entry) => entry.role === "admin" && entry.tenantId === store.getDefaultTenantId()
    );
    const actor = store.users.find(
      (entry) => entry.id === credential?.userId && entry.status === "active"
    );
    assert.ok(credential);
    assert.ok(actor);
    credential.permissions = ["devices:operate", "goods:stock-adjust"];
    const token = store.createBackofficeSession(actor, "admin", credential.tenantId);

    await run({
      baseUrl: `http://127.0.0.1:${port}/api`,
      store,
      inventoryBatchChanges: app.get(InventoryBatchChangesService),
      alertsService: app.get(AlertsService),
      devicesService: app.get(DevicesService),
      smartVmGateway: app.get(SmartVmGateway),
      inventoryOrdersService: app.get(InventoryOrdersService),
      accessRulesService: app.get(AccessRulesService),
      cabinetEvents: app.get(CabinetEventsService),
      goodsService: app.get(GoodsService),
      token
    });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    if (originalDataFile === undefined) {
      delete process.env.API_DATA_FILE;
    } else {
      process.env.API_DATA_FILE = originalDataFile;
    }
    if (originalBootstrap === undefined) {
      delete process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
    } else {
      process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = originalBootstrap;
    }
  }
};

const appendClosedSpecialEvent = (store: InMemoryStoreService, closedMinutes = 11) => {
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const device = store.devices.find(
    (entry) => store.getDeviceTenantId(entry) === store.getDefaultTenantId()
  );
  assert.ok(user);
  assert.ok(device);

  const closedAt = new Date(Date.now() - closedMinutes * 60_000).toISOString();
  const event: CabinetEventRecord = {
    eventId: "event-manual-settlement-candidate",
    orderNo: "order-manual-settlement-candidate",
    userId: user.id,
    phone: user.phone,
    role: "special",
    deviceCode: device.deviceCode,
    doorNum: "1",
    status: "closed",
    physicalDoorState: "closed",
    createdAt: new Date(Date.now() - (closedMinutes + 4) * 60_000).toISOString(),
    updatedAt: closedAt,
    amount: 0,
    billingStatus: "pending",
    intentItems: [],
    goods: []
  };
  store.events.unshift(event);
  store.callbackLog.unshift({
    id: "callback-manual-settlement-closed",
    type: "door-status",
    receivedAt: closedAt,
    payload: {
      eventId: event.eventId,
      deviceCode: event.deviceCode,
      status: "CLOSED"
    }
  });

  return { event, user, device, closedAt };
};

test("网络故障遗留意图须有后续同门可信关门；处理幂等且不生成库存或付款", async () => {
  await withApi(async ({ baseUrl, store, token, alertsService }) => {
    const { event, device } = appendClosedSpecialEvent(store);
    event.status = "timeout_unopened"; event.physicalDoorState = "unknown";
    event.orderNo = `pending-${event.eventId}`;
    store.callbackLog.splice(0, 1);
    store.logOperation({ category: "device", type: "open-cabinet", status: "pending", description: "模拟网络故障",
      relatedEventId: event.eventId, actor: { type: "system", name: "测试" },
      metadata: { smartVmExchange: { responseBody: { reason: "network_error" } } } });
    store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });
    const before = JSON.stringify([store.inventory, store.paymentOrders]);
    const submit = (eventIds = [event.eventId]) => fetch(`${baseUrl}/devices/${device.deviceCode}/confirm-door-closed`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ evidence: "later-platform-close", eventIds, reason: "核对故障后的真实关门回调，关闭遗留记录。" })
    });
    assert.equal((await submit()).status, 409, "没有后续真实回调时不能凭在线标记确认");
    const later = { ...structuredClone(event), eventId: "later-real-event", orderNo: "later-real-order", status: "closed" as const, physicalDoorState: "closed" as const };
    store.events.unshift(later);
    store.logCallback("door-status", { eventId: later.eventId, deviceCode: device.deviceCode, status: "CLOSED" });
    assert.equal((await submit([event.eventId, "missing-event"])).status, 400);
    assert.equal(event.status, "timeout_unopened", "批量预检失败时不部分处理");
    const res = await submit(); assert.equal(res.status, 201, await res.text());
    assert.equal(event.status, "failed"); assert.equal(event.physicalDoorState, "closed");
    assert.equal(event.billingStatus, "admin_confirmed");
    assert.equal(event.paymentNotifyStatus, undefined, "不能伪造平台完结成功");
    assert.equal((await submit()).status, 201);
    assert.equal(store.logs.filter(l => l.type === "resolve-unopened-event" && l.relatedEventId === event.eventId).length, 1);
    assert.equal(JSON.stringify([store.inventory, store.paymentOrders]), before);
    assert.equal(alertsService.list("open").some(a => a.relatedEventId === event.eventId), false, "巡检不再生成已处理故障");
    alertsService.create({ type: "device_fault", title: `${device.name}开门失败`, deviceCode: device.deviceCode,
      relatedEventId: event.eventId, dueAt: event.updatedAt, detail: "模拟旧版残留的重复待办" });
    assert.equal(alertsService.list("open").some(a => a.relatedEventId === event.eventId), false);
    assert.equal(store.alerts.find(a => a.relatedEventId === event.eventId)?.status, "resolved");
    assert.equal(alertsService.list("open").some(a => a.relatedEventId === event.eventId), false, "刷新保持已处理");
  });
});

test("已有真实订单号或回调的事件不能按网络遗留意图关闭", async () => {
  await withApi(async ({ devicesService, store }) => {
    const { event, device, user } = appendClosedSpecialEvent(store);
    event.status = "timeout_unopened"; event.physicalDoorState = "unknown";
    store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });
    assert.throws(() => devicesService.confirmDoorClosed(device.deviceCode, undefined, store.getUserTenantId(user), {
      evidence: "later-platform-close", eventIds: [event.eventId], reason: "核对"
    }), /仅可关闭/);
    assert.equal(event.status, "timeout_unopened");
  });
});

test("模板时段更新同步已绑定个人副本，09:59拒绝10:00允许且额度标识不重置", async () => {
  await withApi(async ({ store }) => {
    const user = store.users.find(u => u.role === "special")!;
    const goods = store.goodsCatalog[0]!;
    const service = new SpecialAccessPoliciesService(store);
    const policy = service.create({ name: "领取时段回归", weekdays: [0,1,2,3,4,5,6], startHour: 8, endHour: 22,
      status: "active", applicableUserIds: [user.id], goodsLimits: [], entitlementLimits: [{ id: "pool-keep", targetType: "goods", targetId: goods.goodsId, quantity: 1 }] });
    const personal = { ...structuredClone(policy), id: "personal-keep", sourcePolicyId: policy.id, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
    user.accessPolicies = [personal, { ...structuredClone(personal), id: "history", status: "inactive", effectiveToDateKey: "2026-09-30" }];
    const quotaBefore = JSON.stringify(personal.entitlementLimits);
    service.update(policy.id, { startHour: 10, endHour: 22 });
    assert.equal(personal.startHour, 10); assert.equal(user.accessPolicies[1].startHour, 8);
    assert.equal(personal.id, "personal-keep"); assert.equal(JSON.stringify(personal.entitlementLimits), quotaBefore);
    const quotaAt = (time: string) => getActiveWindowEntitlementQuota(user, store.specialAccessPolicies, [], store.goodsCatalog, store.goodsTaxonomyNodes, new Date(time));
    assert.equal(quotaAt("2026-10-02T09:59:00+08:00").activeWindows.length, 0);
    assert.equal(quotaAt("2026-10-02T10:00:00+08:00").activeWindows.length, 1);
    assert.equal(quotaAt("2026-10-02T22:00:00+08:00").activeWindows.length, 0);
    personal.startHour = 8;
    service.update(policy.id, { name: "只改名称" }); assert.equal(personal.startHour, 8);
    policy.applicableUserIds = [];
    service.update(policy.id, { startHour: 11 }); assert.equal(personal.startHour, 8, "不影响已解绑个人规则");
  });
});

const createManualSettlementConflict = async (context: {
  baseUrl: string;
  store: InMemoryStoreService;
  token: string;
  suffix: string;
}) => {
  const { event, user, device } = appendClosedSpecialEvent(context.store);
  event.eventId = `event-manual-settlement-${context.suffix}`;
  event.orderNo = `mock-manual-settlement-${context.suffix}`;
  const closeLog = context.store.callbackLog.find(
    (entry) => entry.id === "callback-manual-settlement-closed"
  );
  if (closeLog) {
    closeLog.id = `callback-manual-settlement-closed-${context.suffix}`;
    closeLog.payload.eventId = event.eventId;
  }
  const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? context.store.goodsCatalog[0];
  assert.ok(goods);
  context.store.ensureDeviceGoodsEntry(device.deviceCode, goods);
  context.store.goodsBatches.splice(
    0,
    context.store.goodsBatches.length,
    ...context.store.goodsBatches.filter(
      (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
    )
  );
  const batch = context.store.createGoodsBatch({
    goodsId: goods.goodsId,
    deviceCode: device.deviceCode,
    quantity: 4,
    sourceType: "admin",
    sourceUserId: user.id,
    sourceUserName: user.name
  });
  const createResponse = await fetch(
    `${context.baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        items: [{ goodsId: goods.goodsId, quantity: 1 }],
        reason: "平台回调超时，现场盘点确认。",
        confirmed: true
      })
    }
  );
  assert.equal(createResponse.status, 200);
  const callbackResponse = await fetch(
    `${context.baseUrl}/cabinet-events/callbacks/settlement`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderNo: event.orderNo,
        eventId: event.eventId,
        phone: event.phone,
        deviceCode: event.deviceCode,
        amount: goods.price * 2,
        notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
        detail: [{
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: 2,
          unitPrice: goods.price
        }],
        clientId: "smartvm-client",
        nonceStr: `nonce-manual-settlement-${context.suffix}`,
        timestamp: Math.floor(Date.now() / 1000),
        sign: "local-mock"
      })
    }
  );
  assert.equal(callbackResponse.status, 200);
  assert.equal(event.manualSettlement?.status, "conflict");
  return { event, user, device, goods, batch };
};

test("可信关门满十分钟可人工核对，未满150分钟不自动生成超时报警", async () => {
  await withApi(async ({ baseUrl, store, token, devicesService }) => {
    const { event, user, device, closedAt } = appendClosedSpecialEvent(store);

    store.alerts.splice(
      0,
      store.alerts.length,
      ...store.alerts.filter((entry) => entry.relatedEventId !== event.eventId)
    );
    devicesService.monitoringDetail(device.deviceCode, store.getDefaultTenantId());
    assert.equal(
      store.alerts.some(
        (entry) =>
          entry.relatedEventId === event.eventId &&
          entry.title === "结算回调超时待补记" &&
          entry.status === "open"
      ),
      false
    );

    const response = await fetch(
      `${baseUrl}/cabinet-events/manual-settlement-candidates?userId=${encodeURIComponent(user.id)}`,
      {
        headers: { authorization: `Bearer ${token}` }
      }
    );
    const payload = (await response.json()) as {
      code?: number;
      data?: Array<{
        eventId?: string;
        platformOrderNo?: string;
        closedAt?: string;
        device?: { deviceCode?: string };
      }>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.code, 200);
    assert.equal(payload.data?.length, 1);
    assert.equal(payload.data?.[0]?.eventId, event.eventId);
    assert.equal(payload.data?.[0]?.platformOrderNo, event.orderNo);
    assert.equal(payload.data?.[0]?.closedAt, closedAt);
    assert.equal(payload.data?.[0]?.device?.deviceCode, device.deviceCode);
  });
});

test("结算回调超时报警在可信关门满150分钟生成，边界前不报警且重复刷新不重复创建", async (t) => {
  await withApi(async ({ store, alertsService }) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { event } = appendClosedSpecialEvent(store, 150);
    const closeLog = store.callbackLog.find((entry) => entry.payload.eventId === event.eventId)!;
    const closedAtMs = Date.parse(closeLog.receivedAt);
    const matchingAlerts = () => store.alerts.filter(
      (entry) => entry.relatedEventId === event.eventId && entry.title === "结算回调超时待补记"
    );

    now = closedAtMs + 150 * 60_000 - 1;
    alertsService.refreshManualSettlementTasks();
    assert.equal(matchingAlerts().length, 0, "149分59.999秒时仍等待平台回调");

    now += 1;
    alertsService.refreshManualSettlementTasks();
    assert.equal(matchingAlerts().length, 1);
    assert.equal(matchingAlerts()[0]!.dueAt, new Date(now).toISOString());
    assert.match(matchingAlerts()[0]!.detail ?? "", /满 150 分钟/);
    assert.equal(matchingAlerts()[0]!.status, "open");

    now += 60_000;
    alertsService.refreshManualSettlementTasks();
    assert.equal(matchingAlerts().length, 1);
    assert.equal(matchingAlerts()[0]!.dueAt, new Date(closedAtMs + 150 * 60_000).toISOString());
  });
});

test("已有结算提醒每次查询更新等待时长，不改写提醒、不猜测缺失关门时间，完成后停止显示", async (t) => {
  await withApi(async ({ store, alertsService }) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { event, closedAt } = appendClosedSpecialEvent(store, 150);
    const read = () => alertsService.list().find((entry) => entry.relatedEventId === event.eventId)!;
    const first = read();
    assert.deepEqual(first.settlementWaiting, {
      closedAt, checkedAt: new Date(now).toISOString(), elapsedMinutes: 150, overdueMinutes: 0
    });
    const saved = store.alerts.find((entry) => entry.id === first.id)!;
    const originalDetail = saved.detail;
    now += (24 * 60 + 67) * 60_000 + 59_999;
    const later = read();
    assert.equal(later.id, first.id);
    assert.equal(later.settlementWaiting?.elapsedMinutes, 1657);
    assert.equal(later.settlementWaiting?.overdueMinutes, 1507);
    assert.equal(saved.settlementWaiting, undefined, "展示时长不写入账本");
    assert.equal(saved.detail, originalDetail);
    assert.equal(saved.dueAt, first.dueAt);
    const closeLog = store.callbackLog.find((entry) => entry.payload.eventId === event.eventId)!;
    closeLog.payload.deviceCode = "another-device";
    assert.equal(read().settlementWaiting, undefined, "不采用其他柜机的记录");
    closeLog.payload.deviceCode = event.deviceCode;
    closeLog.receivedAt = "invalid";
    assert.equal(read().settlementWaiting, undefined);
    closeLog.receivedAt = new Date(now + 60_000).toISOString();
    assert.equal(read().settlementWaiting, undefined, "未来时间不能显示负数等待");
    closeLog.receivedAt = closedAt;
    saved.status = "resolved";
    saved.resolvedAt = new Date(now).toISOString();
    assert.equal(read().settlementWaiting, undefined);
  });
});

test("结算超时提醒仅在结算与平台回写都完成后自动关闭，旧提醒和已知晓提醒也恢复且不重复留日志", async () => {
  await withApi(async ({ store, alertsService, devicesService }) => {
    const { event, device } = appendClosedSpecialEvent(store, 151);
    const alert = alertsService.list().find((entry) => entry.relatedEventId === event.eventId)!;
    const saved = store.alerts.find((entry) => entry.id === alert.id)!;
    event.paymentNotifyStatus = "success";
    assert.equal(alertsService.resolveRecoveredCallbackFailures(event.eventId), 0, "仅有关门，不能关闭");
    event.status = "settled";
    event.billingStatus = "free";
    for (const status of ["pending", "failed"] as const) {
      event.paymentNotifyStatus = status;
      assert(alertsService.list("open").some((entry) => entry.id === alert.id), "平台回写未完成仍提醒");
    }
    saved.status = "acknowledged";
    event.paymentNotifyStatus = "success";
    devicesService.monitoringDetail(device.deviceCode, store.getDefaultTenantId());
    assert.equal(saved.status, "resolved", "从柜机详情查询也能修复旧提醒");
    assert.match(saved.resolutionNote ?? "", /结算已完成且平台回写成功/);
    assert(!alertsService.list("open").some((entry) => entry.id === alert.id));
    assert.equal(alertsService.list("resolved").find((entry) => entry.id === alert.id)?.settlementWaiting, undefined);
    assert.equal(alertsService.resolveRecoveredCallbackFailures(event.eventId), 0);
    assert.equal(store.logs.filter((entry) => entry.type === "resolve-alert" && entry.relatedEventId === event.eventId).length, 1);
  });
});

test("迟到的零元空取货结算完成后立即关闭超时提醒，不依赖列表查询", async () => {
  await withApi(async ({ baseUrl, store, alertsService }) => {
    const { event } = appendClosedSpecialEvent(store, 151);
    event.orderNo = "mock-late-empty-settlement";
    alertsService.refreshManualSettlementTasks();
    const alert = store.alerts.find((entry) => entry.relatedEventId === event.eventId)!;
    assert.equal(alert.status, "open");
    const response = await fetch(`${baseUrl}/cabinet-events/callbacks/settlement`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderNo: event.orderNo, eventId: event.eventId, phone: event.phone,
        deviceCode: event.deviceCode, amount: 0, detail: [],
        notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
        clientId: "smartvm-client", nonceStr: "late-empty-settlement", sign: "local-mock",
        timestamp: Math.floor(Date.now() / 1000)
      })
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(event.status, "settled");
    assert.equal(event.paymentNotifyStatus, "success");
    assert.equal(alert.status, "resolved");
  });
});

const recoveryPayload = (event: CabinetEventRecord) => ({
  eventId: event.eventId, orderNo: event.orderNo, deviceCode: event.deviceCode, phone: event.phone,
  amount: 990, notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
  detail: [{ goodsId: "recovery-cookie", goodsName: "恢复测试饼干", quantity: 1, unitPrice: 990 }],
  clientId: "smartvm-client", nonceStr: "recovery-test", sign: "local-mock", timestamp: Math.floor(Date.now() / 1000)
});

test("缺少货品立即同步后结算，并发和重复回调只入账一次，已完成待办关闭", async () => {
  await withApi(async ({ store, cabinetEvents, smartVmGateway }) => {
    const { event } = appendClosedSpecialEvent(store, 151);
    event.orderNo = "mock-recovery-cookie"; event.pickupMode = "actual";
    let syncs = 0;
    smartVmGateway.getGoodsInfo = async () => {
      syncs++;
      return [{ goodsId: "recovery-cookie", goodsCode: "recovery-cookie", name: "恢复测试饼干", imageUrl: "", price: 990, category: "daily", stock: 1 }];
    };
    const payload = recoveryPayload(event);
    await Promise.all([cabinetEvents.handleSettlementWithRecovery(payload), cabinetEvents.handleSettlementWithRecovery(payload)]);
    await cabinetEvents.handleSettlementWithRecovery(payload);
    assert.equal(syncs, 1);
    assert.equal(event.settlementRecovery?.status, "succeeded");
    assert.equal(event.paymentNotifyStatus, "success");
    assert.equal(event.amount, 0);
    assert.equal(store.inventory.filter(x => x.eventId === event.eventId && x.type === "pickup").length, 1);
    assert.equal(store.alerts.find(x => x.title === "结算处理失败待恢复" && x.relatedEventId === event.eventId)?.status, "resolved");
    const persisted = JSON.parse(readFileSync(process.env.API_DATA_FILE!, "utf8"));
    assert.deepEqual(validatePersistedState(persisted).errors, []);
    assert.equal(JSON.stringify(event.settlementRecovery).includes("local-mock"), false);
  });
});

test("同步失败按十分钟间隔最多重试三次，持久化恢复、重复回调与旧补发周期不能突破上限", async () => {
  await withApi(async ({ store, cabinetEvents, smartVmGateway, goodsService, alertsService }) => {
    const { event } = appendClosedSpecialEvent(store, 151);
    event.orderNo = "mock-recovery-exhausted"; event.pickupMode = "actual";
    let syncs = 0;
    smartVmGateway.getGoodsInfo = async () => { syncs++; throw new Error("模拟平台断线"); };
    const payload = recoveryPayload(event);
    await assert.rejects(cabinetEvents.handleSettlementWithRecovery(payload));
    assert.equal(event.settlementRecovery?.attempts, 1);
    assert(Date.parse(event.settlementRecovery!.nextAttemptAt!) - Date.now() > 599_000);
    await cabinetEvents.retryPendingSettlements(() => {});
    await assert.rejects(cabinetEvents.handleSettlementWithRecovery(payload));
    assert.equal(syncs, 1);
    for (let attempt = 2; attempt <= 4; attempt++) {
      // 用重新构造的恢复服务读取已落盘的进度，模拟进程内队列丢失后的恢复。
      event.settlementRecovery = JSON.parse(readFileSync(process.env.API_DATA_FILE!, "utf8")).events.find((e: CabinetEventRecord) => e.eventId === event.eventId).settlementRecovery;
      event.settlementRecovery!.nextAttemptAt = new Date(Date.now() - 1).toISOString();
      const restarted = new SettlementRecoveryService(store, goodsService, alertsService);
      await restarted.retryDue(() => async () => { throw new Error("不应在同步失败后结算"); }, () => {});
      assert.equal(event.settlementRecovery!.attempts, attempt);
    }
    await cabinetEvents.retryPendingSettlements(() => {});
    await cabinetEvents.completePendingZeroCostOrders();
    await assert.rejects(cabinetEvents.handleSettlementWithRecovery(payload));
    assert.equal(syncs, 4);
    assert.equal(event.settlementRecovery?.status, "exhausted");
    assert.equal(event.settlementRecovery?.nextAttemptAt, undefined);
    assert.match(store.alerts.find(x => x.title === "结算处理失败待恢复" && x.relatedEventId === event.eventId)!.detail, /停止自动重试/);
    assert.equal(store.inventory.filter(x => x.eventId === event.eventId).length, 0);
  });
});

test("结算已入账但平台回写失败时重试沿用交易号且不重复库存，分钟补发遵守恢复等待", async () => {
  await withApi(async ({ store, cabinetEvents, smartVmGateway }) => {
    const { event } = appendClosedSpecialEvent(store, 151);
    event.orderNo = "mock-recovery-notify"; event.pickupMode = "actual";
    smartVmGateway.getGoodsInfo = async () => [{ goodsId: "recovery-cookie", goodsCode: "recovery-cookie", name: "恢复测试饼干", imageUrl: "", price: 990, category: "daily", stock: 1 }];
    const notify = smartVmGateway.notifyPaymentSuccess.bind(smartVmGateway);
    const transactions: string[] = [];
    smartVmGateway.notifyPaymentSuccess = async (payload, options) => {
      transactions.push(payload.transactionId);
      if (transactions.length === 1) throw new Error("模拟回写失败");
      return notify(payload, options);
    };
    await assert.rejects(cabinetEvents.handleSettlementWithRecovery(recoveryPayload(event)));
    await cabinetEvents.completePendingZeroCostOrders();
    assert.equal(transactions.length, 1);
    event.settlementRecovery!.nextAttemptAt = new Date(Date.now() - 1).toISOString();
    await cabinetEvents.retryPendingSettlements(() => {});
    assert.equal(event.settlementRecovery?.status, "succeeded");
    assert.equal(event.paymentNotifyStatus, "success");
    assert.equal(transactions.length, 2);
    assert.equal(transactions[0], transactions[1]);
    assert.equal(store.inventory.filter(x => x.eventId === event.eventId && x.type === "pickup").length, 1);
  });
});

test("未验签或无效数量不会创建恢复任务和同步商品", async () => {
  await withApi(async ({ store, cabinetEvents, smartVmGateway }) => {
    const { event } = appendClosedSpecialEvent(store, 151);
    event.orderNo = "mock-recovery-untrusted";
    smartVmGateway.verifySignedPayload = () => false;
    let syncs = 0;
    smartVmGateway.getGoodsInfo = async () => { syncs++; return []; };
    const payload = recoveryPayload(event);
    smartVmGateway.isUsingMockTransport = () => false;
    await assert.rejects(cabinetEvents.handleSettlementWithRecovery({ ...payload, sign: "invalid" }));
    smartVmGateway.isUsingMockTransport = () => true;
    await assert.rejects(cabinetEvents.handleSettlementWithRecovery({ ...payload, detail: [{ ...payload.detail[0], quantity: -1 }] }));
    assert.equal(syncs, 0);
    assert.equal(event.settlementRecovery, undefined);
  });
});

test("人工结算补记一次扣减库存并把事件和额度流水记为已人工核对", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device, closedAt } = appendClosedSpecialEvent(store);
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    const now = new Date().toISOString();
    store.goodsTaxonomyNodes.splice(0, store.goodsTaxonomyNodes.length,
      { id: "taxonomy:any", name: "任意", parentId: null, status: "active", sortOrder: 1, revision: 1, createdAt: now, updatedAt: now },
      { id: "taxonomy:food", name: "食品", parentId: "taxonomy:any", status: "active", sortOrder: 1, revision: 1, createdAt: now, updatedAt: now }
    );
    const catalogGoods = store.goodsCatalog.find((entry) => entry.goodsId === goods.goodsId);
    assert.ok(catalogGoods);
    catalogGoods.taxonomyNodeId = "taxonomy:food";
    user.accessPolicies = [{
      id: "manual-settlement-entitlement-policy",
      name: "人工补记额度测试",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
      goodsLimits: [],
      entitlementLimits: [{
        id: "manual-food-limit",
        targetType: "taxonomy_node",
        targetId: "taxonomy:food",
        quantity: 3
      }],
      status: "active"
    }];
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const batch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });

    const response = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 2 }],
          reason: "平台结算回调超时，已根据现场盘点确认实际领取。",
          confirmed: true
        })
      }
    );
    const payload = (await response.json()) as {
      code?: number;
      data?: {
        eventId?: string;
        status?: string;
        movementIds?: string[];
      };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.code, 200);
    assert.equal(payload.data?.eventId, event.eventId);
    assert.equal(payload.data?.status, "awaiting_platform_completion");
    assert.equal(payload.data?.movementIds?.length, 1);
    assert.equal(batch.remainingQuantity, 1);
    assert.equal(event.status, "settled");
    assert.equal(event.billingStatus, "admin_confirmed");
    const movement = store.inventory.find(
      (entry) => entry.id === payload.data?.movementIds?.[0]
    );
    assert.equal(movement?.type, "pickup");
    assert.equal(movement?.quotaQuantity, 2);
    assert.deepEqual(
      movement?.entitlementAllocations?.map((line) => ({ targetId: line.targetId, quantity: line.quantity })),
      [{ targetId: "taxonomy:food", quantity: 2 }]
    );
    assert.equal(movement?.eventId, event.eventId);
    assert.equal(movement?.happenedAt, closedAt);

    const restartedStore = new InMemoryStoreService();
    const restartedEvent = restartedStore.events.find(
      (entry) => entry.eventId === event.eventId
    );
    assert.equal(restartedEvent?.manualSettlement?.status, "awaiting_platform_completion");
    assert.deepEqual(
      restartedEvent?.manualSettlement?.movementIds,
      event.manualSettlement?.movementIds
    );
    assert.equal(
      restartedStore.inventory.find(
        (entry) => entry.id === restartedEvent?.manualSettlement?.movementIds[0]
      )?.settlementSource,
      "manual_recovery"
    );
    assert.equal(
      restartedStore.inventory.find(
        (entry) => entry.id === restartedEvent?.manualSettlement?.movementIds[0]
      )?.entitlementAllocations?.[0]?.targetId,
      "taxonomy:food"
    );
  });
});

test("人工结算补记在任一商品额度不足时整单拒绝且不扣库存", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    const now = new Date().toISOString();
    store.goodsTaxonomyNodes.splice(
      0,
      store.goodsTaxonomyNodes.length,
      {
        id: "taxonomy:any:insufficient",
        name: "任意",
        parentId: null,
        status: "active",
        sortOrder: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "taxonomy:food:insufficient",
        name: "食品",
        parentId: "taxonomy:any:insufficient",
        status: "active",
        sortOrder: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now
      }
    );
    const catalogGoods = store.goodsCatalog.find((entry) => entry.goodsId === goods.goodsId);
    assert.ok(catalogGoods);
    catalogGoods.taxonomyNodeId = "taxonomy:food:insufficient";
    user.accessPolicies = [
      {
        id: "manual-settlement-insufficient-policy",
        name: "人工补记额度不足测试",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startHour: 0,
        endHour: 24,
        goodsLimits: [],
        entitlementLimits: [
          {
            id: "manual-food-insufficient-limit",
            targetType: "taxonomy_node",
            targetId: "taxonomy:food:insufficient",
            quantity: 1
          }
        ],
        status: "active"
      }
    ];
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const batch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });

    const response = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 2 }],
          reason: "验证额度不足时不产生部分人工补记。",
          confirmed: true
        })
      }
    );
    const payload = (await response.json()) as { message?: string };

    assert.equal(response.status, 400);
    assert.match(payload.message ?? "", /超出当前可领取范围/);
    assert.equal(batch.remainingQuantity, 3);
    assert.equal(event.manualSettlement, undefined);
    assert.notEqual(event.status, "settled");
    assert.equal(
      store.inventory.some(
        (entry) =>
          entry.eventId === event.eventId && entry.settlementSource === "manual_recovery"
      ),
      false
    );
  });
});

test("订单号待补的人工结算可后补唯一平台订单号且不会再次扣减", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    event.orderNo = `pending-${event.eventId}`;
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const batch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });

    const createResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "开门响应缺失，已根据可信关门记录和现场盘点补记。",
          confirmed: true
        })
      }
    );
    const created = (await createResponse.json()) as {
      data?: { id?: string; status?: string; movementIds?: string[] };
    };
    assert.equal(createResponse.status, 200);
    assert.ok(created.data?.id);
    assert.equal(created.data?.status, "awaiting_order");
    assert.equal(batch.remainingQuantity, 2);

    const platformOrderNo = "order-linked-after-manual-settlement";
    const linkResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/order-link`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ platformOrderNo })
      }
    );
    const linked = (await linkResponse.json()) as {
      data?: { status?: string; platformOrderNo?: string };
    };

    assert.equal(linkResponse.status, 200);
    assert.equal(linked.data?.status, "awaiting_platform_completion");
    assert.equal(linked.data?.platformOrderNo, platformOrderNo);
    assert.equal(event.orderNo, platformOrderNo);
    assert.equal(batch.remainingQuantity, 2);
    assert.equal(
      store.inventory.find((entry) => entry.id === created.data?.movementIds?.[0])?.orderNo,
      platformOrderNo
    );
  });
});

test("平台订单号只要求在当前实例内唯一，不会被其他实例同号事件阻塞", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    event.orderNo = "mock-order-shared-between-tenants";
    const otherUser = structuredClone(user);
    otherUser.id = "special-other-tenant-manual-settlement";
    otherUser.phone = "13000009998";
    otherUser.tenantId = "tenant-other-manual-settlement";
    const otherDevice = structuredClone(device);
    otherDevice.deviceCode = "device-other-tenant-manual-settlement";
    otherDevice.tenantId = "tenant-other-manual-settlement";
    store.users.push(otherUser);
    store.devices.push(otherDevice);
    store.events.unshift({
      ...structuredClone(event),
      eventId: "event-other-tenant-same-order",
      userId: otherUser.id,
      phone: otherUser.phone,
      deviceCode: otherDevice.deviceCode
    });

    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 2,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });

    const response = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "当前实例内订单唯一，其他实例同号不应阻塞。",
          confirmed: true
        })
      }
    );

    assert.equal(response.status, 200);
    assert.equal(event.manualSettlement?.platformOrderNo, event.orderNo);

    const callbackResponse = await fetch(
      `${baseUrl}/cabinet-events/callbacks/settlement`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderNo: event.orderNo,
          eventId: event.eventId,
          phone: event.phone,
          deviceCode: event.deviceCode,
          amount: goods.price,
          notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
          detail: [{
            goodsId: goods.goodsId,
            goodsName: goods.name,
            quantity: 1,
            unitPrice: goods.price
          }],
          clientId: "smartvm-client",
          nonceStr: "nonce-cross-tenant-same-order",
          timestamp: Math.floor(Date.now() / 1000),
          sign: "local-mock"
        })
      }
    );
    const callbackPayload = await callbackResponse.json();
    assert.equal(callbackResponse.status, 200, JSON.stringify(callbackPayload));
    assert.equal(event.manualSettlement?.status, "callback_reconciled");
  });
});

test("本地补记后可复用同柜机唯一可信目标完成零元平台回写", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 2,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    store.events.push({
      ...event,
      eventId: "event-trusted-payment-target",
      orderNo: "order-trusted-payment-target",
      status: "settled",
      goods: [{
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        quantity: 1,
        unitPrice: goods.price
      }],
      paymentNotifyStatus: "success",
      paymentNotifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
      paymentTransactionId: "trusted-prior-transaction"
    });

    const createResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "平台回调超时，现场盘点确认。",
          confirmed: true
        })
      }
    );
    assert.equal(createResponse.status, 200);

    const legacyCompletionResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/platform-completion-retry`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      }
    );
    assert.equal(legacyCompletionResponse.status, 403);

    const completeResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/platform-completion`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      }
    );
    const completed = (await completeResponse.json()) as {
      data?: {
        manualSettlement?: { status?: string; platformCompletedAt?: string };
        platformCompletion?: { forwarded?: boolean; transactionId?: string };
      };
    };

    assert.equal(completeResponse.status, 200);
    assert.equal(completed.data?.manualSettlement?.status, "platform_completed");
    assert.ok(completed.data?.manualSettlement?.platformCompletedAt);
    assert.equal(completed.data?.platformCompletion?.forwarded, true);
    assert.equal(event.paymentNotifyStatus, "success");
    assert.equal(
      event.paymentTransactionId,
      completed.data?.platformCompletion?.transactionId
    );
  });
});

test("人工结算补记相同请求幂等且不同内容不会重复扣减", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const batch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const body = {
      items: [{ goodsId: goods.goodsId, quantity: 1 }],
      reason: "平台回调超时，现场盘点确认。",
      confirmed: true
    };
    const request = () => fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    const first = await request();
    const firstPayload = (await first.json()) as { data?: { id?: string } };
    const replay = await request();
    const replayPayload = (await replay.json()) as { data?: { id?: string } };
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replayPayload.data?.id, firstPayload.data?.id);
    assert.equal(batch.remainingQuantity, 2);
    assert.equal(
      store.inventory.filter(
        (entry) => entry.eventId === event.eventId && entry.type === "pickup"
      ).length,
      1
    );

    const conflict = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...body, reason: "不同的处理依据" })
      }
    );
    assert.equal(conflict.status, 409);
    assert.equal(batch.remainingQuantity, 2);
  });
});

test("人工结算补记中途失败会整体回滚", async () => {
  await withApi(async ({ baseUrl, store, inventoryBatchChanges, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const goods = store.goodsCatalog.slice(0, 2);
    assert.equal(goods.length, 2);
    for (const item of goods) {
      store.ensureDeviceGoodsEntry(device.deviceCode, item);
      store.createGoodsBatch({
        goodsId: item.goodsId,
        deviceCode: device.deviceCode,
        quantity: 3,
        sourceType: "admin",
        sourceUserId: user.id,
        sourceUserName: user.name
      });
    }
    const beforeBatches = structuredClone(store.goodsBatches);
    const originalRecord = inventoryBatchChanges.recordConsumptiveMovement.bind(
      inventoryBatchChanges
    );
    let calls = 0;
    inventoryBatchChanges.recordConsumptiveMovement = ((payload) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("模拟第二条商品扣减失败");
      }
      return originalRecord(payload);
    }) as InventoryBatchChangesService["recordConsumptiveMovement"];

    const response = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: goods.map((item) => ({ goodsId: item.goodsId, quantity: 1 })),
          reason: "平台回调超时，现场盘点确认。",
          confirmed: true
        })
      }
    );

    assert.equal(response.status, 500);
    assert.deepEqual(store.goodsBatches, beforeBatches);
    assert.equal(event.manualSettlement, undefined);
    assert.equal(
      store.inventory.some((entry) => entry.eventId === event.eventId),
      false
    );
  });
});

test("平台回写前整单撤销会恢复原批次和额度流水", async () => {
  await withApi(async ({ baseUrl, store, alertsService, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store, 151);
    alertsService.list();
    const candidateAlert = store.alerts.find(
      (entry) =>
        entry.relatedEventId === event.eventId && entry.title === "结算回调超时待补记"
    );
    assert.equal(candidateAlert?.status, "open");
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const firstBatch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 1,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const secondBatch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 2,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const createResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 2 }],
          reason: "平台回调超时，现场盘点确认。",
          confirmed: true
        })
      }
    );
    const initial = (await createResponse.json()) as { data?: { id?: string } };
    assert.equal(createResponse.status, 200);
    assert.ok(initial.data?.id);
    assert.equal(candidateAlert?.status, "resolved");
    assert.equal(firstBatch.remainingQuantity + secondBatch.remainingQuantity, 1);
    const sourceMovement = store.inventory.find(
      (entry) => event.manualSettlement?.movementIds.includes(entry.id)
    );
    assert.ok(sourceMovement);

    const revertResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/revert`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ reason: "现场复核确认本次未实际取走物资。" })
      }
    );
    const reverted = (await revertResponse.json()) as {
      data?: { status?: string; reversalMovementIds?: string[] };
    };

    assert.equal(revertResponse.status, 200);
    assert.equal(reverted.data?.status, "reverted");
    assert.equal(reverted.data?.reversalMovementIds?.length, 1);
    assert.equal(firstBatch.remainingQuantity, 1);
    assert.equal(secondBatch.remainingQuantity, 2);
    assert.equal(event.status, "closed");
    assert.equal(event.billingStatus, "pending");
    assert.deepEqual(event.goods, []);
    const reversal = store.inventory.find(
      (entry) => entry.id === reverted.data?.reversalMovementIds?.[0]
    );
    assert.equal(reversal?.type, "refund");
    assert.equal(reversal?.happenedAt, sourceMovement?.happenedAt);
    assert.equal(reversal?.quotaQuantity, 2);
    assert.equal(reversal?.orderNo, event.orderNo);
    assert.equal(candidateAlert?.status, "open");

    const candidatesResponse = await fetch(
      `${baseUrl}/cabinet-events/manual-settlement-candidates?userId=${encodeURIComponent(user.id)}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const candidates = (await candidatesResponse.json()) as {
      data?: Array<{ eventId?: string }>;
    };
    assert.equal(candidatesResponse.status, 200);
    assert.equal(
      candidates.data?.some((entry) => entry.eventId === event.eventId),
      true
    );

    const correctedResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "撤销后按第二次现场核对结果重新补记。",
          confirmed: true
        })
      }
    );
    const corrected = (await correctedResponse.json()) as {
      data?: { id?: string; movementIds?: string[] };
    };
    assert.equal(correctedResponse.status, 200);
    assert.ok(corrected.data?.id);
    assert.notEqual(corrected.data?.id, initial.data?.id);
    assert.equal(corrected.data?.movementIds?.length, 1);
    assert.equal(firstBatch.remainingQuantity + secondBatch.remainingQuantity, 2);
    assert.equal(candidateAlert?.status, "resolved");
  });
});

test("完全一致的迟到结算回调会核对完成人工补记且不二次扣减", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    event.orderNo = "mock-manual-settlement-exact-callback";
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const batch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const createResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "平台回调超时，现场盘点确认。",
          confirmed: true
        })
      }
    );
    assert.equal(createResponse.status, 200);
    assert.equal(batch.remainingQuantity, 2);

    const callbackResponse = await fetch(`${baseUrl}/cabinet-events/callbacks/settlement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderNo: event.orderNo,
        eventId: event.eventId,
        phone: event.phone,
        deviceCode: event.deviceCode,
        amount: goods.price,
        notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
        detail: [{
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: 1,
          unitPrice: goods.price
        }],
        clientId: "smartvm-client",
        nonceStr: "nonce-manual-settlement-exact",
        timestamp: Math.floor(Date.now() / 1000),
        sign: "local-mock"
      })
    });

    assert.equal(callbackResponse.status, 200);
    assert.equal(event.manualSettlement?.status, "callback_reconciled");
    assert.equal(event.manualSettlement?.lateCallback?.matched, true);
    assert.equal(batch.remainingQuantity, 2);
    assert.equal(
      store.inventory.filter(
        (entry) => entry.eventId === event.eventId && entry.type === "pickup"
      ).length,
      1
    );
  });
});

test("不一致的迟到结算回调进入冲突且不改变库存或额度", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    event.orderNo = "mock-manual-settlement-conflict-callback";
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.goodsBatches.splice(
      0,
      store.goodsBatches.length,
      ...store.goodsBatches.filter(
        (entry) => entry.deviceCode !== device.deviceCode || entry.goodsId !== goods.goodsId
      )
    );
    const batch = store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 4,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const createResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "平台回调超时，现场盘点确认。",
          confirmed: true
        })
      }
    );
    assert.equal(createResponse.status, 200);
    assert.equal(batch.remainingQuantity, 3);

    const callbackResponse = await fetch(`${baseUrl}/cabinet-events/callbacks/settlement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderNo: event.orderNo,
        eventId: event.eventId,
        phone: event.phone,
        deviceCode: event.deviceCode,
        amount: goods.price * 2,
        notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
        detail: [{
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: 2,
          unitPrice: goods.price
        }],
        clientId: "smartvm-client",
        nonceStr: "nonce-manual-settlement-conflict",
        timestamp: Math.floor(Date.now() / 1000),
        sign: "local-mock"
      })
    });

    assert.equal(callbackResponse.status, 200);
    assert.equal(event.manualSettlement?.status, "conflict");
    assert.equal(event.manualSettlement?.lateCallback?.matched, false);
    assert.equal(batch.remainingQuantity, 3);
    assert.equal(
      store.inventory.filter(
        (entry) => entry.eventId === event.eventId && entry.type === "pickup"
      ).length,
      1
    );
    assert.equal(
      store.alerts.some(
        (entry) =>
          entry.relatedEventId === event.eventId &&
          entry.title === "人工结算补记与迟到回调明细冲突"
      ),
      true
    );
  });
});

test("明细冲突可保留人工结果并完成审计结案", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, batch } = await createManualSettlementConflict({
      baseUrl,
      store,
      token,
      suffix: "keep-manual"
    });
    assert.equal(batch.remainingQuantity, 3);

    const response = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/conflict-resolution`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          resolution: "keep_manual",
          reason: "已复核现场盘点和录像，以人工记录为准。"
        })
      }
    );
    const payload = (await response.json()) as {
      data?: { status?: string; conflictResolution?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.data?.status, "callback_reconciled");
    assert.equal(payload.data?.conflictResolution, "keep_manual");
    assert.equal(batch.remainingQuantity, 3);
    assert.equal(
      store.inventory.filter(
        (entry) => entry.eventId === event.eventId && entry.type === "pickup"
      ).length,
      1
    );
    assert.equal(
      store.alerts.find(
        (entry) =>
          entry.relatedEventId === event.eventId &&
          entry.title === "人工结算补记与迟到回调明细冲突"
      )?.status,
      "resolved"
    );
  });
});

test("明细冲突可按平台结果原子修正库存和额度且重放不重复扣减", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, batch, goods } = await createManualSettlementConflict({
      baseUrl,
      store,
      token,
      suffix: "use-platform"
    });
    assert.equal(batch.remainingQuantity, 3);
    const request = () => fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/conflict-resolution`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          resolution: "use_platform",
          reason: "已核对柜机识别明细，以平台回调为准。"
        })
      }
    );

    const response = await request();
    const payload = (await response.json()) as {
      data?: {
        status?: string;
        conflictResolution?: string;
        platformMovementIds?: string[];
        reversalMovementIds?: string[];
      };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.data?.status, "callback_reconciled");
    assert.equal(payload.data?.conflictResolution, "use_platform");
    assert.equal(payload.data?.platformMovementIds?.length, 1);
    assert.equal(payload.data?.reversalMovementIds?.length, 1);
    assert.equal(batch.remainingQuantity, 2);
    assert.equal(event.goods[0]?.goodsId, goods.goodsId);
    assert.equal(event.goods[0]?.quantity, 2);

    const manualMovement = store.inventory.find(
      (entry) => event.manualSettlement?.movementIds.includes(entry.id)
    );
    const platformMovement = store.inventory.find(
      (entry) => event.manualSettlement?.platformMovementIds?.includes(entry.id)
    );
    const reversalMovement = store.inventory.find(
      (entry) => event.manualSettlement?.reversalMovementIds?.includes(entry.id)
    );
    assert.equal(platformMovement?.happenedAt, manualMovement?.happenedAt);
    assert.equal(reversalMovement?.happenedAt, manualMovement?.happenedAt);

    const pickupCount = store.inventory.filter(
      (entry) => entry.eventId === event.eventId && entry.type === "pickup"
    ).length;
    const replay = await request();
    assert.equal(replay.status, 200);
    assert.equal(batch.remainingQuantity, 2);
    assert.equal(
      store.inventory.filter(
        (entry) => entry.eventId === event.eventId && entry.type === "pickup"
      ).length,
      pickupCount
    );
  });
});

test("人工结算候选严格要求可信关门满十分钟且不能跨实例访问", async () => {
  await withApi(async ({ baseUrl, store, token, alertsService }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const closeLog = store.callbackLog.find(
      (entry) => entry.payload.eventId === event.eventId && entry.payload.status === "CLOSED"
    );
    assert.ok(closeLog);
    closeLog.receivedAt = new Date(Date.now() - 9 * 60_000).toISOString();

    const beforeBoundary = await fetch(
      `${baseUrl}/cabinet-events/manual-settlement-candidates`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const beforePayload = (await beforeBoundary.json()) as { data?: unknown[] };
    assert.equal(beforeBoundary.status, 200);
    assert.equal(beforePayload.data?.length, 0);

    closeLog.receivedAt = new Date(Date.now() - 10 * 60_000 - 1).toISOString();
    const afterBoundary = await fetch(
      `${baseUrl}/cabinet-events/manual-settlement-candidates`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const afterPayload = (await afterBoundary.json()) as { data?: Array<{ eventId?: string }> };
    assert.equal(afterPayload.data?.[0]?.eventId, event.eventId);

    closeLog.payload.deviceCode = "device-mismatched-close-callback";
    const mismatchedClose = await fetch(
      `${baseUrl}/cabinet-events/manual-settlement-candidates`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const mismatchedClosePayload = (await mismatchedClose.json()) as { data?: unknown[] };
    assert.equal(mismatchedClosePayload.data?.length, 0);
    closeLog.receivedAt = new Date(Date.now() - 151 * 60_000).toISOString();
    alertsService.refreshOperationalTasks();
    assert.equal(
      store.alerts.some(
        (entry) =>
          entry.relatedEventId === event.eventId &&
          entry.title === "结算回调超时待补记"
      ),
      false
    );
    closeLog.payload.deviceCode = event.deviceCode;

    user.tenantId = "tenant-other";
    device.tenantId = "tenant-other";
    const hidden = await fetch(
      `${baseUrl}/cabinet-events/manual-settlement-candidates`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const hiddenPayload = (await hidden.json()) as { data?: unknown[] };
    assert.equal(hiddenPayload.data?.length, 0);
    const forbiddenEvent = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: store.goodsCatalog[0]?.goodsId, quantity: 1 }],
          reason: "跨实例请求不应生效。",
          confirmed: true
        })
      }
    );
    assert.equal(forbiddenEvent.status, 404);
  });
});

test("人工结算所有写接口同时要求管理员角色和两项权限", async () => {
  await withApi(async ({ baseUrl, store }) => {
    const { event } = appendClosedSpecialEvent(store);
    const tenantId = store.getDefaultTenantId();
    const adminCredential = store.backofficeCredentials.find(
      (entry) => entry.role === "admin" && entry.tenantId === tenantId
    );
    const adminUser = store.users.find((entry) => entry.id === adminCredential?.userId);
    assert.ok(adminCredential);
    assert.ok(adminUser);
    adminCredential.permissions = ["devices:operate"];
    const incompleteAdminToken = store.createBackofficeSession(adminUser, "admin", tenantId);
    const incomplete = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${incompleteAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ items: [], reason: "权限测试", confirmed: true })
      }
    );
    assert.equal(incomplete.status, 403);

    const merchantCredential = store.backofficeCredentials.find(
      (entry) => entry.role === "merchant" && entry.tenantId === tenantId
    );
    const merchantUser = store.users.find((entry) => entry.id === merchantCredential?.userId);
    assert.ok(merchantCredential);
    assert.ok(merchantUser);
    merchantCredential.permissions = ["devices:operate", "goods:stock-adjust"];
    const merchantToken = store.createBackofficeSession(merchantUser, "merchant", tenantId);
    const nonAdmin = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/revert`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${merchantToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ reason: "角色测试" })
      }
    );
    assert.equal(nonAdmin.status, 403);
  });
});

test("平台回写失败后重试复用同一交易号", async () => {
  await withApi(async ({ baseUrl, store, smartVmGateway, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 2,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    store.events.push({
      ...event,
      eventId: "event-trusted-payment-target-for-retry",
      orderNo: "order-trusted-payment-target-for-retry",
      status: "settled",
      paymentNotifyStatus: "success",
      paymentNotifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
      paymentTransactionId: "trusted-prior-transaction-for-retry"
    });
    const createResponse = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "平台回调超时，现场盘点确认。",
          confirmed: true
        })
      }
    );
    assert.equal(createResponse.status, 200);

    const originalNotify = smartVmGateway.notifyPaymentSuccess.bind(smartVmGateway);
    const transactionIds: string[] = [];
    let attempt = 0;
    smartVmGateway.notifyPaymentSuccess = (async (payload, options) => {
      transactionIds.push(payload.transactionId);
      attempt += 1;
      if (attempt === 1) {
        throw new Error("模拟平台暂时不可用");
      }
      return originalNotify(payload, options);
    }) as SmartVmGateway["notifyPaymentSuccess"];
    const endpoint = `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement/platform-completion`;
    const first = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.notEqual(first.status, 200);
    assert.equal(event.paymentNotifyStatus, "failed");
    const second = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(second.status, 200);
    assert.equal(transactionIds.length, 2);
    assert.equal(transactionIds[0], transactionIds[1]);
    assert.equal(event.paymentNotifyStatus, "success");
  });
});

test("人工结算原子回滚保留未落盘会话与验证码，已提交写入不回退内存", async () => {
  await withApi(async ({ store }) => {
    const user = store.users.find((entry) => entry.status === "active");
    assert.ok(user);
    const sessionToken = store.createSession(user);
    const draftToken = store.createDraftSession({
      tenantId: store.getDefaultTenantId(),
      phone: user.phone,
      linkedUserId: user.id
    });
    store.issueVerificationCode(user.phone, "general");
    const verificationCheckpoint = structuredClone(
      Array.from(store.verificationCodes.entries())
    );
    const originalName = user.name;
    const originalPersist = store.persist.bind(store);

    store.persist = () => {
      throw new PersistedStateWriteError("模拟写入前失败", false);
    };
    assert.throws(
      () =>
        store.runAtomicMutation(() => {
          user.name = "不应保留的名称";
        }),
      (error: unknown) =>
        error instanceof PersistedStateWriteError && !error.committed
    );
    assert.equal(store.users.find((entry) => entry.id === user.id)?.name, originalName);
    assert.equal(store.sessions.has(sessionToken), true);
    assert.equal(store.draftSessions.has(draftToken), true);
    assert.deepEqual(
      Array.from(store.verificationCodes.entries()),
      verificationCheckpoint
    );

    store.persist = () => {
      throw new PersistedStateWriteError("模拟替换后耐久性未确认", true);
    };
    assert.throws(
      () =>
        store.runAtomicMutation(() => {
          const current = store.users.find((entry) => entry.id === user.id);
          assert.ok(current);
          current.name = "已提交的新名称";
        }),
      (error: unknown) =>
        error instanceof PersistedStateWriteError && error.committed
    );
    assert.equal(
      store.users.find((entry) => entry.id === user.id)?.name,
      "已提交的新名称"
    );
    store.persist = originalPersist;
  });
});

test("相同人工补记请求在货品停用后仍幂等，不同内容仍冲突", async () => {
  await withApi(async ({ baseUrl, store, token }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 4,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const endpoint = `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`;
    const body = {
      items: [{ goodsId: goods.goodsId, quantity: 1 }],
      reason: "平台回调超时，现场盘点确认。",
      confirmed: true
    };
    const submit = (payload: typeof body & { platformOrderNo?: string }) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

    const first = await submit(body);
    assert.equal(first.status, 200);
    const movementCount = store.inventory.filter(
      (entry) => entry.eventId === event.eventId
    ).length;
    const catalogItem = store.goodsCatalog.find(
      (entry) => entry.goodsId === goods.goodsId
    );
    assert.ok(catalogItem);
    catalogItem.status = "inactive";

    const replay = await submit(body);
    assert.equal(replay.status, 200);
    assert.equal(
      store.inventory.filter((entry) => entry.eventId === event.eventId).length,
      movementCount
    );
    const conflict = await submit({
      ...body,
      items: [{ goodsId: goods.goodsId, quantity: 2 }]
    });
    assert.equal(conflict.status, 409);
    const orderConflict = await submit({
      ...body,
      platformOrderNo: `${event.orderNo}-different`
    });
    assert.equal(orderConflict.status, 409);
  });
});

test("跨日处理按可信关门业务日扣减，不占用处理当天额度", async () => {
  await withApi(async ({ baseUrl, store, token, accessRulesService }) => {
    const { event, user, device } = appendClosedSpecialEvent(store);
    const closedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    event.createdAt = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
    event.updatedAt = closedAt;
    const closeLog = store.callbackLog.find(
      (entry) => entry.payload.eventId === event.eventId
    );
    assert.ok(closeLog);
    closeLog.receivedAt = closedAt;
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });
    const usedTodayBefore = accessRulesService.getQuotaSummaryForUser(user).usedCount;

    const response = await fetch(
      `${baseUrl}/cabinet-events/event/${encodeURIComponent(event.eventId)}/manual-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          items: [{ goodsId: goods.goodsId, quantity: 1 }],
          reason: "次日核对上一业务日缺失结算。",
          confirmed: true
        })
      }
    );
    assert.equal(response.status, 200);
    const movement = store.inventory.find(
      (entry) => event.manualSettlement?.movementIds.includes(entry.id)
    );
    assert.equal(movement?.happenedAt, closedAt);
    assert.equal(
      accessRulesService.getQuotaSummaryForUser(user).usedCount,
      usedTodayBefore
    );
  });
});

test("不同实例同订单号的流水不会压制当前事件结算或超时任务", async () => {
  await withApi(async ({
    baseUrl,
    store,
    token,
    alertsService,
    inventoryOrdersService
  }) => {
    const { event, user, device } = appendClosedSpecialEvent(store, 151);
    event.orderNo = "mock-shared-order-normal-settlement";
    const goods = device.doors.flatMap((entry) => entry.goods)[0] ?? store.goodsCatalog[0];
    assert.ok(goods);
    store.ensureDeviceGoodsEntry(device.deviceCode, goods);
    store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity: 3,
      sourceType: "admin",
      sourceUserId: user.id,
      sourceUserName: user.name
    });

    const otherUser = {
      ...structuredClone(user),
      id: "special-other-tenant-settlement-scope",
      phone: "13000009996",
      tenantId: "tenant-other-settlement-scope"
    };
    const otherDevice = {
      ...structuredClone(device),
      deviceCode: "device-other-tenant-settlement-scope",
      tenantId: "tenant-other-settlement-scope"
    };
    const otherEvent = {
      ...structuredClone(event),
      eventId: "event-other-tenant-settlement-scope",
      userId: otherUser.id,
      phone: otherUser.phone,
      deviceCode: otherDevice.deviceCode
    };
    store.users.push(otherUser);
    store.devices.push(otherDevice);
    store.events.push(otherEvent);
    store.inventory.unshift({
      id: "movement-other-tenant-settlement-scope",
      orderNo: event.orderNo,
      eventId: otherEvent.eventId,
      userId: otherUser.id,
      deviceCode: otherDevice.deviceCode,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: 1,
      quotaQuantity: 1,
      unitPrice: goods.price,
      type: "pickup",
      happenedAt: new Date().toISOString()
    });

    alertsService.refreshOperationalTasks();
    assert.equal(
      store.alerts.some(
        (entry) =>
          entry.relatedEventId === event.eventId &&
          entry.title === "结算回调超时待补记"
      ),
      true
    );
    assert.equal(
      inventoryOrdersService.findEventByPlatformOrderNo(event.orderNo),
      undefined
    );
    assert.equal(
      inventoryOrdersService.findEventByPlatformOrderNo(event.orderNo, {
        deviceCode: event.deviceCode
      })?.eventId,
      event.eventId
    );

    const callback = await fetch(`${baseUrl}/cabinet-events/callbacks/settlement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderNo: event.orderNo,
        eventId: event.eventId,
        phone: event.phone,
        deviceCode: event.deviceCode,
        amount: goods.price,
        notifyUrl: "https://smartvm.example.test/api/pay/container/paymentSuccess",
        detail: [{
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: 1,
          unitPrice: goods.price
        }],
        clientId: "smartvm-client",
        nonceStr: "nonce-current-tenant-shared-order",
        timestamp: Math.floor(Date.now() / 1000),
        sign: "local-mock"
      })
    });
    const callbackBody = await callback.json();
    assert.equal(callback.status, 200, JSON.stringify(callbackBody));
    assert.equal(event.paymentNotifyStatus, "pending");
    assert.equal(store.alerts.find((entry) => entry.relatedEventId === event.eventId && entry.title === "结算回调超时待补记")?.status, "open", "有结算流水但仍等待平台完结时，保留提醒");
    assert.equal(
      store.inventory.some(
        (entry) =>
          entry.eventId === event.eventId &&
          entry.type === "pickup"
      ),
      true
    );
  });
});
