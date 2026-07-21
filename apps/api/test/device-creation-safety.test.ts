import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ForbiddenException } from "@nestjs/common";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import type { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP,
  ENABLE_LOCAL_MOCK_DEVICE_API: process.env.ENABLE_LOCAL_MOCK_DEVICE_API,
  API_HOST: process.env.API_HOST,
  NODE_ENV: process.env.NODE_ENV,
  APP_ENV: process.env.APP_ENV
};

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-device-creation-safety-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  delete process.env.ENABLE_LOCAL_MOCK_DEVICE_API;
  process.env.API_HOST = "127.0.0.1";
  process.env.NODE_ENV = "test";
  delete process.env.APP_ENV;
  return new InMemoryStoreService();
};

const createService = (store: InMemoryStoreService) =>
  new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    {} as SmartVmGateway
  );

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

test("真实设备录入不伪造关门状态，模拟接口仅在显式本地夹具模式可用", () => {
  const defaultBootstrapDirectory = mkdtempSync(
    join(tmpdir(), "vm-device-bootstrap-default-")
  );
  temporaryDirectories.push(defaultBootstrapDirectory);
  process.env.API_DATA_FILE = join(defaultBootstrapDirectory, "store.json");
  process.env.NODE_ENV = "test";
  delete process.env.APP_ENV;
  delete process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
  const defaultBootstrapStore = new InMemoryStoreService();
  assert.equal(
    defaultBootstrapStore.devices.some((entry) => entry.deviceCode === "91120149"),
    false
  );

  const store = createIsolatedStore();
  const service = createService(store);

  const realDevice = service.upsertDevice({
    deviceCode: "REAL-NEW-001",
    name: "新录入真实柜机",
    location: "待平台确认点位"
  });
  const realRuntime = store.getDeviceRuntime("REAL-NEW-001");
  assert.equal(realDevice.runtime?.doorState, "unknown");
  assert.equal(realRuntime.doorState, "unknown");
  assert.equal(realRuntime.lastRefreshAt, undefined);
  assert.equal(realRuntime.lastClosedAt, undefined);
  assert.equal(realRuntime.openedAfterLastCommand, false);

  const disabledState = {
    devices: store.devices.length,
    batches: store.goodsBatches.length,
    catalog: store.goodsCatalog.length,
    logs: store.logs.length
  };
  assert.throws(
    () =>
      service.upsertMockDevice({
        deviceCode: "DISABLED-MOCK-001",
        name: "未启用模拟柜机",
        location: "本地测试点位",
        goods: [
          {
            goodsId: "disabled-goods",
            name: "不应写入的物资",
            category: "daily",
            stock: 1
          }
        ]
      }),
    (error) =>
      error instanceof ForbiddenException &&
      /未启用/.test(error.message)
  );
  assert.deepEqual(
    {
      devices: store.devices.length,
      batches: store.goodsBatches.length,
      catalog: store.goodsCatalog.length,
      logs: store.logs.length
    },
    disabledState
  );

  process.env.ENABLE_LOCAL_MOCK_DEVICE_API = "true";
  service.upsertMockDevice({
    deviceCode: "LOCAL-MOCK-001",
    name: "本地模拟柜机",
    location: "本地测试点位",
    status: "online",
    goods: []
  });
  const mockRuntime = store.getDeviceRuntime("LOCAL-MOCK-001");
  assert.equal(
    store.devices.find((entry) => entry.deviceCode === "LOCAL-MOCK-001")?.isMock,
    true
  );
  assert.equal(mockRuntime.doorState, "closed");
  assert.ok(mockRuntime.lastClosedAt);
  assert.ok(mockRuntime.lastRefreshAt);
  assert.equal(mockRuntime.openedAfterLastCommand, true);

  store.updateDeviceRuntime("LOCAL-MOCK-001", {
    doorState: "unknown",
    openedAfterLastCommand: false
  });
  service.upsertMockDevice({
    deviceCode: "LOCAL-MOCK-001",
    name: "本地模拟柜机（更新）",
    location: "本地测试点位",
    status: "online",
    goods: []
  });
  assert.equal(store.getDeviceRuntime("LOCAL-MOCK-001").doorState, "closed");
  assert.equal(store.getDeviceRuntime("LOCAL-MOCK-001").openedAfterLastCommand, true);

  process.env.API_HOST = "0.0.0.0";
  assert.throws(
    () =>
      service.upsertMockDevice({
        deviceCode: "NON-LOOPBACK-MOCK-001",
        name: "非回环模拟柜机",
        location: "不允许的监听地址",
        goods: []
      }),
    (error) =>
      error instanceof ForbiddenException &&
      /未启用/.test(error.message)
  );
  assert.equal(
    store.devices.some((entry) => entry.deviceCode === "NON-LOOPBACK-MOCK-001"),
    false
  );
  process.env.API_HOST = "127.0.0.1";

  assert.throws(
    () =>
      service.upsertMockDevice({
        deviceCode: "REAL-NEW-001",
        name: "试图覆盖真实设备",
        location: "本地测试点位",
        goods: []
      }),
    (error) =>
      error instanceof ForbiddenException &&
      /不能用模拟柜机接口覆盖真实设备/.test(error.message)
  );
  assert.equal(store.devices.find((entry) => entry.deviceCode === "REAL-NEW-001")?.isMock, undefined);

  const productionState = {
    devices: store.devices.length,
    batches: store.goodsBatches.length,
    catalog: store.goodsCatalog.length,
    logs: store.logs.length
  };
  process.env.APP_ENV = "production";
  try {
    assert.throws(
      () =>
        service.upsertMockDevice({
          deviceCode: "FORBIDDEN-MOCK-001",
          name: "不应创建的模拟柜机",
          location: "生产环境",
          goods: []
        }),
      (error) =>
        error instanceof ForbiddenException &&
        /未启用/.test(error.message)
    );
    assert.deepEqual(
      {
        devices: store.devices.length,
        batches: store.goodsBatches.length,
        catalog: store.goodsCatalog.length,
        logs: store.logs.length
      },
      productionState
    );
  } finally {
    delete process.env.APP_ENV;
  }
});
