import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../apps/api/src/app.module";
import { InventoryBatchChangesService } from "../apps/api/src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../apps/api/src/common/store/in-memory-store.service";
import { hashAdminPassword } from "../apps/api/src/modules/auth/admin-password.utils";
import { listenOnFetchSafeLoopbackPort } from "../apps/api/test/support/fetch-safe-api-listener";
import { PUBLIC_API_BASE_URL, runPublicAppAcceptance } from "./public-app-acceptance.mjs";

const environmentKeys = [
  "NODE_ENV",
  "APP_ENV",
  "VM_TEST_ISOLATED_ENV",
  "VM_DATA_PLANE",
  "VM_DATA_ROOT",
  "VM_DATA_PLANE_ID",
  "VM_SIMULATION_PROFILE",
  "VM_FULL_SIMULATION_ENABLED",
  "VM_FULL_SIMULATION_SMARTVM_MODE",
  "VM_FULL_SIMULATION_PAYMENT_MODE",
  "VM_FULL_SIMULATION_VERIFICATION_MODE",
  "VM_FULL_SIMULATION_AI_MODE",
  "VM_FULL_SIMULATION_MAP_MODE",
  "VM_RESERVATION_ONLY_PICKUP",
  "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE",
  "PAYMENT_MODE",
  "VERIFICATION_CODE_PROVIDER",
  "VERIFICATION_CODE_PREVIEW_ENABLED",
  "ENABLE_TEST_DEVICE_BOOTSTRAP",
  "ENABLE_LOCAL_MOCK_DEVICE_API",
  "API_DATA_FILE",
  "UPLOAD_DIR",
  "SYSTEM_LOG_FILE",
  "API_BACKUP_DIR",
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE"
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
) as Record<(typeof environmentKeys)[number], string | undefined>;
const temporaryDirectories: string[] = [];

after(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
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

const configureIsolatedEnvironment = (runtimeRoot: string) => {
  Object.assign(process.env, {
    NODE_ENV: "development",
    APP_ENV: "development",
    VM_TEST_ISOLATED_ENV: "1",
    VM_DATA_PLANE: "simulation",
    VM_DATA_ROOT: runtimeRoot,
    VM_DATA_PLANE_ID: "public-runner-integration",
    VM_SIMULATION_PROFILE: "full",
    VM_FULL_SIMULATION_ENABLED: "true",
    VM_FULL_SIMULATION_SMARTVM_MODE: "mock",
    VM_FULL_SIMULATION_PAYMENT_MODE: "mock",
    VM_FULL_SIMULATION_VERIFICATION_MODE: "manual",
    VM_FULL_SIMULATION_AI_MODE: "mock",
    VM_FULL_SIMULATION_MAP_MODE: "mock",
    VM_RESERVATION_ONLY_PICKUP: "true",
    SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE: "auto",
    PAYMENT_MODE: "mock",
    VERIFICATION_CODE_PROVIDER: "mock",
    VERIFICATION_CODE_PREVIEW_ENABLED: "false",
    ENABLE_TEST_DEVICE_BOOTSTRAP: "false",
    ENABLE_LOCAL_MOCK_DEVICE_API: "false"
  });
  for (const key of [
    "API_DATA_FILE",
    "UPLOAD_DIR",
    "SYSTEM_LOG_FILE",
    "API_BACKUP_DIR",
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE"
  ]) {
    delete process.env[key];
  }
};

test("受控公网验收模块通过真实隔离 API 完成 App 登录、预约、重放拒绝和夹具清理", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "vm-public-app-acceptance-"));
  temporaryDirectories.push(runtimeRoot);
  configureIsolatedEnvironment(runtimeRoot);

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  const port = await listenOnFetchSafeLoopbackPort(app);
  const localApiBaseUrl = `http://127.0.0.1:${port}/api`;

  try {
    const store = app.get(InMemoryStoreService);
    const seedCredential = store.backofficeCredentials.find((entry) => entry.role === "admin");
    assert.ok(seedCredential);
    assert.equal(seedCredential.username, "admin");
    const passwordHash = hashAdminPassword("isolated-runner-password");
    store.upsertBackofficeCredential({
      ...seedCredential,
      passwordSalt: passwordHash.salt,
      passwordHash: passwordHash.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: new Date().toISOString()
    });

    const device = store.devices[0];
    const door = device?.doors[0];
    const goods = door?.goods[0];
    assert.ok(device);
    assert.ok(door);
    assert.ok(goods);
    new InventoryBatchChangesService(store).recordBatchOnly({
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      quantity: 3,
      sourceType: "system"
    });
    store.persist();
    const baselineEventCount = store.events.length;
    const baselinePaymentOrderCount = store.paymentOrders.length;
    const baselineActiveReservationCount = store.reservations.filter(
      (entry) => entry.status === "active"
    ).length;

    const report: Array<{ stage: string; outcome: string }> = [];
    const result = await runPublicAppAcceptance({
      inputs: {
        adminPassword: "isolated-runner-password",
        testPhone: "18800000012",
        manualCode: "314159"
      },
      fetchImpl: (url, init) => {
        const parsed = new URL(url);
        assert.equal(`${parsed.origin}${parsed.pathname.slice(0, 4)}`, "https://vending.5gogogo.top/api");
        return fetch(`${localApiBaseUrl}${parsed.pathname.slice("/api".length)}`, init);
      },
      report: (event) => report.push(event)
    });

    assert.deepEqual(result, {
      publicIngressVerified: true,
      manualCodeReplayRejected: true,
      reservationCancelled: true,
      fixtureRemoved: true
    });
    assert.ok(report.some((entry) => entry.stage === "核验人工码已消费" && entry.outcome === "passed"));
    assert.equal(store.users.some((entry) => entry.phone === "18800000012"), false);
    assert.equal(
      store.reservations.filter((entry) => entry.status === "active").length,
      baselineActiveReservationCount
    );
    assert.equal(store.events.length, baselineEventCount);
    assert.equal(store.paymentOrders.length, baselinePaymentOrderCount);
  } finally {
    await app.close();
  }
});
