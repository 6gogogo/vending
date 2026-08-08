import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SmartVmRequestError } from "@vm/shared-client/smartvm";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import type { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { DeviceOperationCoordinator } from "../src/modules/devices/device-operation-coordinator";
import { DevicesService } from "../src/modules/devices/devices.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import type { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP,
  SMARTVM_STATUS_STALE_AFTER_MS: process.env.SMARTVM_STATUS_STALE_AFTER_MS
};

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-device-operation-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
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

test("在线标记超过心跳时限后仍允许受控重试，明确离线和维护态保持阻断", () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  assert.ok(device);

  device.status = "online";
  device.lastSeenAt = new Date(Date.now() - 60_001).toISOString();
  const stale = coordinator.getReadiness(device.deviceCode);
  assert.equal(stale.connectivity, "stale");
  assert.equal(stale.canOpen, true);
  assert.equal(stale.blocker, undefined);

  const deviceView = new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    {} as never,
    coordinator
  ).list()[0];
  assert.ok(deviceView);
  assert.equal(deviceView.status, "online");
  assert.equal(deviceView.readiness?.connectivity, "stale");
  assert.equal(deviceView.readiness?.canOpen, true);

  device.status = "offline";
  const offline = coordinator.getReadiness(device.deviceCode);
  assert.equal(offline.canOpen, false);
  assert.equal(offline.blocker, "offline");

  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  const fresh = coordinator.getReadiness(device.deviceCode);
  assert.equal(fresh.connectivity, "online");
  assert.equal(fresh.canOpen, true);

  device.status = "maintenance";
  const maintenance = coordinator.getReadiness(device.deviceCode);
  assert.equal(maintenance.canOpen, false);
  assert.equal(maintenance.blocker, "maintenance");
});

test("未知门状态可受审计开门，已形成超时终态后允许再次受控尝试", () => {
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  assert.ok(device);
  assert.ok(door);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "unknown" });

  assert.doesNotThrow(() =>
    coordinator.assertOpenable({ deviceCode: device.deviceCode, doorNum: door.doorNum })
  );

  const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
  store.events.unshift({
    eventId: "event-unresolved-open",
    orderNo: "order-unresolved-open",
    userId: "admin-test",
    phone: "13800000001",
    role: "admin",
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    status: "timeout_unopened",
    physicalDoorState: "unknown",
    createdAt,
    updatedAt: createdAt,
    amount: 0,
    goods: []
  });
  assert.doesNotThrow(
    () => coordinator.assertOpenable({ deviceCode: device.deviceCode, doorNum: door.doorNum }),
  );

  store.events[0]!.status = "opening";
  assert.throws(
    () => coordinator.assertOpenable({ deviceCode: device.deviceCode, doorNum: door.doorNum }),
    /结果仍待确认/
  );

  store.events[0]!.status = "failed";
  delete store.events[0]!.physicalDoorState;
  assert.doesNotThrow(() =>
    coordinator.assertOpenable({ deviceCode: device.deviceCode, doorNum: door.doorNum })
  );

  store.updateDeviceRuntime(device.deviceCode, { doorState: "open" });
  assert.throws(
    () => coordinator.assertOpenable({ deviceCode: device.deviceCode, doorNum: door.doorNum }),
    /当前已开启/
  );

  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });
  assert.doesNotThrow(() =>
    coordinator.assertOpenable({ deviceCode: device.deviceCode, doorNum: door.doorNum })
  );
});

test("平台只读识别可提供开门依据，但不伪造物理在线状态", () => {
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  assert.ok(device);
  device.status = "offline";
  device.lastSeenAt = new Date(Date.now() - 60_001).toISOString();
  store.events.splice(0, store.events.length);

  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "unknown",
    lastPlatformRecognizedAt: new Date().toISOString()
  });
  const recognized = coordinator.getReadiness(device.deviceCode);
  assert.equal(recognized.connectivity, "offline");
  assert.equal(recognized.effectiveStatus, "offline");
  assert.equal(recognized.platformRecognition, "confirmed");
  assert.equal(recognized.canOpen, true);
  assert.equal(recognized.blocker, undefined);

  store.updateDeviceRuntime(device.deviceCode, { doorState: "open" });
  const openDoor = coordinator.getReadiness(device.deviceCode);
  assert.equal(openDoor.canOpen, false);
  assert.equal(openDoor.blocker, "door_open");

  const devices = new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    {} as never,
    coordinator
  );
  const detailView = devices.getViewByCode(device.deviceCode, "special");
  assert.equal(detailView.readiness?.canOpen, false);
  assert.equal(detailView.readiness?.blocker, "door_open");
  assert.equal(detailView.runtime?.doorState, "open");

  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });
  const closedDoor = coordinator.getReadiness(device.deviceCode);
  assert.equal(closedDoor.canOpen, true);
  assert.equal(closedDoor.blocker, undefined);
});

test("SmartVM 只把白名单业务拒绝视为可释放租约，畸形 2xx 响应保持未知", () => {
  const gateway = new SmartVmGateway(new ConfigService({}));
  const createError = (statusCode: number, responseBody: unknown) =>
    new SmartVmRequestError(
      "模拟 SmartVM 错误",
      statusCode,
      "/api/pay/container/opendoor",
      {},
      responseBody
    );

  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(200, { code: 400 })), true);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(400, { code: 400 })), true);
  assert.equal(
    gateway.isDefiniteOpenDoorRejection(
      createError(200, { code: 300, message: "存在非友好购买行为！" })
    ),
    true
  );
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(200, "")), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(200, "<html>proxy response</html>")), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(200, { message: "缺少业务 code" })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(200, { code: 500 })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(400, { message: "参数错误" })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(408, { message: "请求超时" })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(504, { reason: "timeout" })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(502, { reason: "network_error" })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(createError(500, { message: "内部错误" })), false);
  assert.equal(gateway.isDefiniteOpenDoorRejection(new Error("连接被重置")), false);
});

test("同一柜机同一柜门只允许一个开门命令在途，冲突立即返回 409", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  assert.ok(device);
  assert.ok(door);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let gatewayCalls = 0;
  const first = coordinator.runExclusiveOpen(
    { deviceCode: device.deviceCode, doorNum: door.doorNum },
    async () => {
      gatewayCalls += 1;
      await firstGate;
      return "first";
    }
  );

  await Promise.resolve();
  await assert.rejects(
    coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: door.doorNum },
      async () => {
        gatewayCalls += 1;
        return "second";
      }
    ),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.getStatus() === 409 &&
      /正在处理另一项开门请求/.test(error.message)
  );
  assert.equal(gatewayCalls, 1);

  releaseFirst();
  assert.equal(await first, "first");
});

test("不同柜门可并发，失败后不会留下幽灵锁", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  assert.ok(device);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  device.doors.push({ doorNum: "2", label: "门 2", goods: [] });
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = (doorNum: string) =>
    coordinator.runExclusiveOpen({ deviceCode: device.deviceCode, doorNum }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return doorNum;
    });

  const first = open("1");
  const second = open("2");
  await Promise.resolve();
  assert.equal(maxActive, 2);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["1", "2"]);

  await assert.rejects(
    coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: "1" },
      async () => {
        throw new Error("模拟网关失败");
      }
    ),
    /模拟网关失败/
  );
  assert.equal(
    await coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: "1" },
      async () => "retry-ok"
    ),
    "retry-ok"
  );
});

test("同一特殊用户跨柜门共享额度时仍只能有一个开柜命令在途", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  assert.ok(device);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  device.doors.push({ doorNum: "2", label: "门 2", goods: [] });
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const first = coordinator.runExclusiveOpen(
    { deviceCode: device.deviceCode, doorNum: "1" },
    async () => {
      calls += 1;
      await gate;
      return "first";
    },
    { userId: "special-shared-quota" }
  );

  await Promise.resolve();
  await assert.rejects(
    coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: "2" },
      async () => {
        calls += 1;
        return "second";
      },
      { userId: "special-shared-quota" }
    ),
    (error: unknown) =>
      error instanceof ConflictException &&
      /当前账号正在处理另一项开柜请求/.test(error.message)
  );
  assert.equal(calls, 1);

  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(
    await coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: "2" },
      async () => "retry",
      { userId: "special-shared-quota" }
    ),
    "retry"
  );
});

test("已有未结束事件时拒绝重复下发，关闭后允许下一次操作", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const event = store.events[0];
  assert.ok(device);
  assert.ok(door);
  assert.ok(event);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });
  event.deviceCode = device.deviceCode;
  event.doorNum = door.doorNum;
  event.status = "created";
  event.updatedAt = new Date().toISOString();

  await assert.rejects(
    coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: door.doorNum },
      async () => "should-not-run"
    ),
    ConflictException
  );

  event.status = "closed";
  assert.equal(
    await coordinator.runExclusiveOpen(
      { deviceCode: device.deviceCode, doorNum: door.doorNum },
      async () => "allowed"
    ),
    "allowed"
  );
});

test("用户开柜与后台远程开门共用同一柜门互斥", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const admin = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  assert.ok(device);
  assert.ok(door);
  assert.ok(admin);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  let releaseGateway!: () => void;
  const gatewayGate = new Promise<void>((resolve) => {
    releaseGateway = resolve;
  });
  let gatewayCalls = 0;
  const gateway = {
    async openDoor() {
      gatewayCalls += 1;
      await gatewayGate;
      return {
        orderNo: `shared-lock-order-${gatewayCalls}`,
        smartVmExchange: {
          direction: "outbound",
          occurredAt: new Date().toISOString(),
          method: "POST",
          path: "/mock/open",
          requestUrl: "mock://smartvm/open",
          requestBody: {},
          statusCode: 200,
          responseBody: {},
          ok: true,
          simulated: true
        }
      };
    },
    extractErrorMessage: () => "mock error",
    extractExchangeTrace: () => undefined
  };
  const accessRules = {} as AccessRulesService;
  const reservations = new ReservationsService(store, accessRules);
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    gateway as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    reservations,
    new ConfigService({}),
    coordinator
  );
  const devices = new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    gateway as never,
    coordinator
  );

  const userOpen = cabinetEvents.openCabinet(
    {
      phone: admin.phone,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      hasInboundGoods: false,
      openReason: "现场设备巡检"
    },
    { id: admin.id, role: "admin" }
  );
  await Promise.resolve();

  await assert.rejects(
    devices.remoteOpen(
      device.deviceCode,
      { doorNum: door.doorNum, reason: "后台同步巡检" },
      admin.id
    ),
    ConflictException
  );
  assert.equal(gatewayCalls, 1);

  releaseGateway();
  const opened = await userOpen;
  assert.equal(opened.deviceCode, device.deviceCode);
  assert.equal(gatewayCalls, 1);
});

test("实例管理员运营开门使用受控服务商上游身份，事件仍记录实际操作者", async () => {
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const tenantAdmin = store.users.find(
    (entry) => entry.role === "admin" && entry.status === "active" && Boolean(entry.tenantId)
  );
  const providerCredential = store.backofficeCredentials.find(
    (entry) => entry.role === "super_admin" && entry.tenantId === undefined
  );
  const providerUser = store.users.find((entry) => entry.id === providerCredential?.userId);
  assert.ok(device);
  assert.ok(door);
  assert.ok(tenantAdmin);
  assert.ok(providerCredential);
  assert.ok(providerUser);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  let outboundIdentity: { userId: string; phone: string } | undefined;
  const gateway = {
    async openDoor(payload: { userId: string; phone: string }) {
      outboundIdentity = { userId: payload.userId, phone: payload.phone };
      return { orderNo: "operator-open-order" };
    }
  };
  const accessRules = {} as AccessRulesService;
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    gateway as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({}),
    coordinator
  );

  await cabinetEvents.openCabinet(
    {
      phone: tenantAdmin.phone,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      hasInboundGoods: false,
      openReason: "现场设备巡检"
    },
    { id: tenantAdmin.id, role: "admin", tenantId: tenantAdmin.tenantId }
  );

  assert.deepEqual(outboundIdentity, {
    userId: providerUser.id,
    phone: providerUser.phone
  });
  assert.equal(store.events[0]?.userId, tenantAdmin.id);
  assert.equal(store.events[0]?.phone, tenantAdmin.phone);
  assert.equal(store.events[0]?.operationType, "service");
});

test("用户开柜在 SmartVM 2xx 空响应后保留已落盘命令租约，第二次请求不会重复下发", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const merchant = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  assert.ok(device);
  assert.ok(door);
  assert.ok(merchant);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  const smartVmGateway = new SmartVmGateway(new ConfigService({}));
  let gatewayCalls = 0;
  const gateway = {
    async openDoor(payload: { eventId: string }) {
      gatewayCalls += 1;
      const intent = store.events.find((event) => event.eventId === payload.eventId);
      assert.ok(intent, "调用柜机网关前必须先创建命令意图事件");
      assert.equal(intent.status, "created");

      const persisted = JSON.parse(
        readFileSync(process.env.API_DATA_FILE as string, "utf8")
      ) as { events?: Array<{ eventId: string; status: string }> };
      assert.ok(
        persisted.events?.some(
          (event) => event.eventId === payload.eventId && event.status === "created"
        ),
        "调用柜机网关前必须先持久化命令意图事件"
      );
      throw new SmartVmRequestError(
        "SmartVM 2xx 空响应，开门结果未知。",
        200,
        "/api/pay/container/opendoor",
        {},
        ""
      );
    },
    extractErrorMessage: (error: unknown) => error instanceof Error ? error.message : "未知错误",
    extractExchangeTrace: () => undefined,
    isDefiniteOpenDoorRejection: (error: unknown) =>
      smartVmGateway.isDefiniteOpenDoorRejection(error)
  };
  const accessRules = {} as AccessRulesService;
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    gateway as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({}),
    coordinator
  );
  const request = {
    phone: merchant.phone,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    hasInboundGoods: false,
    openReason: "现场例行巡检"
  };

  await assert.rejects(
    cabinetEvents.openCabinet(request, { id: merchant.id, role: "merchant" }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      const response = error.getResponse() as Record<string, unknown>;
      assert.deepEqual(response, {
        message: "柜机平台响应异常，开门结果待确认，请勿重复操作。",
        code: "operation_indeterminate",
        operationId: store.events[0]?.eventId,
        retryable: false
      });
      return true;
    }
  );
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]?.status, "created");

  await assert.rejects(
    cabinetEvents.openCabinet(request, { id: merchant.id, role: "merchant" }),
    ConflictException
  );
  assert.equal(gatewayCalls, 1);
});

test("用户开柜被平台明确拒绝时返回不可重试的已拒绝结果", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const merchant = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  assert.ok(device);
  assert.ok(door);
  assert.ok(merchant);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  const upstreamDetail = "provider-detail-must-not-reach-client";
  let gatewayCalls = 0;
  const gateway = {
    async openDoor(payload: { eventId: string }) {
      gatewayCalls += 1;
      assert.ok(store.events.some((event) => event.eventId === payload.eventId));
      throw new Error(upstreamDetail);
    },
    extractErrorMessage: (error: unknown) => error instanceof Error ? error.message : "未知错误",
    extractExchangeTrace: () => undefined,
    isDefiniteOpenDoorRejection: () => true
  };
  const accessRules = {} as AccessRulesService;
  const cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    gateway as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({}),
    coordinator
  );
  const request = {
    phone: merchant.phone,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    hasInboundGoods: false,
    openReason: "现场例行巡检"
  };

  await assert.rejects(
    cabinetEvents.openCabinet(request, { id: merchant.id, role: "merchant" }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      const response = error.getResponse() as Record<string, unknown>;
      assert.deepEqual(response, {
        message: "柜机平台已拒绝开门请求。",
        code: "operation_rejected",
        operationId: store.events[0]?.eventId,
        retryable: false
      });
      assert.equal(JSON.stringify(response).includes(upstreamDetail), false);
      return true;
    }
  );
  assert.equal(gatewayCalls, 1);
  assert.equal(store.events[0]?.status, "failed");
  assert.equal(store.events[0]?.physicalDoorState, "closed");
});

test("用户开柜在回调已确认后网关报错时返回不可重试的确认结果", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const merchant = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  assert.ok(device);
  assert.ok(door);
  assert.ok(merchant);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  const upstreamDetail = "provider-detail-must-not-reach-client";
  let gatewayCalls = 0;
  let cabinetEvents!: CabinetEventsService;
  const gateway = {
    async openDoor(payload: { eventId: string }) {
      gatewayCalls += 1;
      cabinetEvents.handleDoorStatus({
        eventId: payload.eventId,
        deviceCode: device.deviceCode,
        status: "SUCCESS"
      });
      throw new Error(upstreamDetail);
    },
    extractErrorMessage: (error: unknown) => error instanceof Error ? error.message : "未知错误",
    extractExchangeTrace: () => undefined,
    isDefiniteOpenDoorRejection: () => false,
    isUsingMockTransport: () => false,
    verifySignedPayload: () => true
  };
  const accessRules = {} as AccessRulesService;
  cabinetEvents = new CabinetEventsService(
    store,
    accessRules,
    gateway as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({}),
    coordinator
  );
  const request = {
    phone: merchant.phone,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    hasInboundGoods: false,
    openReason: "现场例行巡检"
  };

  await assert.rejects(
    cabinetEvents.openCabinet(request, { id: merchant.id, role: "merchant" }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      const response = error.getResponse() as Record<string, unknown>;
      assert.deepEqual(response, {
        message: "柜机开门状态已由平台回调确认，请刷新状态后继续。",
        code: "operation_confirmed",
        operationId: store.events[0]?.eventId,
        retryable: false
      });
      assert.equal(JSON.stringify(response).includes(upstreamDetail), false);
      return true;
    }
  );
  assert.equal(gatewayCalls, 1);
  assert.equal(store.events[0]?.status, "opened");
  assert.equal(store.events[0]?.physicalDoorState, "open");
  assert.equal(store.getDeviceRuntime(device.deviceCode).doorState, "open");
  assert.equal(coordinator.getReadiness(device.deviceCode).blocker, "door_open");
});

test("后台远程开门结果未知时持续阻断，现场关门确认或明确拒绝后才释放", async () => {
  process.env.SMARTVM_STATUS_STALE_AFTER_MS = "60000";
  const store = createIsolatedStore();
  const coordinator = new DeviceOperationCoordinator(store);
  const device = store.devices[0];
  const door = device?.doors[0];
  const admin = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  assert.ok(device);
  assert.ok(door);
  assert.ok(admin);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  let gatewayCalls = 0;
  let definitelyRejected = false;
  let shouldSucceed = false;
  const gateway = {
    async openDoor(payload: { eventId: string }) {
      gatewayCalls += 1;
      const intent = store.events.find((event) => event.eventId === payload.eventId);
      assert.ok(intent, "后台外呼前必须先创建命令意图事件");
      const persisted = JSON.parse(
        readFileSync(process.env.API_DATA_FILE as string, "utf8")
      ) as { events?: Array<{ eventId: string; status: string }> };
      assert.ok(persisted.events?.some((event) => event.eventId === payload.eventId));

      if (shouldSucceed) {
        return { orderNo: `remote-open-order-${gatewayCalls}` };
      }

      throw new Error(definitelyRejected ? "平台明确拒绝命令" : "响应超时，结果未知");
    },
    extractErrorMessage: (error: unknown) => error instanceof Error ? error.message : "未知错误",
    extractExchangeTrace: () => undefined,
    isDefiniteOpenDoorRejection: () => definitelyRejected
  };
  const devices = new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    gateway as never,
    coordinator
  );
  const request = { doorNum: door.doorNum, reason: "后台处理设备异常" };

  await assert.rejects(
    devices.remoteOpen(device.deviceCode, request, admin.id),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      const response = error.getResponse() as Record<string, unknown>;
      assert.deepEqual(response, {
        message: "柜机平台响应异常，开门结果待确认，请勿重复操作。",
        code: "operation_indeterminate",
        operationId: store.events[0]?.eventId,
        retryable: false
      });
      return true;
    }
  );
  await assert.rejects(
    devices.remoteOpen(device.deviceCode, request, admin.id),
    ConflictException
  );
  assert.equal(gatewayCalls, 1);
  assert.equal(store.events[0]?.status, "created");
  assert.equal(
    store.getDeviceRuntime(device.deviceCode).lastCommandAt,
    store.events[0]?.createdAt
  );
  assert.equal(store.getDeviceRuntime(device.deviceCode).openedAfterLastCommand, false);

  store.events[0]!.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await assert.rejects(
    devices.remoteOpen(device.deviceCode, request, admin.id),
    /结果仍待确认/
  );
  assert.equal(gatewayCalls, 1, "等待超过旧命令租约也不能重复下发");

  const confirmed = devices.confirmDoorClosed(device.deviceCode, admin.id);
  assert.equal(confirmed.runtime.doorState, "closed");
  assert.equal(store.events[0]?.status, "failed");
  assert.equal(store.events[0]?.physicalDoorState, "closed");
  assert.equal(
    store.logs.find((entry) => entry.type === "confirm-device-door-closed")?.metadata?.evidence,
    "admin-physical-confirmation"
  );

  definitelyRejected = true;
  await assert.rejects(
    devices.remoteOpen(device.deviceCode, request, admin.id),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      const response = error.getResponse() as Record<string, unknown>;
      assert.deepEqual(response, {
        message: "柜机平台已拒绝开门请求。",
        code: "operation_rejected",
        operationId: store.events[0]?.eventId,
        retryable: false
      });
      return true;
    }
  );
  assert.equal(store.events[0]?.status, "failed");
  assert.equal(store.events[0]?.physicalDoorState, "closed");

  shouldSucceed = true;
  const retried = await devices.remoteOpen(device.deviceCode, request, admin.id);
  assert.equal(retried.orderNo, "remote-open-order-3");
  assert.equal(gatewayCalls, 3);
  assert.equal(store.events.length, 3);
  assert.equal(store.events[0]?.orderNo, "remote-open-order-3");
  assert.equal(store.events[1]?.status, "failed");
  assert.equal(store.events[2]?.status, "failed");
  assert.equal(store.events[2]?.physicalDoorState, "closed");
  assert.equal(
    store.getDeviceRuntime(device.deviceCode).lastCommandAt,
    store.events[0]?.createdAt
  );
});

test("预约只在可信 SUCCESS 回调后履约，FAIL 回调保持预约有效", () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  const door = device?.doors[0];
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(device);
  assert.ok(door);
  assert.ok(user);
  store.events.splice(0, store.events.length);
  store.reservations.splice(0, store.reservations.length);

  const now = new Date().toISOString();
  const createReservation = (id: string) => ({
    id,
    userId: user.id,
    phone: user.phone,
    userName: user.name,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    status: "active" as const,
    inventoryReservationMode: "goods_quantity" as const,
    batchAllocationTiming: "on_open" as const,
    items: [],
    reservedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now
  });
  const failedReservation = createReservation("reservation-fail");
  const openedReservation = createReservation("reservation-success");
  store.reservations.push(failedReservation, openedReservation);
  store.events.push(
    {
      eventId: "event-reservation-fail",
      orderNo: "order-reservation-fail",
      userId: user.id,
      phone: user.phone,
      role: user.role,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      status: "created",
      createdAt: now,
      updatedAt: now,
      amount: 0,
      reservationId: failedReservation.id,
      goods: []
    },
    {
      eventId: "event-reservation-success",
      orderNo: "order-reservation-success",
      userId: user.id,
      phone: user.phone,
      role: user.role,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      status: "created",
      createdAt: now,
      updatedAt: now,
      amount: 0,
      reservationId: openedReservation.id,
      goods: []
    }
  );
  const accessRules = {} as AccessRulesService;
  const service = new CabinetEventsService(
    store,
    accessRules,
    {
      verifySignedPayload: () => true,
      isUsingMockTransport: () => false
    } as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({})
  );
  const callbackBase = {
    deviceCode: device.deviceCode,
    clientId: "trusted-smartvm",
    timestamp: Math.floor(Date.now() / 1000),
    sign: "verified"
  };

  service.handleDoorStatus({
    ...callbackBase,
    eventId: "event-reservation-fail",
    nonceStr: "reservation-fail",
    status: "FAIL"
  });
  assert.equal(failedReservation.status, "active");
  assert.equal(
    store.events.find((entry) => entry.eventId === "event-reservation-fail")?.physicalDoorState,
    "unknown"
  );
  assert.equal(store.getDeviceRuntime(device.deviceCode).doorState, "unknown");
  const failureAlert = store.alerts.find(
    (entry) => entry.relatedEventId === "event-reservation-fail"
  );
  assert.match(failureAlert?.detail ?? "", /order-reservation-fail/);
  assert.match(failureAlert?.detail ?? "", /SmartVM 1\.1 门状态回调未提供具体故障原因/);

  service.handleDoorStatus({
    ...callbackBase,
    eventId: "event-reservation-success",
    nonceStr: "reservation-success",
    status: "SUCCESS"
  });
  assert.equal(openedReservation.status, "fulfilled");
  assert.equal(
    store.reservations.find((entry) => entry.id === openedReservation.id)?.fulfilledEventId,
    "event-reservation-success"
  );
});

test("结算先于关门回调时仍更新物理门状态且保留结算状态", () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  const door = device?.doors[0];
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(device);
  assert.ok(door);
  assert.ok(user);
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "open",
    openedAfterLastCommand: true,
    lastOpenedAt: new Date().toISOString()
  });
  const now = new Date().toISOString();
  const event = {
    eventId: "event-settled-before-close",
    orderNo: "order-settled-before-close",
    userId: user.id,
    phone: user.phone,
    role: user.role,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    status: "settled" as const,
    createdAt: now,
    updatedAt: now,
    amount: 0,
    goods: []
  };
  store.events.push(event);
  const accessRules = {} as AccessRulesService;
  const service = new CabinetEventsService(
    store,
    accessRules,
    {
      verifySignedPayload: () => true,
      isUsingMockTransport: () => false
    } as never,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({})
  );

  const result = service.handleDoorStatus({
    eventId: event.eventId,
    deviceCode: device.deviceCode,
    clientId: "trusted-smartvm",
    timestamp: Math.floor(Date.now() / 1000),
    nonceStr: "settled-close",
    sign: "verified",
    status: "CLOSED",
    doorIsOpen: "N"
  });

  assert.equal("ignored" in result && result.ignored === true, false);
  assert.equal(event.status, "settled");
  assert.equal(store.getDeviceRuntime(device.deviceCode).doorState, "closed");
  assert.ok(store.getDeviceRuntime(device.deviceCode).lastClosedAt);
});
