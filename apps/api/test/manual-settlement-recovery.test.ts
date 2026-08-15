import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const appendClosedSpecialEvent = (store: InMemoryStoreService) => {
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const device = store.devices.find(
    (entry) => store.getDeviceTenantId(entry) === store.getDefaultTenantId()
  );
  assert.ok(user);
  assert.ok(device);

  const closedAt = new Date(Date.now() - 11 * 60_000).toISOString();
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
    createdAt: new Date(Date.now() - 15 * 60_000).toISOString(),
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

test("实例管理员只会看到可信关门满十分钟且缺少结算的特殊群体事件", async () => {
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
      true
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
    const { event, user, device } = appendClosedSpecialEvent(store);
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
    const { event, user, device } = appendClosedSpecialEvent(store);
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
