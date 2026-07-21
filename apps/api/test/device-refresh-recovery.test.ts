import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { CabinetEventRecord, SmartVmRouterStatusResult } from "@vm/shared-types";

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
  getRouterStatus: () => Promise<SmartVmRouterStatusResult | undefined>
) =>
  new DevicesService(
    store,
    new InventoryBatchChangesService(store),
    { getRouterStatus } as unknown as SmartVmGateway
  );

const createEvent = (
  deviceCode: string,
  overrides: Partial<CabinetEventRecord> = {}
): CabinetEventRecord => {
  const oldTimestamp = "2026-01-01T00:00:00.000Z";
  return {
    eventId: `event-refresh-${Math.random().toString(36).slice(2)}`,
    orderNo: `order-refresh-${Math.random().toString(36).slice(2)}`,
    userId: "special-refresh",
    phone: "13800009991",
    role: "special",
    deviceCode,
    doorNum: "1",
    status: "opened",
    physicalDoorState: "open",
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp,
    amount: 0,
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

test("可信 SmartVM 刷新明确返回关门时恢复未决物理状态且不回退业务终态", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  const otherDevice = store.devices[1];
  assert.ok(device);
  assert.ok(otherDevice);
  store.events.splice(0, store.events.length);

  const recoverableEvents = (["created", "opening", "opened", "stuck_open"] as const).map(
    (status) =>
      createEvent(device.deviceCode, {
        eventId: `event-refresh-${status}`,
        status,
        physicalDoorState: status === "opening" ? "unknown" : "open"
      })
  );
  const settledEvent = createEvent(device.deviceCode, {
    eventId: "event-refresh-settled",
    status: "settled",
    physicalDoorState: "unknown"
  });
  const refundedEvent = createEvent(device.deviceCode, {
    eventId: "event-refresh-refunded",
    status: "refunded"
  });
  const unrelatedEvent = createEvent(otherDevice.deviceCode, {
    eventId: "event-refresh-unrelated"
  });
  store.events.push(...recoverableEvents, settledEvent, refundedEvent, unrelatedEvent);
  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "open",
    lastClosedAt: "2025-01-01T00:00:00.000Z",
    openedAfterLastCommand: true
  });

  const service = createService(store, async () => ({
    online: "0",
    doorState: "1"
  }));

  await service.refreshDevice(device.deviceCode, "admin-refresh");

  for (const event of recoverableEvents) {
    assert.equal(event.status, "closed");
    assert.equal(event.physicalDoorState, "closed");
    assert.notEqual(event.updatedAt, "2026-01-01T00:00:00.000Z");
  }
  assert.equal(settledEvent.status, "settled");
  assert.equal(settledEvent.physicalDoorState, "closed");
  assert.equal(refundedEvent.status, "refunded");
  assert.equal(refundedEvent.physicalDoorState, "closed");
  assert.equal(unrelatedEvent.status, "opened");
  assert.equal(unrelatedEvent.physicalDoorState, "open");

  const runtime = store.getDeviceRuntime(device.deviceCode);
  assert.equal(runtime.doorState, "closed");
  assert.notEqual(runtime.lastClosedAt, "2025-01-01T00:00:00.000Z");
  assert.equal(runtime.openedAfterLastCommand, true);

  const refreshLog = store.logs.find((entry) => entry.type === "manual-refresh-device");
  assert.equal(refreshLog?.metadata?.recoveredPhysicalDoorEventCount, 6);
  assert.equal(refreshLog?.metadata?.doorRecoveryEvidence, "trusted-remote-closed");
});

test("平台未返回门状态时只刷新观测时间，不恢复未决事件", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  assert.ok(device);
  store.events.splice(0, store.events.length);

  const pendingEvent = createEvent(device.deviceCode);
  store.events.push(pendingEvent);
  const originalLastClosedAt = "2025-01-01T00:00:00.000Z";
  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "open",
    lastClosedAt: originalLastClosedAt,
    openedAfterLastCommand: true
  });

  const service = createService(store, async () => ({ online: "0" }));
  await service.refreshDevice(device.deviceCode, "admin-refresh");

  assert.equal(pendingEvent.status, "opened");
  assert.equal(pendingEvent.physicalDoorState, "open");
  assert.equal(pendingEvent.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(store.getDeviceRuntime(device.deviceCode).doorState, "open");
  assert.equal(store.getDeviceRuntime(device.deviceCode).lastClosedAt, originalLastClosedAt);

  const refreshLog = store.logs.find((entry) => entry.type === "manual-refresh-device");
  assert.equal(refreshLog?.metadata?.recoveredPhysicalDoorEventCount, 0);
  assert.equal(refreshLog?.metadata?.doorRecoveryEvidence, "remote-door-state-missing");
});

test("本地未配置 SmartVM 凭据时不得借刷新解除物理占用", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  assert.ok(device);
  store.events.splice(0, store.events.length);

  const pendingEvent = createEvent(device.deviceCode, { physicalDoorState: "unknown" });
  store.events.push(pendingEvent);
  store.updateDeviceRuntime(device.deviceCode, {
    doorState: "unknown",
    openedAfterLastCommand: false
  });

  const service = createService(store, async () => undefined);
  await service.refreshDevice(device.deviceCode, "admin-refresh");

  assert.equal(pendingEvent.status, "opened");
  assert.equal(pendingEvent.physicalDoorState, "unknown");
  assert.equal(store.getDeviceRuntime(device.deviceCode).doorState, "unknown");
  const refreshLog = store.logs.find((entry) => entry.type === "manual-refresh-device");
  assert.equal(refreshLog?.metadata?.recoveredPhysicalDoorEventCount, 0);
  assert.equal(refreshLog?.metadata?.doorRecoveryEvidence, "smartvm-not-configured");
});
