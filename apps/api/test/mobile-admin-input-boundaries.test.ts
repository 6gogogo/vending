import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module";
import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { UsersController } from "../src/modules/users/users.controller";
import { UsersService } from "../src/modules/users/users.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP
};

const createFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-mobile-admin-input-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const store = new InMemoryStoreService();
  const inventoryBatchChanges = new InventoryBatchChangesService(store);
  const devices = new DevicesService(store, inventoryBatchChanges, {} as never);
  const users = new UsersService(store, inventoryBatchChanges, devices);
  const controller = new UsersController(users);
  const actor = store.users.find(
    (entry) =>
      entry.role === "admin" &&
      entry.status === "active" &&
      !store.isHiddenBackofficeUser(entry)
  );
  const target = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(actor);
  assert.ok(target);

  return { store, controller, actor, target };
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

test("PATCH /api/users/batch 命中批量接口而不是动态用户参数路由", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-mobile-admin-route-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");

  try {
    const store = app.get(InMemoryStoreService);
    const actor = store.users.find(
      (entry) =>
        entry.role === "admin" &&
        entry.status === "active" &&
        !store.isHiddenBackofficeUser(entry)
    );
    const target = store.users.find((entry) => entry.role === "special" && entry.status === "active");
    assert.ok(actor);
    assert.ok(target);
    const token = store.createSession(actor);
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/users/batch`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        userIds: [target.id],
        patch: { status: "inactive" }
      })
    });
    const payload = (await response.json()) as {
      code?: number;
      data?: { count?: number; updated?: Array<{ id?: string; status?: string }> };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.code, 200);
    assert.equal(payload.data?.count, 1);
    assert.equal(payload.data?.updated?.[0]?.id, target.id);
    assert.equal(target.status, "inactive");
  } finally {
    await app.close();
  }
});

test("POST /api/users 拒绝未定义角色且不落库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-user-create-role-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");

  try {
    const store = app.get(InMemoryStoreService);
    const actor = store.users.find(
      (entry) =>
        entry.role === "admin" &&
        entry.status === "active" &&
        !store.isHiddenBackofficeUser(entry)
    );
    assert.ok(actor);
    const token = store.createBackofficeSession(actor, "admin", store.getDefaultTenantId());
    const beforeUsers = structuredClone(store.users);
    const beforeLogs = structuredClone(store.logs);
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "19900000000",
        name: "非法角色测试用户"
      })
    });
    const payload = (await response.json()) as {
      code?: number;
      message?: string;
    };

    assert.equal(response.status, 400);
    assert.equal(payload.message, "请选择有效的用户角色。");
    assert.deepEqual(store.users, beforeUsers);
    assert.deepEqual(store.logs, beforeLogs);
  } finally {
    await app.close();
  }
});

test("用户创建拒绝未知状态且不落库", () => {
  const { controller, actor, store } = createFixture();
  const beforeUsers = structuredClone(store.users);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.createUser(
        {
          role: "special",
          phone: "19900000000",
          name: "非法状态测试用户",
          status: "paused" as never
        },
        { authUser: { id: actor.id } }
      ),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "请选择有效的用户状态。"
  );

  assert.deepEqual(store.users, beforeUsers);
  assert.deepEqual(store.logs, beforeLogs);
});

test("创建第二个管理员后重启不会重复生成默认后台凭据", () => {
  const { controller, actor, store } = createFixture();

  controller.createUser(
    {
      role: "admin",
      phone: "19900000001",
      name: "第二实例管理员",
      status: "active"
    },
    { authUser: { id: actor.id } }
  );
  store.persist();

  const reloadedStore = new InMemoryStoreService();
  const defaultAdminCredentials = reloadedStore.adminCredentials.filter(
    (entry) => entry.username === "admin"
  );

  assert.equal(reloadedStore.isPersistedStateIntegrityReady(), true);
  assert.equal(defaultAdminCredentials.length, 1);
  assert.equal(defaultAdminCredentials[0]?.userId, actor.id);
});

test("创建未开通后台账号的第二个商户后重启不会重复生成默认商户凭据", () => {
  const { controller, actor, store } = createFixture();
  const defaultMerchant = store.users.find((entry) => entry.id === "merchant-001");
  assert.ok(defaultMerchant);

  controller.createUser(
    {
      role: "merchant",
      phone: "19900000002",
      name: "第二测试商户",
      status: "active"
    },
    { authUser: { id: actor.id } }
  );
  store.persist();

  const reloadedStore = new InMemoryStoreService();
  const defaultMerchantCredentials = reloadedStore.backofficeCredentials.filter(
    (entry) => entry.username === "merchant"
  );

  assert.equal(reloadedStore.isPersistedStateIntegrityReady(), true);
  assert.equal(defaultMerchantCredentials.length, 1);
  assert.equal(defaultMerchantCredentials[0]?.userId, defaultMerchant.id);
});

test("普通移动管理员更新基础资料时不能夹带角色变更", () => {
  const { controller, actor, target } = createFixture();

  assert.throws(
    () =>
      controller.updateUser(
        target.id,
        { name: "更新后的姓名", role: "admin" },
        { authUser: { id: actor.id } }
      ),
    BadRequestException
  );
  assert.equal(target.role, "special");
  assert.notEqual(target.name, "更新后的姓名");
});

test("单人更新拒绝停用当前登录账号且保持零副作用", () => {
  const { controller, actor, store } = createFixture();
  const beforeActor = structuredClone(actor);
  const beforeSessions = structuredClone(store.sessions);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.updateUser(
        actor.id,
        { status: "inactive" },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "不能停用当前登录账号，请由其他管理员处理。"
  );

  assert.deepEqual(actor, beforeActor);
  assert.deepEqual(store.sessions, beforeSessions);
  assert.deepEqual(store.logs, beforeLogs);
});

test("单人更新拒绝修改当前登录账号角色且保持零副作用", () => {
  const { controller, actor, store } = createFixture();
  const beforeActor = structuredClone(actor);
  const beforeSessions = structuredClone(store.sessions);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.updateUser(
        actor.id,
        { role: "merchant", status: "active" },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "不能修改当前登录账号的角色，请由其他管理员处理。"
  );

  assert.deepEqual(actor, beforeActor);
  assert.deepEqual(store.sessions, beforeSessions);
  assert.deepEqual(store.logs, beforeLogs);
});

test("用户更新拒绝非字符串数组标签且不会污染后续列表", () => {
  const { controller, actor, target, store } = createFixture();
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.updateUser(
        target.id,
        { tags: {} as never },
        { authUser: { id: actor.id } }
      ),
    BadRequestException
  );

  assert.deepEqual(target, beforeUser);
  assert.deepEqual(store.logs, beforeLogs);
  assert.doesNotThrow(() => controller.list(undefined, { authUser: {} }));
});

test("用户更新枚举不接受对象字符串化且失败时零副作用", () => {
  const { controller, actor, target, store } = createFixture();
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.updateUser(
        target.id,
        { role: { toString: () => "admin" } as never },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    BadRequestException
  );

  assert.deepEqual(target, beforeUser);
  assert.deepEqual(store.logs, beforeLogs);
});

test("普通移动管理员批量启停时不能夹带标签或额度变更", () => {
  const { controller, actor, target } = createFixture();
  const originalTags = [...target.tags];

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id],
          patch: {
            status: "inactive",
            tags: ["越权标签"]
          }
        },
        { authUser: { id: actor.id } }
      ),
    BadRequestException
  );
  assert.equal(target.status, "active");
  assert.deepEqual(target.tags, originalTags);
});

test("批量停用拒绝停用当前登录账号且整批保持零副作用", () => {
  const { controller, actor, target, store } = createFixture();
  const beforeActor = structuredClone(actor);
  const beforeTarget = structuredClone(target);
  const beforeSessions = structuredClone(store.sessions);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [actor.id, target.id],
          patch: { status: "inactive" }
        },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === "不能停用当前登录账号，请由其他管理员处理。"
  );

  assert.deepEqual(actor, beforeActor);
  assert.deepEqual(target, beforeTarget);
  assert.deepEqual(store.sessions, beforeSessions);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量更新拒绝非对象 patch 并保持用户和日志不变", () => {
  const { controller, actor, target, store } = createFixture();
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id],
          patch: null as never
        },
        { authUser: { id: actor.id } }
      ),
    BadRequestException
  );

  assert.deepEqual(target, beforeUser);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量更新严格拒绝未知状态和非法用户编号数组", () => {
  for (const body of [
    { userIds: ["special-001"], patch: { status: "paused" } },
    { userIds: "special-001", patch: { status: "inactive" } }
  ]) {
    const { controller, actor, target, store } = createFixture();
    const beforeUser = structuredClone(target);
    const beforeLogs = structuredClone(store.logs);

    assert.throws(
      () =>
        controller.batchUpdate(body as never, { authUser: { id: actor.id } }),
      BadRequestException
    );
    assert.deepEqual(target, beforeUser);
    assert.deepEqual(store.logs, beforeLogs);
  }
});

test("批量更新额度只接受既定货品分类且失败时零副作用", () => {
  const { controller, actor, target, store } = createFixture();
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id],
          patch: {
            quota: {
              dailyLimit: 2,
              categoryLimit: { medicine: 1 }
            } as never
          }
        },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    /不支持的额度分类/
  );

  assert.deepEqual(target, beforeUser);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量更新包含无效用户时整批失败且不修改用户、会话或日志", () => {
  const { controller, actor, target, store } = createFixture();
  const targetToken = store.createSession(target);
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id, "missing-user"],
          patch: { status: "inactive" }
        },
        { authUser: { id: actor.id } }
      ),
    NotFoundException
  );

  assert.deepEqual(target, beforeUser);
  assert.equal(store.sessions.has(targetToken), true);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量更新拒绝重复用户编号且不产生重复修改或日志", () => {
  const { controller, actor, target, store } = createFixture();
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id, target.id],
          patch: { status: "inactive" }
        },
        { authUser: { id: actor.id } }
      ),
    /不能包含重复用户/
  );

  assert.deepEqual(target, beforeUser);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量删除要求确认人数与所选人数一致且失败时零副作用", () => {
  const { controller, actor, target, store } = createFixture();
  const secondTarget = store.users.find(
    (entry) => entry.role === "merchant" && entry.status === "active"
  );
  assert.ok(secondTarget);
  const beforeUsers = structuredClone(store.users);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchRemove(
        {
          userIds: [target.id, secondTarget.id],
          confirmedCount: 1
        },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    /确认人数必须与所选人数一致/
  );

  assert.deepEqual(store.users, beforeUsers);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量删除返回准确数量、撤销会话并写入逐人和批次审计", () => {
  const { controller, actor, target, store } = createFixture();
  const secondTarget = store.users.find(
    (entry) => entry.role === "merchant" && entry.status === "active"
  );
  assert.ok(secondTarget);
  const targetToken = store.createSession(target);
  const secondTargetToken = store.createSession(secondTarget);

  const response = controller.batchRemove(
    {
      userIds: [target.id, secondTarget.id],
      confirmedCount: 2
    },
    { authUser: { id: actor.id, backofficeRole: "admin" } }
  );

  assert.equal(response.data.count, 2);
  assert.deepEqual(
    response.data.removed.map((entry) => entry.id).sort(),
    [target.id, secondTarget.id].sort()
  );
  assert.equal(store.users.some((entry) => entry.id === target.id), false);
  assert.equal(store.users.some((entry) => entry.id === secondTarget.id), false);
  assert.equal(store.sessions.has(targetToken), false);
  assert.equal(store.sessions.has(secondTargetToken), false);
  assert.equal(
    store.logs.filter(
      (entry) =>
        entry.type === "remove-user" &&
        [target.id, secondTarget.id].includes(entry.primarySubject?.id ?? "")
    ).length,
    2
  );
  const batchLog = store.logs.find((entry) => entry.type === "batch-remove-users");
  assert.ok(batchLog);
  assert.equal(batchLog.metadata?.count, 2);
  assert.deepEqual(
    (batchLog.metadata?.userIds as string[] | undefined)?.slice().sort(),
    [target.id, secondTarget.id].sort()
  );
});

test("批量更新提交阶段失败时回滚全部用户、会话和日志", () => {
  const { controller, actor, target, store } = createFixture();
  const secondTarget = store.users.find(
    (entry) => entry.role === "merchant" && entry.status === "active"
  );
  assert.ok(secondTarget);
  store.createSession(target);
  store.createSession(secondTarget);
  const beforeUsers = structuredClone([target, secondTarget]);
  const beforeSessions = structuredClone(store.sessions);
  const beforeLogs = structuredClone(store.logs);
  const originalLogOperation = store.logOperation.bind(store);
  let logAttempt = 0;
  store.logOperation = ((draft: Parameters<typeof store.logOperation>[0]) => {
    logAttempt += 1;
    if (logAttempt === 2) {
      throw new Error("模拟第二条日志写入失败");
    }
    return originalLogOperation(draft);
  }) as typeof store.logOperation;

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id, secondTarget.id],
          patch: { status: "inactive" }
        },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    /模拟第二条日志写入失败/
  );

  assert.deepEqual([target, secondTarget], beforeUsers);
  assert.deepEqual(store.sessions, beforeSessions);
  assert.deepEqual(store.logs, beforeLogs);
});

test("批量更新字段解析失败时不保留此前已应用的状态和会话变化", () => {
  const { controller, actor, target, store } = createFixture();
  const targetToken = store.createSession(target);
  const beforeUser = structuredClone(target);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.batchUpdate(
        {
          userIds: [target.id],
          patch: {
            status: "inactive",
            regionName: "不存在的区域"
          }
        },
        { authUser: { id: actor.id, backofficeRole: "admin" } }
      ),
    /请选择已配置区域/
  );

  assert.deepEqual(target, beforeUser);
  assert.equal(store.sessions.has(targetToken), true);
  assert.deepEqual(store.logs, beforeLogs);
});

test("普通移动管理员手工调整时不能提交价格、关联事件或指定批次", () => {
  const forbiddenPayloads = [
    { unitPrice: 999 },
    { relatedEventId: "event-forged" },
    { relatedOrderNo: "order-forged" },
    { batchConsumptions: [{ batchId: "batch-forged", quantity: 1 }] }
  ];

  for (const forbidden of forbiddenPayloads) {
    const { controller, actor, target, store } = createFixture();
    const device = store.devices[0];
    const goods = device?.doors[0]?.goods[0];
    assert.ok(device);
    assert.ok(goods);

    assert.throws(
      () =>
        controller.manualAdjustment(
          target.id,
          {
            deviceCode: device.deviceCode,
            goodsId: goods.goodsId,
            goodsName: goods.name,
            category: goods.category,
            quantity: 1,
            direction: "deduct",
            confirmed: true,
            ...forbidden
          },
          { authUser: { id: actor.id } }
        ),
      BadRequestException,
      Object.keys(forbidden)[0]
    );
  }
});

test("手工调整严格拒绝伪布尔确认和未知方向且库存零副作用", () => {
  const { controller, actor, target, store } = createFixture();
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  const beforeBatches = structuredClone(store.goodsBatches);
  const beforeInventory = structuredClone(store.inventory);
  const beforeLogs = structuredClone(store.logs);

  assert.throws(
    () =>
      controller.manualAdjustment(
        target.id,
        {
          deviceCode: device.deviceCode,
          goodsId: goods.goodsId,
          quantity: 1,
          direction: "unexpected" as never,
          confirmed: "false" as never
        },
        { authUser: { id: actor.id } }
      ),
    BadRequestException
  );

  assert.deepEqual(store.goodsBatches, beforeBatches);
  assert.deepEqual(store.inventory, beforeInventory);
  assert.deepEqual(store.logs, beforeLogs);
});

test("手工调整拒绝非对象请求体和非法字段值且始终零副作用", () => {
  const invalidBodies = [
    null,
    {
      deviceCode: 42,
      goodsId: "goods-001",
      quantity: 1,
      direction: "restock",
      confirmed: true
    },
    {
      deviceCode: "CAB-1001",
      goodsId: "goods-001",
      category: "unknown",
      quantity: 1,
      unitPrice: -1,
      direction: "restock",
      confirmed: true
    }
  ];

  for (const body of invalidBodies) {
    const { controller, actor, target, store } = createFixture();
    const beforeBatches = structuredClone(store.goodsBatches);
    const beforeInventory = structuredClone(store.inventory);
    const beforeLogs = structuredClone(store.logs);

    assert.throws(
      () =>
        controller.manualAdjustment(target.id, body as never, {
          authUser: { id: actor.id, backofficeRole: "admin" }
        }),
      BadRequestException
    );
    assert.deepEqual(store.goodsBatches, beforeBatches);
    assert.deepEqual(store.inventory, beforeInventory);
    assert.deepEqual(store.logs, beforeLogs);
  }
});

test("普通移动管理员手工调整使用服务端货品资料和价格", () => {
  const { controller, actor, target, store } = createFixture();
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  goods.price = 12.34;
  const expectedPrice = goods.price;
  const expectedName = goods.name;
  const expectedCategory = goods.category;

  const response = controller.manualAdjustment(
    target.id,
    {
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      goodsName: "客户端伪造名称",
      category: goods.category === "food" ? "daily" : "food",
      quantity: 1,
      direction: "restock",
      confirmed: true
    },
    { authUser: { id: actor.id } }
  );

  assert.equal(response.data.goodsName, expectedName);
  assert.equal(response.data.category, expectedCategory);
  assert.equal(response.data.unitPrice, expectedPrice);
  assert.equal(response.data.eventId, undefined);
  assert.equal(response.data.sourceOrderNo, undefined);
});

test("后台手工补货未填写单价时保留服务端价格", () => {
  const { controller, actor, target, store } = createFixture();
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);
  goods.price = 1234;

  const response = controller.manualAdjustment(
    target.id,
    {
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: 1,
      direction: "restock",
      confirmed: true
    },
    { authUser: { id: actor.id, backofficeRole: "admin" } }
  );

  const catalogGoods = store.goodsCatalog.find((entry) => entry.goodsId === goods.goodsId);
  assert.equal(response.data.unitPrice, 1234);
  assert.equal(catalogGoods?.price, 1234);
});

test("后台会话仍可使用人员通用更新和批量字段", () => {
  const { controller, actor, target } = createFixture();

  const updated = controller.updateUser(
    target.id,
    { role: "merchant", name: "后台修改后的商户" },
    { authUser: { id: actor.id, backofficeRole: "admin" } }
  );
  assert.equal(updated.data.role, "merchant");

  const batched = controller.batchUpdate(
    {
      userIds: [target.id],
      patch: { tags: ["后台批量标签"] }
    },
    { authUser: { id: actor.id, backofficeRole: "admin" } }
  );
  assert.deepEqual(batched.data.updated[0]?.tags, ["后台批量标签"]);
});

test("后台会话手工补扣仍可提交关联信息、价格和指定批次", () => {
  const { controller, actor, target, store } = createFixture();
  const device = store.devices[0];
  const goods = device?.doors[0]?.goods[0];
  assert.ok(device);
  assert.ok(goods);

  controller.manualAdjustment(
    target.id,
    {
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: 2,
      direction: "restock",
      confirmed: true
    },
    { authUser: { id: actor.id, backofficeRole: "admin" } }
  );
  const sourceBatch = store.goodsBatches.find(
    (batch) =>
      batch.deviceCode === device.deviceCode &&
      batch.goodsId === goods.goodsId &&
      batch.remainingQuantity >= 1
  );
  assert.ok(sourceBatch);

  const response = controller.manualAdjustment(
    target.id,
    {
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      goodsName: "后台指定名称",
      category: goods.category,
      quantity: 1,
      unitPrice: 8.8,
      direction: "deduct",
      relatedEventId: "event-backoffice",
      relatedOrderNo: "order-backoffice",
      confirmed: true,
      batchConsumptions: [{ batchId: sourceBatch.batchId, quantity: 1 }]
    },
    { authUser: { id: actor.id, backofficeRole: "admin" } }
  );

  assert.equal(response.data.goodsName, "后台指定名称");
  assert.equal(response.data.unitPrice, 8.8);
  assert.equal(response.data.eventId, "event-backoffice");
  assert.equal(response.data.sourceOrderNo, "order-backoffice");
});
