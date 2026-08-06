import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import type { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP
};

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-device-refresh-recovery-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
};

const createService = (
  store: InMemoryStoreService,
  gateway: Pick<SmartVmGateway, "probeDevice" | "extractErrorMessage">
) =>
  new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    gateway as SmartVmGateway
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

test("刷新真实柜机时通过 1.1 只读接口确认平台识别，不伪造物理门状态", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  assert.ok(device);
  device.status = "offline";
  device.lastSeenAt = "2026-01-01T00:00:00.000Z";
  store.events.splice(0, store.events.length);
  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "unknown",
    lastRefreshAt: "2026-01-01T00:00:00.000Z"
  });

  const calls: Array<{ deviceCode: string; doorNum?: string }> = [];
  const service = createService(store, {
    probeDevice: async (payload) => {
      calls.push(payload);
      return { recognized: true as const };
    },
    extractErrorMessage: () => "柜机平台请求失败。"
  });

  await service.refreshDevice(device.deviceCode, "admin-refresh");

  assert.deepEqual(calls, [
    { deviceCode: device.deviceCode, doorNum: device.doors[0]?.doorNum }
  ]);
  assert.equal(device.status, "online");
  assert.notEqual(device.lastSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(store.getDeviceRuntime(device.deviceCode).doorState, "unknown");
  assert.equal(
    store.getDeviceRuntime(device.deviceCode).lastRefreshAt,
    device.lastSeenAt
  );

  const refreshLog = store.logs.find((entry) => entry.type === "manual-refresh-device");
  assert.equal(refreshLog?.status, "success");
  assert.equal(refreshLog?.metadata?.platformRecognition, "confirmed");
  assert.equal(refreshLog?.metadata?.doorStateEvidence, "callback-required");
});

test("未配置 SmartVM 时刷新只更新操作时间，不伪造平台识别或在线状态", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  assert.ok(device);
  device.status = "offline";
  device.lastSeenAt = "2026-01-01T00:00:00.000Z";
  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "unknown",
    lastRefreshAt: "2026-01-01T00:00:00.000Z"
  });

  const service = createService(store, {
    probeDevice: async () => undefined,
    extractErrorMessage: () => "柜机平台请求失败。"
  });

  await service.refreshDevice(device.deviceCode, "admin-refresh");

  assert.equal(device.status, "offline");
  assert.equal(device.lastSeenAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(
    store.getDeviceRuntime(device.deviceCode).lastRefreshAt,
    "2026-01-01T00:00:00.000Z"
  );

  const refreshLog = store.logs.find((entry) => entry.type === "manual-refresh-device");
  assert.equal(refreshLog?.metadata?.platformRecognition, "not-configured");
  assert.equal(refreshLog?.metadata?.doorStateEvidence, "callback-required");
});

test("平台确认失败时保留原设备状态并返回经过收敛的错误", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  assert.ok(device);
  device.status = "offline";
  const originalLastSeenAt = device.lastSeenAt;
  const service = createService(store, {
    probeDevice: async () => {
      throw new Error("<!doctype html><title>HTTP Status 405</title>");
    },
    extractErrorMessage: () => "柜机平台请求失败（HTTP 405）。"
  });

  await assert.rejects(
    service.refreshDevice(device.deviceCode, "admin-refresh"),
    (error: unknown) =>
      error instanceof Error &&
      /柜机平台请求失败（HTTP 405）/.test(error.message) &&
      !/doctype|html|Tomcat/i.test(error.message)
  );

  assert.equal(device.status, "offline");
  assert.equal(device.lastSeenAt, originalLastSeenAt);
  const refreshLog = store.logs.find((entry) => entry.type === "manual-refresh-device");
  assert.equal(refreshLog?.status, "failed");
  assert.ok(!/doctype|html|Tomcat/i.test(refreshLog?.detail ?? ""));
});
