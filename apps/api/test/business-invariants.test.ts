import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ConfigService } from "@nestjs/config";
import type {
  CabinetEventRecord,
  CabinetReservationRecord,
  InventoryMovement,
  PaymentOrderRecord,
  PaymentRefundRecord
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersController } from "../src/modules/inventory-orders/inventory-orders.controller";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { MerchantGoodsTemplatesService } from "../src/modules/merchant-goods-templates/merchant-goods-templates.service";
import { PaymentsService } from "../src/modules/payments/payments.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";
import { WarehousesService } from "../src/modules/warehouses/warehouses.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP
};

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-business-invariants-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
};

const toLocalDateKey = (value = new Date()) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const buildEvent = (overrides: Partial<CabinetEventRecord> = {}): CabinetEventRecord => {
  const now = new Date().toISOString();
  return {
    eventId: "event-business-1",
    orderNo: "order-business-1",
    userId: "special-business-1",
    phone: "13800009991",
    role: "special",
    deviceCode: "CAB-BUSINESS-1",
    doorNum: "1",
    status: "settled",
    createdAt: now,
    updatedAt: now,
    amount: 500,
    goods: [],
    ...overrides
  };
};

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("访问规则失败更新保持原值，且每日总额度会约束各品类剩余额度", () => {
  const store = createIsolatedStore();
  const service = new AccessRulesService(store);
  const rule = store.rules.find((entry) => entry.role === "special");
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(rule);
  assert.ok(user);

  const beforeRule = structuredClone(rule);
  assert.throws(
    () =>
      service.update(
        "special",
        {
          dailyLimit: 9,
          categoryLimit: { food: 2, unsupported: 1 }
        },
        store.users.find((entry) => entry.role === "admin")?.id
      ),
    /不支持的货品品类/
  );
  assert.deepEqual(rule, beforeRule);

  user.quota = {
    dailyLimit: 1,
    categoryLimit: { food: 5, drink: 5, daily: 5 }
  };
  store.inventory.unshift({
    id: "movement-daily-limit-used",
    orderNo: "order-daily-limit-used",
    userId: user.id,
    deviceCode: store.devices[0]?.deviceCode ?? "CAB-001",
    goodsId: store.goodsCatalog[0]?.goodsId ?? "goods-1",
    goodsName: store.goodsCatalog[0]?.name ?? "测试货品",
    category: "food",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: new Date().toISOString()
  });

  const summary = service.getQuotaSummaryForUser(user);
  assert.equal(summary.remainingDaily, 0);
  assert.ok(Object.values(summary.remainingToday).every((value) => value === 0));
  assert.ok(Object.values(summary.remainingByGoods).every((value) => value === 0));
});

test("读取预约列表触发过期后会持久化，重载不会重复累计超时", () => {
  const store = createIsolatedStore();
  store.reservations.splice(0, store.reservations.length);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(user);
  user.reservationTimeoutCount = 0;
  user.reservationDisabledAt = undefined;
  user.reservationDisabledReason = undefined;
  const now = new Date();
  const reservation: CabinetReservationRecord = {
    id: "reservation-read-expiry-persistence",
    userId: user.id,
    phone: user.phone,
    userName: user.name,
    deviceCode: "CAB-PERSISTENCE",
    doorNum: "1",
    status: "active",
    inventoryReservationMode: "goods_quantity",
    batchAllocationTiming: "on_open",
    items: [
      {
        goodsId: "goods-persistence",
        goodsName: "持久化测试物资",
        category: "daily",
        quantity: 1
      }
    ],
    reservedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    createdAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    updatedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    timeoutCountAtCreation: 0
  };
  store.reservations.push(reservation);
  store.persist();

  const service = new ReservationsService(store, new AccessRulesService(store));
  const listed = service.list({ id: user.id, role: "special" });
  assert.equal(listed.find((entry) => entry.id === reservation.id)?.status, "expired");
  assert.equal(user.reservationTimeoutCount, 1);

  const reloadedStore = new InMemoryStoreService();
  const reloadedUser = reloadedStore.users.find((entry) => entry.id === user.id);
  assert.equal(
    reloadedStore.reservations.find((entry) => entry.id === reservation.id)?.status,
    "expired"
  );
  assert.equal(reloadedUser?.reservationTimeoutCount, 1);

  new ReservationsService(reloadedStore, new AccessRulesService(reloadedStore)).list({
    id: user.id,
    role: "special"
  });
  const secondReload = new InMemoryStoreService();
  assert.equal(secondReload.users.find((entry) => entry.id === user.id)?.reservationTimeoutCount, 1);
  assert.equal(
    secondReload.logs.filter(
      (entry) =>
        entry.type === "expire-reservation" &&
        entry.metadata?.reservationId === reservation.id
    ).length,
    1
  );
});

test("特殊用户已有待结算或物理状态未决开柜时阻止再次占用额度", () => {
  const store = createIsolatedStore();
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(user);
  const accessRules = new AccessRulesService(store);
  const reservations = new ReservationsService(store, accessRules);
  const pendingEvent = buildEvent({
    eventId: "event-pending-quota",
    orderNo: "order-pending-quota",
    userId: user.id,
    status: "closed",
    billingStatus: "pending",
    billingResolvedAt: undefined,
    paymentNotifyStatus: undefined
  });
  store.events.unshift(pendingEvent);

  assert.throws(
    () => reservations.assertUserCanUseRelatedFeatures(user.id),
    /仍有待完成结算/
  );

  pendingEvent.billingResolvedAt = new Date().toISOString();
  // 旧数据没有 physicalDoorState 时，业务状态 closed 本身就是可信的历史关门语义。
  assert.doesNotThrow(() => reservations.assertUserCanUseRelatedFeatures(user.id));

  pendingEvent.status = "failed";
  pendingEvent.physicalDoorState = "unknown";
  assert.throws(
    () => reservations.assertUserCanUseRelatedFeatures(user.id),
    /仍有待完成结算/
  );
  pendingEvent.physicalDoorState = "closed";
  assert.doesNotThrow(() => reservations.assertUserCanUseRelatedFeatures(user.id));

  pendingEvent.status = "settled";
  pendingEvent.billingStatus = "free";
  pendingEvent.physicalDoorState = "open";
  assert.throws(
    () => reservations.assertUserCanUseRelatedFeatures(user.id),
    /仍有待完成结算/
  );
  pendingEvent.physicalDoorState = "closed";
  assert.doesNotThrow(() => reservations.assertUserCanUseRelatedFeatures(user.id));

  pendingEvent.status = "refunded";
  pendingEvent.physicalDoorState = "open";
  assert.throws(
    () => reservations.assertUserCanUseRelatedFeatures(user.id),
    /仍有待完成结算/
  );
  pendingEvent.physicalDoorState = "closed";
  assert.doesNotThrow(() => reservations.assertUserCanUseRelatedFeatures(user.id));
});

test("服务时段内免费额度用尽后拒绝普通用户继续领取，不进入付费预结算", () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.reservations.splice(0, store.reservations.length);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const device = store.devices[0];
  const door = device?.doors[0];
  const goods = door?.goods[0];
  assert.ok(user);
  assert.ok(device);
  assert.ok(door);
  assert.ok(goods);

  user.quota = {
    dailyLimit: 1,
    categoryLimit: { food: 1, drink: 1, daily: 1 }
  };
  goods.price = 500;
  const catalogGoods = store.goodsCatalog.find((entry) => entry.goodsId === goods.goodsId);
  assert.ok(catalogGoods);
  catalogGoods.price = 500;
  new InventoryBatchChangesService(store).recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 3,
    sourceType: "system"
  });
  store.inventory.unshift({
    id: "movement-paid-after-quota",
    orderNo: "order-paid-after-quota",
    userId: user.id,
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    goodsName: goods.name,
    category: goods.category,
    quantity: 1,
    unitPrice: goods.price,
    type: "pickup",
    happenedAt: new Date().toISOString()
  });
  store.specialAccessPolicies.unshift({
    id: "policy-paid-after-quota",
    name: "额度用尽后的付费预结算",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0,
    endHour: 24,
    goodsLimits: [
      {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        quantity: 1
      }
    ],
    applicableUserIds: [user.id],
    status: "active"
  });
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  const accessRules = new AccessRulesService(store);
  const reservations = new ReservationsService(store, accessRules);
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    {} as SmartVmGateway,
    {} as InventoryOrdersService,
    new AlertsService(store),
    reservations,
    new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "false" })
  );
  assert.throws(
    () =>
      cabinetEvents.previewOpenSettlement(
        {
          phone: user.phone,
          deviceCode: device.deviceCode,
          doorNum: door.doorNum,
          intentItems: [
            {
              goodsId: goods.goodsId,
              goodsName: goods.name,
              category: goods.category,
              quantity: 1
            }
          ]
        },
        { id: user.id, role: "special" }
      ),
    /当前公益物资只支持免费领取，不能进入支付流程/
  );
});

test("预约取货模式要求先预约，且未履约预约会共同占用免费额度", async () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.reservations.splice(0, store.reservations.length);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const device = store.devices[0];
  const door = device?.doors[0];
  const goods = door?.goods[0];
  assert.ok(user);
  assert.ok(device);
  assert.ok(door);
  assert.ok(goods);

  user.quota = {
    dailyLimit: 2,
    categoryLimit: { food: 2, drink: 2, daily: 2 }
  };
  new InventoryBatchChangesService(store).recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 4,
    sourceType: "system"
  });
  store.specialAccessPolicies.unshift({
    id: "policy-reservation-only-pickup",
    name: "预约取货测试策略",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0,
    endHour: 24,
    goodsLimits: [
      {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        quantity: 2
      }
    ],
    applicableUserIds: [user.id],
    status: "active"
  });
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  const config = new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "true" });
  const accessRules = new AccessRulesService(store);
  const reservations = new ReservationsService(store, accessRules, config);
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    {
      async openDoor() {
        return { orderNo: "reservation-only-open-order" };
      }
    } as unknown as SmartVmGateway,
    {} as InventoryOrdersService,
    new AlertsService(store),
    reservations,
    config
  );
  const intentItem = {
    goodsId: goods.goodsId,
    goodsName: goods.name,
    category: goods.category,
    quantity: 1
  };

  assert.throws(
    () =>
      cabinetEvents.previewOpenSettlement(
        {
          phone: user.phone,
          deviceCode: device.deviceCode,
          doorNum: door.doorNum,
          intentItems: [intentItem]
        },
        { id: user.id, role: "special" }
      ),
    /请先预约后再开柜/
  );

  const reservation = reservations.create(
    {
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      intentItems: [intentItem]
    },
    { id: user.id, role: "special" }
  );
  const preview = cabinetEvents.previewOpenSettlement(
    {
      phone: user.phone,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      reservationId: reservation.id,
      intentItems: [intentItem]
    },
    { id: user.id, role: "special" }
  );
  assert.equal(preview.preSettlement?.payableAmount, 0);
  assert.equal(preview.preSettlement?.chargeRequired, false);

  assert.throws(
    () =>
      reservations.create(
        {
          deviceCode: device.deviceCode,
          doorNum: door.doorNum,
          intentItems: [{ ...intentItem, quantity: 2 }]
        },
        { id: user.id, role: "special" }
      ),
    /预约数量超过当前可领取额度/
  );

  await cabinetEvents.openCabinet(
    {
      phone: user.phone,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      reservationId: reservation.id,
      intentItems: [intentItem]
    },
    { id: user.id, role: "special" }
  );
  assert.equal(store.events[0]?.reservationOnlyPickup, true);
});

test("预约取货模式不创建新的支付单或付款人身份授权", async () => {
  const config = new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "true" });
  const payments = new PaymentsService(
    {} as InMemoryStoreService,
    config,
    {} as CabinetEventsService,
    {} as InventoryOrdersService
  );

  await assert.rejects(
    () =>
      payments.createOrder(
        {} as never,
        { id: "special-reservation-only", role: "special" }
      ),
    /不创建新的支付单/
  );
  await assert.rejects(
    () =>
      payments.resolvePayerIdentity(
        {} as never,
        { id: "special-reservation-only", role: "special" }
      ),
    /不创建新的支付单/
  );
});

test("预约和开柜意向只信任所选柜门的后端货品名称与品类", () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.reservations.splice(0, store.reservations.length);
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const device = store.devices[0];
  const door = device?.doors[0];
  const goods = door?.goods[0];
  const secondGoods = door?.goods.find((entry) => entry.goodsId !== goods?.goodsId);
  assert.ok(user);
  assert.ok(device);
  assert.ok(door);
  assert.ok(goods);
  assert.ok(secondGoods);

  if (store.getAvailableStock(device.deviceCode, goods.goodsId) <= 0) {
    inventoryBatchChanges.recordBatchOnly({
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      quantity: 3,
      sourceType: "system"
    });
  }
  const secondGoodsStock = store.getAvailableStock(device.deviceCode, secondGoods.goodsId);
  if (secondGoodsStock <= 0) {
    inventoryBatchChanges.recordBatchOnly({
      deviceCode: device.deviceCode,
      goodsId: secondGoods.goodsId,
      quantity: 1,
      sourceType: "system"
    });
  } else if (secondGoodsStock > 1) {
    inventoryBatchChanges.consumeBatchesOnly({
      deviceCode: device.deviceCode,
      goodsId: secondGoods.goodsId,
      quantity: secondGoodsStock - 1
    });
  }

  const accessRules = {
    assertCanOpenSpecialCabinet() {
      return {
        remainingToday: { food: 10, drink: 10, daily: 10 },
        remainingByGoods: { [goods.goodsId]: 10, [secondGoods.goodsId]: 10 },
        usedCount: 0,
        remainingDaily: 1,
        activeWindows: [{}]
      };
    }
  } as unknown as AccessRulesService;
  const reservations = new ReservationsService(store, accessRules);
  const settingsBeforeInvalidUpdate = structuredClone(store.reservationSettings);
  assert.throws(
    () => reservations.updateSettings({ holdMinutes: 30, maxTimeouts: 99 }),
    /1 到 20/
  );
  assert.deepEqual(store.reservationSettings, settingsBeforeInvalidUpdate);
  assert.throws(
    () => reservations.updateSettings({ enabled: "false" as unknown as boolean }),
    /必须是布尔值/
  );
  const reservation = reservations.create(
    {
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      intentItems: [
        {
          goodsId: goods.goodsId,
          goodsName: "客户端伪造名称",
          category: goods.category === "daily" ? "food" : "daily",
          quantity: 1
        },
        {
          goodsId: secondGoods.goodsId,
          goodsName: "第二个伪造名称",
          category: secondGoods.category === "daily" ? "food" : "daily",
          quantity: 1
        }
      ]
    },
    { id: user.id, role: "special" }
  );

  assert.equal(reservation.items[0]?.goodsName, goods.name);
  assert.equal(reservation.items[0]?.category, goods.category);
  assert.throws(
    () => reservations.getReservationForOpen(user.id, reservation.id, device.deviceCode, "not-the-door"),
    /预约柜门与当前开柜柜门不一致/
  );
  assert.throws(
    () =>
      reservations.create(
        {
          deviceCode: device.deviceCode,
          doorNum: door.doorNum,
          intentItems: [{ goodsId: "unknown-goods", quantity: 1 }]
        },
        { id: user.id, role: "special" }
      ),
    /不属于柜门/
  );

  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    {} as SmartVmGateway,
    {} as InventoryOrdersService,
    new AlertsService(store),
    reservations,
    new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "false" })
  );
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  assert.throws(
    () =>
      cabinetEvents.previewOpenSettlement(
        {
          phone: user.phone,
          deviceCode: device.deviceCode,
          doorNum: door.doorNum,
          intentItems: [{ goodsId: secondGoods.goodsId, quantity: 1 }]
        },
        { id: user.id, role: "special" }
      ),
    /库存不足/
  );
  const preview = cabinetEvents.previewOpenSettlement(
    {
      phone: user.phone,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      reservationId: reservation.id,
      category: goods.category === "daily" ? "food" : "daily",
      intentItems: [
        {
          goodsId: goods.goodsId,
          goodsName: "客户端伪造名称",
          category: goods.category === "daily" ? "food" : "daily",
          quantity: 1
        },
        {
          goodsId: secondGoods.goodsId,
          goodsName: "第二个伪造名称",
          category: secondGoods.category === "daily" ? "food" : "daily",
          quantity: 1
        }
      ]
    },
    { id: user.id, role: "special" }
  );

  assert.equal(preview.acceptedIntentItems[0]?.goodsName, goods.name);
  assert.equal(preview.preSettlement?.items[0]?.category, goods.category);
  assert.equal(preview.acceptedIntentItems[1]?.goodsName, secondGoods.name);
  assert.equal(preview.preSettlement?.freeQuantity, 1);
  assert.equal(preview.preSettlement?.paidQuantity, 1);
});

test("仓库调拨要求正整数，并在后续日志失败时回滚批次、柜机和调拨记录", () => {
  const store = createIsolatedStore();
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, inventoryBatchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const device = store.devices[0];
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(device);
  assert.ok(goods);

  inventoryBatchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 3,
    sourceType: "system"
  });
  const sourceBatch = store
    .getGoodsBatches(warehouse.code, goods.goodsId)
    .find((entry) => entry.remainingQuantity >= 2);
  assert.ok(sourceBatch);

  const beforeInvalid = structuredClone(store.goodsBatches);
  assert.throws(
    () =>
      warehouses.transfer({
        fromCode: warehouse.code,
        toCode: device.deviceCode,
        goodsId: goods.goodsId,
        quantity: 1.5,
        sourceBatchId: sourceBatch.batchId
      }),
    /正整数/
  );
  assert.deepEqual(store.goodsBatches, beforeInvalid);

  const beforeFailure = {
    devices: structuredClone(store.devices),
    goodsBatches: structuredClone(store.goodsBatches),
    inventoryTransfers: structuredClone(store.inventoryTransfers),
    logs: structuredClone(store.logs)
  };
  const originalLogOperation = store.logOperation.bind(store);
  store.logOperation = (() => {
    throw new Error("forced-log-failure");
  }) as typeof store.logOperation;

  assert.throws(
    () =>
      warehouses.transfer({
        fromCode: warehouse.code,
        toCode: device.deviceCode,
        goodsId: goods.goodsId,
        quantity: 2,
        sourceBatchId: sourceBatch.batchId
      }),
    /forced-log-failure/
  );
  store.logOperation = originalLogOperation;

  assert.deepEqual(store.devices, beforeFailure.devices);
  assert.deepEqual(store.goodsBatches, beforeFailure.goodsBatches);
  assert.deepEqual(store.inventoryTransfers, beforeFailure.inventoryTransfers);
  assert.deepEqual(store.logs, beforeFailure.logs);
});

test("商户补货必须绑定本人的已关门入柜事件，失败会回滚库存副作用", () => {
  const store = createIsolatedStore();
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const merchant = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  const device = store.devices[0];
  const goods = store.goodsCatalog[0];
  assert.ok(merchant);
  assert.ok(device);
  assert.ok(goods);
  const templateId = `catalog-${goods.goodsId}`;
  const event = buildEvent({
    eventId: "event-merchant-restock",
    orderNo: "order-merchant-restock",
    userId: merchant.id,
    phone: merchant.phone,
    role: "merchant",
    deviceCode: device.deviceCode,
    doorNum: device.doors[0]?.doorNum ?? "1",
    operationType: "restock",
    hasInboundGoods: true,
    status: "closed",
    amount: 0
  });
  store.events.unshift(event);
  const service = new MerchantGoodsTemplatesService(
    store,
    inventoryBatchChanges,
    new AlertsService(store)
  );

  assert.throws(
    () =>
      service.createRestock(merchant.id, {
        templateId,
        deviceCode: device.deviceCode,
        quantity: 1,
        productionDate: toLocalDateKey(),
        confirmed: true
      }),
    /必须关联.*入柜事件/
  );

  const templatesBeforeInvalidPatch = store.merchantGoodsTemplates.length;
  assert.throws(
    () => service.update(merchant.id, templateId, { defaultQuantity: 0 }),
    /默认数量必须是正整数/
  );
  assert.equal(store.merchantGoodsTemplates.length, templatesBeforeInvalidPatch);

  const systemTemplate = {
    id: "system-template-ownership",
    ownerUserId: "system",
    goodsId: goods.goodsId,
    goodsCode: goods.goodsCode,
    goodsName: goods.name,
    category: goods.category,
    defaultQuantity: 1,
    defaultShelfLifeDays: 2,
    status: "active" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.merchantGoodsTemplates.push(systemTemplate);
  const merchantClone = service.update(merchant.id, systemTemplate.id, {
    goodsName: "商户自己的模板名称"
  });
  assert.notEqual(merchantClone.id, systemTemplate.id);
  assert.equal(merchantClone.ownerUserId, merchant.id);
  assert.equal(systemTemplate.goodsName, goods.name);

  assert.throws(
    () =>
      service.createRestock(merchant.id, {
        templateId,
        deviceCode: device.deviceCode,
        quantity: 1,
        productionDate: "2026-02-30",
        confirmed: true,
        cabinetEventId: event.eventId
      }),
    /生产日期格式不正确/
  );

  const beforeFailure = {
    merchantGoodsTemplates: structuredClone(store.merchantGoodsTemplates),
    goodsCatalog: structuredClone(store.goodsCatalog),
    devices: structuredClone(store.devices),
    goodsBatches: structuredClone(store.goodsBatches),
    inventory: structuredClone(store.inventory),
    logs: structuredClone(store.logs),
    alerts: structuredClone(store.alerts)
  };
  const failingService = new MerchantGoodsTemplatesService(
    store,
    inventoryBatchChanges,
    {
      create() {
        throw new Error("forced-alert-failure");
      }
    } as unknown as AlertsService
  );

  assert.throws(
    () =>
      failingService.createRestock(merchant.id, {
        templateId,
        deviceCode: device.deviceCode,
        quantity: 1,
        productionDate: toLocalDateKey(),
        confirmed: true,
        cabinetEventId: event.eventId
      }),
    /forced-alert-failure/
  );
  assert.deepEqual(store.merchantGoodsTemplates, beforeFailure.merchantGoodsTemplates);
  assert.deepEqual(store.goodsCatalog, beforeFailure.goodsCatalog);
  assert.deepEqual(store.devices, beforeFailure.devices);
  assert.deepEqual(store.goodsBatches, beforeFailure.goodsBatches);
  assert.deepEqual(store.inventory, beforeFailure.inventory);
  assert.deepEqual(store.logs, beforeFailure.logs);
  assert.deepEqual(store.alerts, beforeFailure.alerts);
});

test("旧退款入口仅在全额退款时释放额度，并按退款标识幂等", () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.inventory.splice(0, store.inventory.length);
  store.logs.splice(0, store.logs.length);
  store.alerts.splice(0, store.alerts.length);
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const devices = new DevicesService(store, inventoryBatchChanges, {} as SmartVmGateway);
  const alerts = new AlertsService(store);
  const service = new InventoryOrdersService(
    store,
    inventoryBatchChanges,
    devices,
    alerts,
    new ConfigService({})
  );
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(device);
  assert.ok(goods);
  assert.ok(user);
  const event = buildEvent({
    eventId: "event-refund-full-only",
    orderNo: "order-refund-full-only",
    userId: user.id,
    phone: user.phone,
    deviceCode: device.deviceCode,
    doorNum: device.doors[0]?.doorNum ?? "1",
    amount: 500,
    paymentNotifyStatus: "success",
    paymentTransactionId: "refund-transaction-full",
    goods: [
      {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        quantity: 1,
        unitPrice: 500
      }
    ]
  });
  store.events.push(event);
  const pickup: InventoryMovement = {
    id: "movement-refund-pickup",
    orderNo: event.orderNo,
    eventId: event.eventId,
    userId: user.id,
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    goodsName: goods.name,
    category: goods.category,
    quantity: 1,
    unitPrice: 500,
    type: "pickup",
    happenedAt: new Date().toISOString()
  };
  store.inventory.push(pickup);

  assert.throws(
    () =>
      service.markRefund(event.orderNo, "refund-transaction-full", 100, {
        source: "manual",
        refundNo: "refund-no-partial",
        deviceCode: device.deviceCode
      }),
    /仅支持整单全额退款/
  );
  assert.equal(event.status, "settled");
  assert.equal(store.inventory.filter((entry) => entry.type === "refund").length, 0);

  assert.throws(
    () =>
      service.previewRefund(event.orderNo, "refund-transaction-full", 500, {
        refundNo: "refund-no-device",
        deviceCode: "another-device"
      }),
    /退款订单与柜机不匹配/
  );

  const first = service.markRefund(event.orderNo, "refund-transaction-full", 500, {
    source: "manual",
    refundNo: "refund-no-full",
    deviceCode: device.deviceCode
  });
  assert.equal(first.movements.length, 1);
  assert.equal(event.status, "refunded");
  assert.equal(store.inventory.filter((entry) => entry.type === "refund").length, 1);

  const replay = service.markRefund(event.orderNo, "refund-transaction-full", 500, {
    source: "callback",
    refundNo: "refund-no-full",
    deviceCode: device.deviceCode
  });
  assert.equal("duplicated" in replay && replay.duplicated, true);
  assert.equal(store.inventory.filter((entry) => entry.type === "refund").length, 1);
  assert.equal(store.alerts.filter((entry) => entry.relatedEventId === event.eventId).length, 1);

  const rollbackEvent = buildEvent({
    eventId: "event-refund-rollback",
    orderNo: "order-refund-rollback",
    userId: user.id,
    phone: user.phone,
    deviceCode: device.deviceCode,
    amount: 500,
    paymentNotifyStatus: "success",
    paymentTransactionId: "refund-transaction-rollback",
    goods: event.goods
  });
  store.events.push(rollbackEvent);
  const rollbackBefore = {
    events: structuredClone(store.events),
    inventory: structuredClone(store.inventory),
    logs: structuredClone(store.logs),
    alerts: structuredClone(store.alerts)
  };
  const failingService = new InventoryOrdersService(
    store,
    inventoryBatchChanges,
    devices,
    {
      create() {
        throw new Error("forced-refund-alert-failure");
      }
    } as unknown as AlertsService,
    new ConfigService({})
  );
  assert.throws(
    () =>
      failingService.markRefund(rollbackEvent.orderNo, "refund-transaction-rollback", 500, {
        source: "manual",
        refundNo: "refund-no-rollback",
        deviceCode: device.deviceCode
      }),
    /forced-refund-alert-failure/
  );
  assert.deepEqual(store.events, rollbackBefore.events);
  assert.deepEqual(store.inventory, rollbackBefore.inventory);
  assert.deepEqual(store.logs, rollbackBefore.logs);
  assert.deepEqual(store.alerts, rollbackBefore.alerts);
});

test("管理员解决用户反馈后，处理结果只回流给反馈发起人", () => {
  const store = createIsolatedStore();
  store.alerts.splice(0, store.alerts.length);
  const alerts = new AlertsService(store);
  const user = store.users.find((entry) => entry.role === "special");
  const admin = store.users.find((entry) => entry.role === "admin");
  assert.ok(user);
  assert.ok(admin);

  const feedback = alerts.createFeedbackTask({
    detail: "柜门关闭后页面仍显示处理中，请协助核查。",
    feedbackType: "机器故障",
    targetUserId: user.id,
    sourceKey: user.id
  });
  const resolved = alerts.resolve(feedback.id, admin.id, "已核对柜门事件，状态已恢复。");

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.targetUserId, user.id);
  assert.equal(resolved.userNoticeStatus, "pending");
  assert.equal(resolved.userNoticeTitle, "反馈处理结果");
  assert.match(resolved.userNoticeContent ?? "", /已核对柜门事件，状态已恢复/);
  assert.ok(alerts.list(undefined, user.id).some((entry) => entry.id === feedback.id));
  assert.ok(!alerts.list(undefined, "unrelated-user").some((entry) => entry.id === feedback.id));
});

test("柜机详情在刷新后返回待确认退款恢复摘要且不泄露渠道原始报文", () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.paymentOrders.splice(0, store.paymentOrders.length);
  store.paymentRefunds.splice(0, store.paymentRefunds.length);
  const device = store.devices[0];
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(device);
  assert.ok(user);
  const now = new Date().toISOString();
  const event = buildEvent({
    eventId: "event-pending-refund-recovery",
    orderNo: "order-pending-refund-recovery",
    userId: user.id,
    phone: user.phone,
    deviceCode: device.deviceCode,
    doorNum: device.doors[0]?.doorNum ?? "1",
    amount: 500,
    paymentNotifyStatus: "success",
    paymentTransactionId: "transaction-pending-refund-recovery"
  });
  const paymentOrder: PaymentOrderRecord = {
    id: "payment-order-pending-refund-recovery",
    paymentNo: "wx-pending-refund-recovery",
    provider: "wechat",
    phase: "post_settlement",
    status: "paid",
    amount: 500,
    currency: "CNY",
    subject: "待确认退款恢复测试",
    eventId: event.eventId,
    orderNo: event.orderNo,
    deviceCode: event.deviceCode,
    providerTransactionId: event.paymentTransactionId,
    createdAt: now,
    updatedAt: now,
    paidAt: now
  };
  const refund: PaymentRefundRecord = {
    id: "payment-refund-pending-recovery",
    paymentOrderId: paymentOrder.id,
    paymentNo: paymentOrder.paymentNo,
    refundNo: "wxr-pending-refund-recovery",
    provider: "wechat",
    status: "pending",
    amount: 500,
    businessOrderNo: event.orderNo,
    sourceRequestId: "backoffice-pending-refund-recovery",
    providerOutcome: "unknown",
    businessApplyState: "pending",
    callbackPayload: {
      payerOpenId: "不得出现在柜机详情",
      rawProviderResponse: "不得出现在柜机详情"
    },
    createdAt: now,
    updatedAt: now
  };
  store.events.push(event);
  store.paymentOrders.push(paymentOrder);
  store.paymentRefunds.push(refund);
  const devices = new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    {} as SmartVmGateway
  );

  const detail = devices.monitoringDetail(device.deviceCode);
  const recovery = detail.recentEvents[0]?.paymentRecovery?.pendingRefund;

  assert.equal(recovery?.id, refund.id);
  assert.equal(recovery?.refundNo, refund.refundNo);
  assert.equal(recovery?.sourceRequestId, refund.sourceRequestId);
  assert.equal(recovery?.amount, refund.amount);
  assert.equal("callbackPayload" in (recovery ?? {}), false);
  assert.equal(event.paymentRecovery, undefined);
});

test("InventoryOrdersController 不再暴露旧退款方法或路由", () => {
  const controllerMethods = Object.getOwnPropertyNames(InventoryOrdersController.prototype)
    .filter((name) => name !== "constructor");

  assert.equal(controllerMethods.includes("refund"), false);
  assert.deepEqual(controllerMethods.sort(), ["list", "merchantSummary"]);
});

test("旧退款明确拒绝状态落盘失败时恢复待确认锁", () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.inventory.splice(0, store.inventory.length);
  store.logs.splice(0, store.logs.length);
  store.alerts.splice(0, store.alerts.length);
  const device = store.devices[0];
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(device);
  assert.ok(user);
  const transactionId = "refund-transaction-failed-persist-rollback";
  const refundNo = "refund-no-failed-persist-rollback";
  const event = buildEvent({
    eventId: "event-refund-failed-persist-rollback",
    orderNo: "order-refund-failed-persist-rollback",
    userId: user.id,
    phone: user.phone,
    deviceCode: device.deviceCode,
    doorNum: device.doors[0]?.doorNum ?? "1",
    amount: 500,
    paymentNotifyStatus: "success",
    paymentTransactionId: transactionId
  });
  store.events.push(event);
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const smartVmGateway = {} as SmartVmGateway;
  const service = new InventoryOrdersService(
    store,
    inventoryBatchChanges,
    new DevicesService(store, inventoryBatchChanges, smartVmGateway),
    new AlertsService(store),
    new ConfigService({})
  );
  service.reserveRefundIntent(event.orderNo, transactionId, 500, {
    refundNo,
    deviceCode: event.deviceCode
  });

  const originalPersist = store.persist.bind(store);
  store.persist = () => {
    throw new Error("forced-failed-status-persist-failure");
  };
  assert.throws(
    () => service.failManualRefundIntent(event.orderNo, transactionId, refundNo),
    /forced-failed-status-persist-failure/
  );
  const intent = store.logs.find(
    (entry) =>
      entry.type === "manual-refund-intent" &&
      entry.metadata?.refundNo === refundNo
  );
  assert.equal(intent?.status, "pending");
  assert.equal(intent?.metadata?.outcome, undefined);
  assert.equal(intent?.metadata?.failedAt, undefined);

  store.persist = originalPersist;
  assert.equal(
    service.failManualRefundIntent(event.orderNo, transactionId, refundNo),
    true
  );
  assert.equal(intent?.status, "failed");
});

test("旧退款回调标识与待确认意图不一致时保留原锁并生成核对告警", () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.inventory.splice(0, store.inventory.length);
  store.logs.splice(0, store.logs.length);
  store.alerts.splice(0, store.alerts.length);
  const device = store.devices[0];
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(device);
  assert.ok(user);
  const originalTransactionId = "refund-transaction-original-intent";
  const callbackTransactionId = "refund-transaction-different-callback";
  const event = buildEvent({
    eventId: "event-refund-intent-mismatch",
    orderNo: "order-refund-intent-mismatch",
    userId: user.id,
    phone: user.phone,
    deviceCode: device.deviceCode,
    doorNum: device.doors[0]?.doorNum ?? "1",
    amount: 500,
    paymentNotifyStatus: "success",
    paymentTransactionId: originalTransactionId
  });
  store.events.push(event);
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const smartVmGateway = {} as SmartVmGateway;
  const service = new InventoryOrdersService(
    store,
    inventoryBatchChanges,
    new DevicesService(store, inventoryBatchChanges, smartVmGateway),
    new AlertsService(store),
    new ConfigService({})
  );

  service.reserveRefundIntent(
    event.orderNo,
    originalTransactionId,
    500,
    {
      refundNo: "refund-no-original-intent",
      deviceCode: event.deviceCode
    }
  );
  const inventoryBeforeCallback = structuredClone(store.inventory);
  event.paymentTransactionId = callbackTransactionId;
  assert.throws(
    () =>
      service.markRefund(event.orderNo, callbackTransactionId, 500, {
        source: "callback",
        refundNo: "refund-no-different-callback",
        deviceCode: event.deviceCode
      }),
    /标识不一致/
  );

  assert.equal(event.status, "settled");
  assert.equal(event.refundedAt, undefined);
  assert.deepEqual(store.inventory, inventoryBeforeCallback);
  assert.equal(store.inventory.filter((entry) => entry.type === "refund").length, 0);
  assert.equal(
    store.logs.find(
      (entry) =>
        entry.type === "manual-refund-intent" &&
        entry.relatedOrderNo === event.orderNo
    )?.status,
    "pending"
  );
  assert.equal(
    store.logs.filter(
      (entry) =>
        entry.type === "manual-refund-intent-identity-conflict" &&
        entry.relatedOrderNo === event.orderNo
    ).length,
    1
  );
  assert.equal(
    store.alerts.filter(
      (entry) =>
        entry.relatedEventId === event.eventId &&
        entry.title === "退款回调与待确认意图不一致"
    ).length,
    1
  );
});

test("库存批次核心拒绝负数、小数和错误来源批次", () => {
  const store = createIsolatedStore();
  const service = new InventoryBatchChangesService(store);
  const warehouse = store.warehouses[0];
  const device = store.devices[0];
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(device);
  assert.ok(goods);

  const before = structuredClone(store.goodsBatches);
  assert.throws(
    () =>
      service.recordBatchOnly({
        deviceCode: warehouse.code,
        goodsId: goods.goodsId,
        quantity: -1,
        sourceType: "system"
      }),
    /正整数/
  );
  assert.deepEqual(store.goodsBatches, before);

  service.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 2,
    sourceType: "system"
  });
  const sourceBatch = store.getGoodsBatches(warehouse.code, goods.goodsId)[0];
  assert.ok(sourceBatch);
  assert.throws(
    () =>
      service.recordSpecificBatchDeduction({
        batchId: sourceBatch.batchId,
        quantity: 3,
        movement: {
          id: "movement-over-deduction",
          userId: "admin-test",
          deviceCode: warehouse.code,
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          quantity: 3,
          unitPrice: goods.price,
          type: "manual-deduction",
          happenedAt: new Date().toISOString()
        }
      }),
    /指定批次库存不足/
  );
  assert.equal(sourceBatch.remainingQuantity, 2);
  const devicesBeforeMismatch = structuredClone(store.devices);
  assert.throws(
    () =>
      service.recordTransfer({
        id: "transfer-wrong-source",
        from: { type: "device", code: device.deviceCode, name: device.name },
        to: { type: "warehouse", code: warehouse.code, name: warehouse.name },
        goods,
        quantity: 1,
        sourceBatchId: sourceBatch.batchId,
        happenedAt: new Date().toISOString()
      }),
    /来源批次/
  );
  assert.deepEqual(store.devices, devicesBeforeMismatch);
  assert.equal(sourceBatch.remainingQuantity, 2);
});
