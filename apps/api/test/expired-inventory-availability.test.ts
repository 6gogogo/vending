import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ConfigService } from "@nestjs/config";
import type { InventoryMovement } from "@vm/shared-types";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";
import { UsersService } from "../src/modules/users/users.service";
import { WarehousesService } from "../src/modules/warehouses/warehouses.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP
};

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-expired-inventory-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
};

const removeGoodsBatches = (
  store: InMemoryStoreService,
  deviceCode: string,
  goodsId: string
) => {
  for (let index = store.goodsBatches.length - 1; index >= 0; index -= 1) {
    const batch = store.goodsBatches[index];

    if (batch.deviceCode === deviceCode && batch.goodsId === goodsId) {
      store.goodsBatches.splice(index, 1);
    }
  }

  store.syncDeviceStocksFromBatches(deviceCode);
};

const createMovement = (
  store: InMemoryStoreService,
  deviceCode: string,
  goodsId: string,
  quantity: number,
  id: string
): InventoryMovement => {
  const goods = store.goodsCatalog.find((entry) => entry.goodsId === goodsId);
  assert.ok(goods);

  return {
    id,
    userId: store.users.find((entry) => entry.role === "special")?.id ?? "special-expiry-test",
    deviceCode,
    goodsId,
    goodsName: goods.name,
    category: goods.category,
    quantity,
    unitPrice: goods.price,
    type: "pickup",
    happenedAt: new Date().toISOString()
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

test("批次到期边界采用 expiresAt > now，管理总库存仍保留过期批次", () => {
  const store = createIsolatedStore();
  const service = new InventoryBatchChangesService(store);
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);

  const now = Date.now();
  const past = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1,
    expiresAt: new Date(now - 1).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const exact = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1,
    expiresAt: new Date(now).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const future = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1,
    expiresAt: new Date(now + 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const noExpiry = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1,
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(past);
  assert.ok(exact);
  assert.ok(future);
  assert.ok(noExpiry);

  assert.equal(store.isGoodsBatchAvailable(past, now), false);
  assert.equal(store.isGoodsBatchAvailable(exact, now), false);
  assert.equal(store.isGoodsBatchAvailable(future, now), true);
  assert.equal(store.isGoodsBatchAvailable(noExpiry, now), true);
  assert.equal(store.getCurrentStock(device.deviceCode, goods.goodsId), 4);
  assert.equal(store.getAvailableStock(device.deviceCode, goods.goodsId, now), 2);
  assert.equal(store.getGoodsBatches(device.deviceCode, goods.goodsId).length, 4);

  const devices = new DevicesService(store, service, {} as never);
  const specialView = devices.list(undefined, "special").find((entry) => entry.deviceCode === device.deviceCode);
  const adminView = devices.list(undefined, "admin").find((entry) => entry.deviceCode === device.deviceCode);
  const specialGoods = specialView?.doors.flatMap((door) => door.goods).find((entry) => entry.goodsId === goods.goodsId);
  const adminGoods = adminView?.doors.flatMap((door) => door.goods).find((entry) => entry.goodsId === goods.goodsId);
  assert.equal(specialGoods?.stock, 2);
  assert.equal(adminGoods?.stock, 4);
});

test("可领取库存先抵扣既有负库存，补货后不会高估用户可领取数量", () => {
  const store = createIsolatedStore();
  const service = new InventoryBatchChangesService(store);
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);

  service.recordConsumptiveMovement({
    movement: createMovement(store, device.deviceCode, goods.goodsId, 3, "movement-negative-balance")
  });
  service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 10,
    expiresAt: new Date().toISOString(),
    sourceType: "system"
  });
  service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceType: "system"
  });

  assert.equal(store.getCurrentStock(device.deviceCode, goods.goodsId), 12);
  assert.equal(store.getAvailableStock(device.deviceCode, goods.goodsId), 2);

  const devices = new DevicesService(store, service, {} as never);
  const specialGoods = devices
    .list(undefined, "special")
    .find((entry) => entry.deviceCode === device.deviceCode)
    ?.doors.flatMap((door) => door.goods)
    .find((entry) => entry.goodsId === goods.goodsId);
  assert.equal(specialGoods?.stock, 2);
});

test("特殊用户货品查询回退时同步隐藏过期批次的到期时间", async () => {
  const store = createIsolatedStore();
  const service = new InventoryBatchChangesService(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const goods = door?.goods[0];
  assert.ok(device);
  assert.ok(door);
  assert.ok(goods);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);

  service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 4,
    expiresAt: new Date().toISOString(),
    sourceType: "system"
  });
  const availableExpiryAt = new Date(Date.now() + 60_000).toISOString();
  service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: availableExpiryAt,
    sourceType: "system"
  });

  const devices = new DevicesService(
    store,
    service,
    {
      async getGoodsInfo() {
        throw new Error("强制使用本地回退");
      }
    } as never
  );
  const result = await devices.getGoods(device.deviceCode, door.doorNum, "special");
  const resultGoods = result.find((entry) => entry.goodsId === goods.goodsId);

  assert.equal(resultGoods?.stock, 2);
  assert.equal(resultGoods?.expiresAt, availableExpiryAt);
});

test("只读货品查询不把远端返回写入全局目录或柜机本地配置", async () => {
  const store = createIsolatedStore();
  const batches = new InventoryBatchChangesService(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const localGoods = door?.goods[0];
  assert.ok(device);
  assert.ok(door);
  assert.ok(localGoods);
  const beforeCatalog = structuredClone(store.goodsCatalog);
  const beforeDevices = structuredClone(store.devices);
  const devices = new DevicesService(
    store,
    batches,
    {
      async getGoodsInfo() {
        return [
          {
            ...structuredClone(localGoods),
            name: "远端临时名称",
            price: localGoods.price + 100
          },
          {
            goodsCode: "REMOTE-ONLY-001",
            goodsId: "remote-only-001",
            name: "仅远端存在的货品",
            category: "daily",
            price: 500,
            imageUrl: "https://example.test/remote-only.png",
            stock: 9
          }
        ];
      }
    } as never
  );

  const result = await devices.getGoods(
    device.deviceCode,
    door.doorNum,
    "special"
  );

  assert.ok(result.some((entry) => entry.goodsId === localGoods.goodsId));
  assert.deepEqual(store.goodsCatalog, beforeCatalog);
  assert.deepEqual(store.devices, beforeDevices);
});

test("预约、预结算和正式开柜都拒绝只有过期批次的货品，无到期批次仍可预约", async () => {
  const store = createIsolatedStore();
  store.events.splice(0, store.events.length);
  store.reservations.splice(0, store.reservations.length);
  const batches = new InventoryBatchChangesService(store);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const device = store.devices[0];
  const door = device?.doors[0];
  const goods = door?.goods[0];
  assert.ok(user);
  assert.ok(device);
  assert.ok(door);
  assert.ok(goods);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);
  batches.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 3,
    expiresAt: new Date().toISOString(),
    sourceType: "system"
  });

  const accessRules = {
    assertCanOpenSpecialCabinet() {
      return {
        remainingToday: { food: 10, drink: 10, daily: 10 },
        remainingByGoods: { [goods.goodsId]: 10 },
        usedCount: 0,
        remainingDaily: 10,
        activeWindows: [{}]
      };
    }
  } as unknown as AccessRulesService;
  const reservations = new ReservationsService(store, accessRules);
  let gatewayCalls = 0;
  let allowOpen = false;
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    {
      async openDoor() {
        gatewayCalls += 1;
        if (!allowOpen) {
          throw new Error("库存检查应先于柜机调用");
        }

        return { orderNo: "reservation-dynamic-batch-order" };
      },
      verifySignedPayload: () => true,
      isUsingMockTransport: () => false
    } as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    reservations,
    new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "false" })
  );
  const payload = {
    phone: user.phone,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    intentItems: [{ goodsId: goods.goodsId, quantity: 1 }]
  };

  assert.throws(
    () => reservations.create(payload, { id: user.id, role: "special" }),
    /库存不足/
  );
  assert.throws(
    () => cabinetEvents.previewOpenSettlement(payload, { id: user.id, role: "special" }),
    /库存不足/
  );
  await assert.rejects(
    cabinetEvents.openCabinet(payload, { id: user.id, role: "special" }),
    /库存不足/
  );
  assert.equal(gatewayCalls, 0);

  const initiallyAvailableBatch = batches.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1,
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(initiallyAvailableBatch);
  const reservation = reservations.create(payload, { id: user.id, role: "special" });
  assert.equal(reservation.status, "active");
  assert.equal(reservation.inventoryReservationMode, "goods_quantity");
  assert.equal(reservation.batchAllocationTiming, "on_open");

  // 预约期间原有批次失效时，不把预约误标为已履约，也绝不下发开门命令。
  initiallyAvailableBatch.expiresAt = new Date().toISOString();
  await assert.rejects(
    cabinetEvents.openCabinet(
      { ...payload, reservationId: reservation.id },
      { id: user.id, role: "special" }
    ),
    /库存不足/
  );
  assert.equal(gatewayCalls, 0);
  assert.equal(reservation.status, "active");

  // 后续补入另一个有效批次后，同一预约可按开柜时的有效库存继续履约。
  batches.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceType: "system"
  });
  allowOpen = true;
  const opened = await cabinetEvents.openCabinet(
    { ...payload, reservationId: reservation.id },
    { id: user.id, role: "special" }
  );
  assert.equal(opened.reservationId, reservation.id);
  assert.equal(gatewayCalls, 1);
  assert.equal(reservation.status, "active");

  cabinetEvents.handleDoorStatus({
    eventId: opened.eventId,
    deviceCode: device.deviceCode,
    status: "SUCCESS",
    clientId: "trusted-smartvm",
    nonceStr: "reservation-open-success",
    timestamp: Math.floor(Date.now() / 1000),
    sign: "verified"
  });
  assert.equal(reservation.status, "fulfilled");
});

test("指定过期批次立即拒绝且不回退，自动 FEFO 只消耗未来或无到期批次", () => {
  const store = createIsolatedStore();
  const service = new InventoryBatchChangesService(store);
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);

  const expired = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 5,
    expiresAt: new Date().toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const future = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const noExpiry = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 2,
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);
  assert.ok(future);
  assert.ok(noExpiry);

  const before = structuredClone(store.goodsBatches);
  assert.throws(
    () =>
      service.recordConsumptiveMovement({
        movement: createMovement(store, device.deviceCode, goods.goodsId, 1, "movement-expired-specified"),
        requestedBatches: [{ batchId: expired.batchId, quantity: 1 }]
      }),
    /指定批次已到期/
  );
  assert.deepEqual(store.goodsBatches, before);
  assert.equal(store.inventory.some((entry) => entry.id === "movement-expired-specified"), false);

  const consumed = service.recordConsumptiveMovement({
    movement: createMovement(store, device.deviceCode, goods.goodsId, 3, "movement-fefo-available-only")
  });
  assert.deepEqual(
    consumed.consumedBatches.map((entry) => [entry.batchId, entry.quantity]),
    [
      [future.batchId, 2],
      [noExpiry.batchId, 1]
    ]
  );
  assert.equal(expired.remainingQuantity, 5);
  assert.equal(future.remainingQuantity, 0);
  assert.equal(noExpiry.remainingQuantity, 1);
});

test("自动 FEFO 按绝对到期时刻排序不同 UTC 偏移格式", () => {
  const store = createIsolatedStore();
  const service = new InventoryBatchChangesService(store);
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);

  const earlier = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: "2099-08-01T01:00:00+08:00",
    sourceType: "system"
  }).createdBatches[0];
  const later = service.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: "2099-07-31T18:00:00Z",
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(earlier);
  assert.ok(later);
  assert.ok(Date.parse(earlier.expiresAt!) < Date.parse(later.expiresAt!));

  const consumed = service.recordConsumptiveMovement({
    movement: createMovement(store, device.deviceCode, goods.goodsId, 3, "movement-offset-fefo")
  });

  assert.deepEqual(
    consumed.consumedBatches.map((entry) => [entry.batchId, entry.quantity]),
    [
      [earlier.batchId, 2],
      [later.batchId, 1]
    ]
  );
});

test("仓库和柜机正常调拨保留过期批次记录，但指定与自动路径都不会使用它", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const device = store.devices[0];
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);

  const expired = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 5,
    expiresAt: new Date().toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const future = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);
  assert.ok(future);
  const beforeSpecified = structuredClone(store.goodsBatches);

  assert.throws(
    () =>
      warehouses.transfer({
        fromCode: warehouse.code,
        toCode: device.deviceCode,
        goodsId: goods.goodsId,
        quantity: 1,
        sourceBatchId: expired.batchId
      }),
    /已到期/
  );
  assert.deepEqual(store.goodsBatches, beforeSpecified);

  const transferred = warehouses.transfer({
    fromCode: warehouse.code,
    toCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 1
  });
  assert.equal(transferred.batches?.[0]?.sourceBatchId, future.batchId);
  assert.equal(expired.remainingQuantity, 5);
  assert.equal(future.remainingQuantity, 1);

  const inventory = warehouses.getInventory();
  assert.ok(inventory.availableBatches.some((entry) => entry.batchId === expired.batchId));
  assert.ok(
    inventory.items
      .find((entry) => entry.goodsId === goods.goodsId)
      ?.batches.some((entry) => entry.batchId === expired.batchId)
  );
});

test("仓库库存快照明确区分实物、可调拨和过期待处置批次", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(goods);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);

  const expired = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 3,
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const transferable = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);
  assert.ok(transferable);

  const snapshot = warehouses.getInventory();

  assert.equal(snapshot.physicalTotalStock, 8);
  assert.equal(snapshot.transferableTotalStock, 5);
  assert.equal(snapshot.expiredTotalStock, 3);
  const warehouseGoodsBatchIds = (batches: typeof snapshot.physicalBatches) =>
    batches
      .filter(
        (entry) => entry.deviceCode === warehouse.code && entry.goodsId === goods.goodsId
      )
      .map((entry) => entry.batchId);

  assert.deepEqual(warehouseGoodsBatchIds(snapshot.physicalBatches), [
    expired.batchId,
    transferable.batchId
  ]);
  assert.deepEqual(warehouseGoodsBatchIds(snapshot.transferableBatches), [transferable.batchId]);
  assert.deepEqual(warehouseGoodsBatchIds(snapshot.expiredBatches), [expired.batchId]);
  assert.deepEqual(snapshot.availableBatches, snapshot.physicalBatches);
});

test("管理员确认后可按批次精确处置过期物资并留下业务记录", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const goods = store.goodsCatalog[0];
  const actor = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  assert.ok(warehouse);
  assert.ok(goods);
  assert.ok(actor);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);
  const expired = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 4,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);

  const disposition = warehouses.disposeExpiredBatch(
    expired.batchId,
    {
      confirmed: true,
      quantity: 2,
      method: "destroy",
      reason: "包装破损，按社区流程销毁"
    },
    actor.id
  );

  assert.equal(disposition.batchId, expired.batchId);
  assert.equal(disposition.quantity, 2);
  assert.equal(disposition.remainingQuantity, 2);
  assert.equal(expired.remainingQuantity, 2);
  assert.equal(store.expiredBatchDispositions[0]?.id, disposition.id);
  assert.ok(
    store.inventory.some(
      (entry) =>
        entry.id === disposition.movementId &&
        entry.type === "expired" &&
        entry.batchId === expired.batchId &&
        entry.quantity === 2
    )
  );
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "dispose-expired-batch" &&
        entry.metadata?.batchId === expired.batchId &&
        entry.metadata?.quantity === 2
    )
  );
});

test("过期批次处置按幂等键返回同一结果且重启后仍然有效", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(goods);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);
  const expired = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 3,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);
  const request = {
    confirmed: true,
    quantity: 1,
    method: "return_supplier" as const,
    reason: "按供应商召回流程退回",
    idempotencyKey: "expired-disposition-retry-001"
  };

  const first = warehouses.disposeExpiredBatch(expired.batchId, request);
  store.persist();
  const reopenedStore = new InMemoryStoreService();
  const reopenedService = new WarehousesService(
    reopenedStore,
    new InventoryBatchChangesService(reopenedStore)
  );
  const retried = reopenedService.disposeExpiredBatch(expired.batchId, request);

  assert.equal(retried.id, first.id);
  assert.equal(reopenedStore.goodsBatches.find((entry) => entry.batchId === expired.batchId)?.remainingQuantity, 2);
  assert.equal(reopenedStore.expiredBatchDispositions.length, 1);
});

test("过期批次处置拒绝未确认、非法字段、未过期批次和超量请求", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(goods);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);
  const expired = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  const future = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);
  assert.ok(future);
  const valid = {
    confirmed: true,
    quantity: 1,
    method: "destroy" as const,
    reason: "按流程销毁"
  };
  const before = structuredClone(store.goodsBatches);

  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, confirmed: false }),
    /必须完成最终确认/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, quantity: 0 }),
    /正整数/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, quantity: 1.5 }),
    /正整数/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, reason: " " }),
    /处置理由/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, reason: "过".repeat(301) }),
    /不能超过 300/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, method: "unknown" as never }),
    /处置方式/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(expired.batchId, { ...valid, quantity: 3 }),
    /不能超过/
  );
  assert.throws(
    () => warehouses.disposeExpiredBatch(future.batchId, valid),
    /尚未过期/
  );
  assert.deepEqual(store.goodsBatches, before);
  assert.equal(store.expiredBatchDispositions.length, 0);
});

test("过期批次处置记录失败时回滚批次库存和操作日志", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(goods);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);
  const expired = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);
  const beforeBatches = structuredClone(store.goodsBatches);
  const beforeInventory = structuredClone(store.inventory);
  const beforeConsumptionTraces = structuredClone(store.batchConsumptionTraces);
  const beforeLogs = structuredClone(store.logs);
  const originalLogOperation = store.logOperation.bind(store);
  store.logOperation = (() => {
    throw new Error("模拟操作日志写入失败");
  }) as typeof store.logOperation;

  try {
    assert.throws(
      () =>
        warehouses.disposeExpiredBatch(expired.batchId, {
          confirmed: true,
          quantity: 1,
          method: "other",
          reason: "测试事务回滚"
        }),
      /模拟操作日志写入失败/
    );
  } finally {
    store.logOperation = originalLogOperation;
  }

  assert.deepEqual(store.goodsBatches, beforeBatches);
  assert.deepEqual(store.inventory, beforeInventory);
  assert.deepEqual(store.batchConsumptionTraces, beforeConsumptionTraces);
  assert.deepEqual(store.logs, beforeLogs);
  assert.equal(store.expiredBatchDispositions.length, 0);
});

test("正常调拨的可用性校验与批次扣减共用同一事务时刻", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouse = store.warehouses.find((entry) => entry.status === "active");
  const device = store.devices[0];
  const goods = store.goodsCatalog[0];
  assert.ok(warehouse);
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, warehouse.code, goods.goodsId);

  const expiresAtMs = Date.now() + 60_000;
  const source = batchChanges.recordBatchOnly({
    deviceCode: warehouse.code,
    goodsId: goods.goodsId,
    quantity: 1,
    expiresAt: new Date(expiresAtMs).toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(source);

  const originalNow = Date.now;
  let nowCalls = 0;

  try {
    Date.now = () => (nowCalls++ === 0 ? expiresAtMs - 1 : expiresAtMs);
    const result = batchChanges.recordTransfer({
      id: "transfer-expiry-transaction-time",
      from: { type: "warehouse", code: warehouse.code, name: warehouse.name },
      to: { type: "device", code: device.deviceCode, name: device.name },
      goods,
      quantity: 1,
      happenedAt: new Date().toISOString()
    });

    assert.deepEqual(result.consumedBatches.map((entry) => entry.batchId), [source.batchId]);
    assert.equal(
      result.consumedBatches.some((entry) => entry.selectionReason === "negative_balance"),
      false
    );
    assert.equal(result.createdBatches[0]?.expiresAt, source.expiresAt);
  } finally {
    Date.now = originalNow;
  }
});

test("管理员手工补扣可处置过期批次并保留库存流水审计", () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const devices = new DevicesService(store, batchChanges, {} as never);
  const users = new UsersService(store, batchChanges, devices);
  const targetUser = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const actor = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(targetUser);
  assert.ok(actor);
  assert.ok(device);
  assert.ok(goods);
  removeGoodsBatches(store, device.deviceCode, goods.goodsId);

  const expired = batchChanges.recordBatchOnly({
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    quantity: 2,
    expiresAt: new Date().toISOString(),
    sourceType: "system"
  }).createdBatches[0];
  assert.ok(expired);

  const movement = users.manualAdjustment(
    targetUser.id,
    {
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      quantity: 1,
      direction: "deduct",
      confirmed: true,
      batchConsumptions: [{ batchId: expired.batchId, quantity: 1 }],
      note: "处置过期批次"
    },
    actor.id,
    "super_admin"
  );

  assert.equal(movement.type, "manual-deduction");
  assert.equal(expired.remainingQuantity, 1);
  assert.deepEqual(movement.consumedBatches?.map((entry) => entry.batchId), [expired.batchId]);
  assert.ok(store.inventory.some((entry) => entry.id === movement.id));
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "manual-deduction" &&
        entry.metadata?.consumedBatches &&
        JSON.stringify(entry.metadata.consumedBatches).includes(expired.batchId)
    )
  );
});
