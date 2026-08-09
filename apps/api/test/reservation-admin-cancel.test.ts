import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NestFactory } from "@nestjs/core";
import type { CabinetReservationRecord, DeviceRecord, UserRecord } from "@vm/shared-types";

import { AppModule } from "../src/app.module";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { listenOnFetchSafeLoopbackPort } from "./support/fetch-safe-api-listener";

const buildReservation = (
  id: string,
  user: UserRecord,
  device: DeviceRecord,
  status: CabinetReservationRecord["status"] = "active"
): CabinetReservationRecord => {
  const now = new Date();
  return {
    id,
    userId: user.id,
    phone: user.phone,
    userName: user.name,
    deviceCode: device.deviceCode,
    doorNum: "1",
    status,
    inventoryReservationMode: "goods_quantity",
    batchAllocationTiming: "on_open",
    items: [],
    reservedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
};

test("实例管理员只能查看并取消当前实例的有效预约，且必须记录原因", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-admin-cancel-reservation-"));
  const originalDataFile = process.env.API_DATA_FILE;
  const originalBootstrap = process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  const port = await listenOnFetchSafeLoopbackPort(app);

  try {
    const store = app.get(InMemoryStoreService);
    const tenantId = store.getDefaultTenantId();
    const credential = store.backofficeCredentials.find(
      (entry) => entry.role === "admin" && entry.tenantId === tenantId
    );
    const actor = store.users.find(
      (entry) => entry.id === credential?.userId && entry.status === "active"
    );
    const user = store.users.find(
      (entry) => entry.role === "special" && store.getUserTenantId(entry) === tenantId
    );
    const device = store.devices.find(
      (entry) => store.getDeviceTenantId(entry) === tenantId
    );
    assert.ok(credential);
    assert.ok(actor);
    assert.ok(user);
    assert.ok(device);
    credential.permissions = ["users:view", "reservations:manage"];
    const token = store.createBackofficeSession(actor, "admin", tenantId);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };

    const foreignTenantId = "tenant-reservation-foreign";
    const foreignUser: UserRecord = {
      ...structuredClone(user),
      id: "special-reservation-foreign",
      phone: "13000008887",
      name: "其他实例用户",
      tenantId: foreignTenantId
    };
    const foreignDevice: DeviceRecord = {
      ...structuredClone(device),
      deviceCode: "device-reservation-foreign",
      tenantId: foreignTenantId
    };
    store.users.push(foreignUser);
    store.devices.push(foreignDevice);

    const active = buildReservation("reservation-admin-active", user, device);
    const missingReason = buildReservation("reservation-admin-missing-reason", user, device);
    const fulfilled = buildReservation("reservation-admin-fulfilled", user, device, "fulfilled");
    const foreign = buildReservation(
      "reservation-admin-foreign",
      foreignUser,
      foreignDevice
    );
    store.reservations.splice(0, store.reservations.length, active, missingReason, fulfilled, foreign);

    const baseUrl = `http://127.0.0.1:${port}/api`;
    const listResponse = await fetch(
      `${baseUrl}/reservations?userId=${encodeURIComponent(user.id)}`,
      { headers }
    );
    const listBody = (await listResponse.json()) as {
      data?: CabinetReservationRecord[];
    };
    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      listBody.data?.map((entry) => entry.id).sort(),
      [active.id, fulfilled.id, missingReason.id].sort()
    );

    const missingReasonResponse = await fetch(
      `${baseUrl}/reservations/${encodeURIComponent(missingReason.id)}/cancel`,
      { method: "POST", headers, body: JSON.stringify({}) }
    );
    assert.equal(missingReasonResponse.status, 400);
    assert.equal(missingReason.status, "active");

    const cancelResponse = await fetch(
      `${baseUrl}/reservations/${encodeURIComponent(active.id)}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "用户来电确认不再领取。" })
      }
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal(active.status, "cancelled");
    assert.equal(active.cancellationReason, "用户来电确认不再领取。");
    assert.equal(active.cancelledByUserId, actor.id);
    assert.equal(
      store.logs.some(
        (entry) =>
          entry.type === "cancel-reservation" &&
          entry.actor.id === actor.id &&
          entry.metadata?.reservationId === active.id &&
          entry.metadata?.reason === active.cancellationReason
      ),
      true
    );

    const replayResponse = await fetch(
      `${baseUrl}/reservations/${encodeURIComponent(active.id)}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "再次取消。" })
      }
    );
    assert.equal(replayResponse.status, 409);

    const fulfilledResponse = await fetch(
      `${baseUrl}/reservations/${encodeURIComponent(fulfilled.id)}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "错误尝试取消已领取预约。" })
      }
    );
    assert.equal(fulfilledResponse.status, 409);

    const foreignResponse = await fetch(
      `${baseUrl}/reservations/${encodeURIComponent(foreign.id)}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "不应跨实例取消。" })
      }
    );
    assert.equal(foreignResponse.status, 404);
    assert.equal(foreign.status, "active");
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
});
