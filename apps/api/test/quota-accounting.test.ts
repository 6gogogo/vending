import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ConfigService } from "@nestjs/config";
import type { CabinetEventRecord, InventoryMovement } from "@vm/shared-types";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { sumNetQuotaQuantity } from "../src/common/policies/special-access-policy.utils";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";

const temporaryDirectories: string[] = [];
const originalDataFile = process.env.API_DATA_FILE;

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-quota-accounting-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  return new InMemoryStoreService();
};

const createInventoryOrdersHarness = () => {
  const store = createIsolatedStore();
  const batchChanges = new InventoryBatchChangesService(store);
  const devices = new DevicesService(store, batchChanges, {} as SmartVmGateway);

  return {
    store,
    service: new InventoryOrdersService(
      store,
      batchChanges,
      devices,
      new AlertsService(store),
      new ConfigService({})
    )
  };
};

const buildEvent = (
  store: InMemoryStoreService,
  overrides: Partial<CabinetEventRecord> = {}
): CabinetEventRecord => {
  const user = store.users.find((entry) => entry.role === "special");
  const device = store.devices[0];
  assert.ok(user);
  assert.ok(device);
  const now = new Date().toISOString();

  return {
    eventId: "event-quota-accounting",
    orderNo: "order-quota-accounting",
    userId: user.id,
    phone: user.phone,
    role: "special",
    deviceCode: device.deviceCode,
    doorNum: device.doors[0]?.doorNum ?? "1",
    status: "settled",
    createdAt: now,
    updatedAt: now,
    amount: 200,
    goods: [],
    ...overrides
  };
};

after(() => {
  if (originalDataFile === undefined) {
    delete process.env.API_DATA_FILE;
  } else {
    process.env.API_DATA_FILE = originalDataFile;
  }

  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const buildMovement = (
  overrides: Partial<InventoryMovement> & Pick<InventoryMovement, "id" | "orderNo" | "goodsId" | "quantity">
): InventoryMovement => ({
  userId: "special-quota-1",
  deviceCode: "CAB-QUOTA-1",
  goodsName: overrides.goodsId,
  category: "food",
  unitPrice: 100,
  type: "pickup",
  happenedAt: new Date().toISOString(),
  ...overrides
});

test("净额度统计只累计实际免费数量，旧流水仍按领取数量兼容", () => {
  const inventory: InventoryMovement[] = [
    buildMovement({
      id: "movement-partly-free",
      orderNo: "order-partly-free",
      goodsId: "goods-a",
      quantity: 3,
      quotaQuantity: 1
    }),
    buildMovement({
      id: "movement-fully-paid",
      orderNo: "order-fully-paid",
      goodsId: "goods-b",
      quantity: 2,
      quotaQuantity: 0
    }),
    buildMovement({
      id: "movement-legacy",
      orderNo: "order-legacy",
      goodsId: "goods-c",
      quantity: 1
    })
  ];

  assert.equal(sumNetQuotaQuantity(inventory, () => true), 2);
});

test("每日免费额度不被付费取货数量占用", () => {
  const store = createIsolatedStore();
  const user = store.users.find((entry) => entry.role === "special");
  const goods = store.goodsCatalog[0];
  assert.ok(user);
  assert.ok(goods);
  user.quota = {
    dailyLimit: 3,
    categoryLimit: {
      [goods.category]: 3
    }
  };
  store.specialAccessPolicies.splice(0, store.specialAccessPolicies.length);
  store.inventory.splice(
    0,
    store.inventory.length,
    buildMovement({
      id: "movement-access-partly-free",
      orderNo: "order-access-partly-free",
      userId: user.id,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: 3,
      quotaQuantity: 1
    }),
    buildMovement({
      id: "movement-access-paid",
      orderNo: "order-access-paid",
      userId: user.id,
      goodsId: `${goods.goodsId}-paid`,
      goodsName: "全额付费物资",
      category: goods.category,
      quantity: 2,
      quotaQuantity: 0
    })
  );

  const summary = new AccessRulesService(store).getQuotaSummaryForUser(user);

  assert.equal(summary.usedCount, 1);
  assert.equal(summary.remainingDaily, 2);
  assert.equal(summary.remainingToday[goods.category], 2);
});

test("两种货品各剩一件时，免费总剩余仍受每日总额度约束", () => {
  const store = createIsolatedStore();
  const user = store.users.find((entry) => entry.role === "special");
  const [firstGoods, secondGoods] = store.goodsCatalog;
  assert.ok(user);
  assert.ok(firstGoods);
  assert.ok(secondGoods);
  user.quota = {
    dailyLimit: 1,
    categoryLimit: {
      food: 5,
      drink: 5,
      daily: 5
    }
  };
  user.accessPolicies = [];
  store.inventory.splice(0, store.inventory.length);
  store.specialAccessPolicies.splice(0, store.specialAccessPolicies.length, {
    id: "policy-total-cap",
    name: "总额度聚合测试",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0,
    endHour: 24,
    goodsLimits: [
      {
        goodsId: firstGoods.goodsId,
        goodsName: firstGoods.name,
        category: firstGoods.category,
        quantity: 1
      },
      {
        goodsId: secondGoods.goodsId,
        goodsName: secondGoods.name,
        category: secondGoods.category,
        quantity: 1
      }
    ],
    applicableUserIds: [user.id],
    status: "active"
  });

  const summary = new AccessRulesService(store).getQuotaSummaryForUser(user);

  assert.deepEqual(Object.values(summary.remainingByGoods ?? {}).sort(), [1, 1]);
  assert.equal(summary.remainingDaily, 1);
  assert.equal(summary.remainingFreeTotal, 1);
});

test("树状额度按最具体规则优先并向后代货品开放", () => {
  const store = createIsolatedStore();
  const user = store.users.find((entry) => entry.role === "special");
  const [sandwich, toothbrush] = store.goodsCatalog;
  assert.ok(user);
  assert.ok(sandwich);
  assert.ok(toothbrush);
  const now = new Date().toISOString();
  store.goodsTaxonomyNodes.splice(0, store.goodsTaxonomyNodes.length,
    { id: "any", name: "任意", parentId: null, status: "active", sortOrder: 1, revision: 1, createdAt: now, updatedAt: now },
    { id: "food", name: "食品", parentId: "any", status: "active", sortOrder: 1, revision: 1, createdAt: now, updatedAt: now },
    { id: "daily", name: "日用品", parentId: "any", status: "active", sortOrder: 2, revision: 1, createdAt: now, updatedAt: now }
  );
  sandwich.taxonomyNodeId = "food";
  toothbrush.taxonomyNodeId = "daily";
  user.accessPolicies = [{
    id: "user-taxonomy-policy",
    name: "树状额度",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0,
    endHour: 24,
    goodsLimits: [],
    entitlementLimits: [
      { id: "food-limit", targetType: "taxonomy_node", targetId: "food", quantity: 1 },
      { id: "any-limit", targetType: "taxonomy_node", targetId: "any", quantity: 3 }
    ],
    status: "active"
  }];
  store.inventory.splice(0, store.inventory.length);

  const summary = new AccessRulesService(store).getQuotaSummaryForUser(user);

  assert.equal(summary.receivableByGoods?.[sandwich.goodsId], 4);
  assert.equal(summary.receivableByGoods?.[toothbrush.goodsId], 3);
  assert.equal(summary.remainingFreeTotal, 4);
});

test("结算流水持久化本次实际免费数量", () => {
  const { store, service } = createInventoryOrdersHarness();
  const event = buildEvent(store);
  const goods = store.devices[0]?.doors[0]?.goods[0];
  assert.ok(goods);

  const result = service.recordSettlement(
    event,
    {
      orderNo: event.orderNo,
      eventId: event.eventId,
      phone: event.phone,
      deviceCode: event.deviceCode,
      amount: 200,
      notifyUrl: "http://127.0.0.1/local-test-only",
      detail: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: 3,
          unitPrice: 100
        }
      ]
    },
    {
      quotaItems: [
        {
          goodsId: goods.goodsId,
          freeQuantity: 1
        }
      ]
    }
  );

  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]?.quantity, 3);
  assert.equal(result.movements[0]?.quotaQuantity, 1);
});

test("有金额的补扣流水默认不占用免费额度", () => {
  const { store, service } = createInventoryOrdersHarness();
  const event = buildEvent(store, {
    orderNo: "order-adjustment-source"
  });
  const goods = store.devices[0]?.doors[0]?.goods[0];
  assert.ok(goods);

  const result = service.recordAdjustment(event, {
    orgOrderNo: event.orderNo,
    orderNo: "order-adjustment-paid",
    eventId: event.eventId,
    phone: event.phone,
    deviceCode: event.deviceCode,
    amount: 200,
    noticeUrl: "http://127.0.0.1/local-test-only",
    detail: [
      {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        quantity: 2,
        unitPrice: 100
      }
    ]
  });

  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0]?.quantity, 2);
  assert.equal(result.movements[0]?.quotaQuantity, 0);
});

test("零金额补扣流水明确记录为免费额度数量", () => {
  const { store, service } = createInventoryOrdersHarness();
  const event = buildEvent(store, {
    orderNo: "order-adjustment-free-source"
  });
  const goods = store.devices[0]?.doors[0]?.goods[0];
  assert.ok(goods);

  const result = service.recordAdjustment(event, {
    orgOrderNo: event.orderNo,
    orderNo: "order-adjustment-free",
    eventId: event.eventId,
    phone: event.phone,
    deviceCode: event.deviceCode,
    amount: 0,
    noticeUrl: "http://127.0.0.1/local-test-only",
    detail: [
      {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        quantity: 2,
        unitPrice: 100
      }
    ]
  });

  assert.equal(result.movements[0]?.quotaQuantity, 2);
});

test("整单退款只恢复原流水实际占用的免费额度", () => {
  const { store, service } = createInventoryOrdersHarness();
  const event = buildEvent(store, {
    orderNo: "order-refund-quota",
    amount: 200
  });
  const goods = store.devices[0]?.doors[0]?.goods[0];
  assert.ok(goods);
  store.events.push(event);

  service.recordSettlement(
    event,
    {
      orderNo: event.orderNo,
      eventId: event.eventId,
      phone: event.phone,
      deviceCode: event.deviceCode,
      amount: 200,
      notifyUrl: "http://127.0.0.1/local-test-only",
      detail: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          quantity: 3,
          unitPrice: 100
        }
      ]
    },
    {
      quotaItems: [
        {
          goodsId: goods.goodsId,
          freeQuantity: 1
        }
      ]
    }
  );
  event.goods = [
    {
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: 3,
      unitPrice: 100
    }
  ];
  event.paymentNotifyStatus = "success";
  event.paymentTransactionId = "transaction-refund-quota";

  const refund = service.markRefund(event.orderNo, "transaction-refund-quota", 200, {
    source: "manual",
    refundNo: "refund-quota-only",
    deviceCode: event.deviceCode
  });

  assert.equal(refund.movements.length, 1);
  assert.equal(refund.movements[0]?.quantity, 3);
  assert.equal(refund.movements[0]?.quotaQuantity, 1);
  assert.equal(
    sumNetQuotaQuantity(
      store.inventory,
      (entry) =>
        entry.userId === event.userId &&
        entry.goodsId === goods.goodsId &&
        entry.orderNo === event.orderNo
    ),
    0
  );
});
