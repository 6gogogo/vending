import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../apps/api/src/app.module";
import {
  createEmptyPersistedState,
  writePersistedState
} from "../apps/api/src/common/store/persistence";
import { InMemoryStoreService } from "../apps/api/src/common/store/in-memory-store.service";
import { hashAdminPassword } from "../apps/api/src/modules/auth/admin-password.utils";
import { DeviceOperationCoordinator } from "../apps/api/src/modules/devices/device-operation-coordinator";
import { listenOnFetchSafeLoopbackPort } from "../apps/api/test/support/fetch-safe-api-listener";
import { PUBLIC_API_BASE_URL, runPublicAppAcceptance } from "./public-app-acceptance.mjs";

const environmentKeys = [
  "NODE_ENV",
  "APP_ENV",
  "VM_TEST_ISOLATED_ENV",
  "VM_DATA_PLANE",
  "VM_DATA_ROOT",
  "VM_DATA_PLANE_ID",
  "VM_PLATFORM_TENANT_NAME",
  "PUBLIC_BASE_URL",
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
const fixtureDeviceCode = "SIM-APP-ACCEPTANCE-001";
const fixtureGoodsId = "goods-sim-app-reserve-pack";

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
    "VM_PLATFORM_TENANT_NAME",
    "PUBLIC_BASE_URL",
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

  // 复现公网当前的空模拟数据快照：运行器不能依赖开发种子库存。
  writePersistedState(createEmptyPersistedState("simulation", "public-runner-integration"));

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
    assert.equal(device.deviceCode, fixtureDeviceCode);
    assert.equal(device.isMock, true);
    assert.ok(goods.stock >= 1);
    const deviceOperations = app.get(DeviceOperationCoordinator);
    const fixtureReadiness = deviceOperations.getReadiness(
      device.deviceCode,
      Date.parse(device.lastSeenAt) + 6 * 60_000
    );
    assert.equal(fixtureReadiness.connectivity, "online");
    assert.equal(fixtureReadiness.canOpen, true);
    store.persist();
    const restartedStore = new InMemoryStoreService();
    assert.equal(
      restartedStore.devices.filter((entry) => entry.deviceCode === fixtureDeviceCode).length,
      1
    );
    assert.equal(
      restartedStore.goodsBatches.filter(
        (entry) => entry.deviceCode === fixtureDeviceCode && entry.goodsId === fixtureGoodsId
      ).length,
      1
    );
    assert.equal(restartedStore.flushBootstrapPersistence(), false);
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

test("仅严格隔离的全真模拟人工码组合补建 App 预约体验库存", () => {
  const disabledConfigurations = [
    {
      label: "标准模拟",
      configure: () => {
        process.env.VM_SIMULATION_PROFILE = "standard";
      }
    },
    {
      label: "真实柜机传输",
      configure: () => {
        process.env.VM_FULL_SIMULATION_SMARTVM_MODE = "real";
      }
    },
    {
      label: "真实支付传输",
      configure: () => {
        process.env.VM_FULL_SIMULATION_PAYMENT_MODE = "real";
      }
    },
    {
      label: "非人工验证码",
      configure: () => {
        process.env.VM_FULL_SIMULATION_VERIFICATION_MODE = "mock";
      }
    }
  ];

  for (const configuration of disabledConfigurations) {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "vm-public-app-acceptance-disabled-"));
    temporaryDirectories.push(runtimeRoot);
    configureIsolatedEnvironment(runtimeRoot);
    configuration.configure();
    writePersistedState(createEmptyPersistedState("simulation", "public-runner-integration"));

    const store = new InMemoryStoreService();
    assert.equal(
      store.devices.some((entry) => entry.deviceCode === fixtureDeviceCode),
      false,
      configuration.label
    );
  }
});

test("其他实例的库存不会阻止当前实例补建 App 预约体验库存", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "vm-public-app-acceptance-other-tenant-"));
  temporaryDirectories.push(runtimeRoot);
  configureIsolatedEnvironment(runtimeRoot);
  const state = createEmptyPersistedState("simulation", "public-runner-integration");
  const createdAt = new Date().toISOString();
  state.platformTenants.push({
    id: "tenant-b",
    code: "other",
    name: "其他模拟实例",
    status: "active",
    instanceUrl: "https://other.example.test",
    createdAt
  });
  state.devices = [
    {
      deviceCode: "SIM-OTHER-TENANT-001",
      tenantId: "tenant-b",
      isMock: true,
      name: "其他实例模拟柜",
      location: "隔离全模拟环境",
      status: "online",
      lastSeenAt: createdAt,
      doors: [
        {
          doorNum: "1",
          label: "体验柜门",
          goods: [
            {
              goodsCode: "SIM-OTHER-TENANT-PACK",
              goodsId: "goods-sim-other-tenant-pack",
              name: "其他实例体验包",
              fullName: "其他实例体验包",
              category: "food",
              categoryName: "食品",
              price: 0,
              imageUrl: "",
              packageForm: "体验装",
              specification: "1 份",
              manufacturer: "公益智助柜模拟服务",
              status: "active",
              stock: 1
            }
          ]
        }
      ]
    }
  ];
  state.goodsCatalog = [
    {
      goodsCode: "SIM-OTHER-TENANT-PACK",
      goodsId: "goods-sim-other-tenant-pack",
      name: "其他实例体验包",
      fullName: "其他实例体验包",
      category: "food",
      categoryName: "食品",
      price: 0,
      imageUrl: "",
      packageForm: "体验装",
      specification: "1 份",
      manufacturer: "公益智助柜模拟服务",
      status: "active"
    }
  ];
  state.goodsBatches = [
    {
      batchId: "batch-sim-other-tenant-pack",
      deviceCode: "SIM-OTHER-TENANT-001",
      goodsId: "goods-sim-other-tenant-pack",
      quantity: 1,
      remainingQuantity: 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      createdAt,
      sourceType: "system",
      sourceUserName: "全模拟基线"
    }
  ];
  writePersistedState(state);

  const store = new InMemoryStoreService();
  const fixture = store.devices.find((entry) => entry.deviceCode === fixtureDeviceCode);
  assert.ok(fixture);
  assert.equal(store.getDeviceTenantId(fixture), "tenant-a");
  assert.equal(
    store.devices.find((entry) => entry.deviceCode === "SIM-OTHER-TENANT-001")?.tenantId,
    "tenant-b"
  );
});

test("混合过期库存和已超时预约时保留既有可预约库存，并让运行器跳过不可预约商品", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "vm-public-app-acceptance-mixed-stock-"));
  temporaryDirectories.push(runtimeRoot);
  configureIsolatedEnvironment(runtimeRoot);
  const now = new Date();
  const state = createEmptyPersistedState("simulation", "public-runner-integration");
  const createdAt = now.toISOString();
  const expiredAt = new Date(now.getTime() - 60_000).toISOString();
  const futureExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();

  state.devices = [
    {
      deviceCode: "SIM-STALE-001",
      tenantId: "tenant-a",
      isMock: true,
      name: "已过期模拟柜",
      location: "隔离全模拟环境",
      status: "online",
      lastSeenAt: createdAt,
      doors: [
        {
          doorNum: "1",
          label: "体验柜门",
          goods: [
            {
              goodsCode: "SIM-STALE-PACK",
              goodsId: "goods-sim-stale-pack",
              name: "过期体验包",
              fullName: "过期体验包",
              category: "food",
              categoryName: "食品",
              price: 0,
              imageUrl: "",
              packageForm: "体验装",
              specification: "1 份",
              manufacturer: "公益智助柜模拟服务",
              status: "active",
              stock: 1
            }
          ]
        }
      ]
    },
    {
      deviceCode: "SIM-AVAILABLE-001",
      tenantId: "tenant-a",
      isMock: true,
      name: "可预约模拟柜",
      location: "隔离全模拟环境",
      status: "online",
      lastSeenAt: createdAt,
      doors: [
        {
          doorNum: "1",
          label: "体验柜门",
          goods: [
            {
              goodsCode: "SIM-AVAILABLE-PACK",
              goodsId: "goods-sim-available-pack",
              name: "可预约体验包",
              fullName: "可预约体验包",
              category: "food",
              categoryName: "食品",
              price: 0,
              imageUrl: "",
              packageForm: "体验装",
              specification: "1 份",
              manufacturer: "公益智助柜模拟服务",
              status: "active",
              stock: 1
            }
          ]
        }
      ]
    }
  ];
  state.goodsCatalog = [
    {
      goodsCode: "SIM-STALE-PACK",
      goodsId: "goods-sim-stale-pack",
      name: "过期体验包",
      fullName: "过期体验包",
      category: "food",
      categoryName: "食品",
      price: 0,
      imageUrl: "",
      packageForm: "体验装",
      specification: "1 份",
      manufacturer: "公益智助柜模拟服务",
      status: "active"
    },
    {
      goodsCode: "SIM-AVAILABLE-PACK",
      goodsId: "goods-sim-available-pack",
      name: "可预约体验包",
      fullName: "可预约体验包",
      category: "food",
      categoryName: "食品",
      price: 0,
      imageUrl: "",
      packageForm: "体验装",
      specification: "1 份",
      manufacturer: "公益智助柜模拟服务",
      status: "active"
    }
  ];
  state.goodsBatches = [
    {
      batchId: "batch-sim-stale-pack",
      deviceCode: "SIM-STALE-001",
      goodsId: "goods-sim-stale-pack",
      quantity: 1,
      remainingQuantity: 1,
      expiresAt: expiredAt,
      createdAt,
      sourceType: "system",
      sourceUserName: "全模拟基线"
    },
    {
      batchId: "batch-sim-available-pack",
      deviceCode: "SIM-AVAILABLE-001",
      goodsId: "goods-sim-available-pack",
      quantity: 1,
      remainingQuantity: 1,
      expiresAt: futureExpiresAt,
      createdAt,
      sourceType: "system",
      sourceUserName: "全模拟基线"
    }
  ];
  // 这条预约仍标记 active，但已自然超时；不能继续占用候选库存。
  state.reservations = [
    {
      id: "reservation-expired-stock",
      userId: "expired-reservation-user",
      phone: "fixture-user",
      userName: "历史预约夹具",
      deviceCode: "SIM-AVAILABLE-001",
      doorNum: "1",
      status: "active",
      inventoryReservationMode: "goods_quantity",
      batchAllocationTiming: "on_open",
      items: [
        {
          goodsId: "goods-sim-available-pack",
          goodsName: "可预约体验包",
          category: "food",
          quantity: 1
        }
      ],
      reservedAt: expiredAt,
      expiresAt: expiredAt,
      createdAt: expiredAt,
      updatedAt: expiredAt
    }
  ];
  writePersistedState(state);

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  const port = await listenOnFetchSafeLoopbackPort(app);
  const localApiBaseUrl = `http://127.0.0.1:${port}/api`;

  try {
    const store = app.get(InMemoryStoreService);
    assert.equal(store.devices.some((entry) => entry.deviceCode === fixtureDeviceCode), false);
    assert.equal(store.goodsBatches.length, 2);
    const seedCredential = store.backofficeCredentials.find((entry) => entry.role === "admin");
    assert.ok(seedCredential);
    const passwordHash = hashAdminPassword("isolated-mixed-stock-password");
    store.upsertBackofficeCredential({
      ...seedCredential,
      passwordSalt: passwordHash.salt,
      passwordHash: passwordHash.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: createdAt
    });
    store.persist();

    let firstAdminDeviceList:
      | Array<{
          deviceCode?: string;
          doors?: Array<{ goods?: Array<{ stock?: number }> }>;
        }>
      | undefined;
    const result = await runPublicAppAcceptance({
      inputs: {
        adminPassword: "isolated-mixed-stock-password",
        testPhone: "18800000013",
        manualCode: "271828"
      },
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        assert.equal(`${parsed.origin}${parsed.pathname.slice(0, 4)}`, "https://vending.5gogogo.top/api");
        const response = await fetch(`${localApiBaseUrl}${parsed.pathname.slice("/api".length)}`, init);

        if (parsed.pathname === "/api/devices" && !firstAdminDeviceList) {
          const payload = (await response.clone().json()) as {
            data?: typeof firstAdminDeviceList;
          };
          firstAdminDeviceList = Array.isArray(payload.data) ? payload.data : undefined;
        }

        return response;
      }
    });

    assert.deepEqual(result, {
      publicIngressVerified: true,
      manualCodeReplayRejected: true,
      reservationCancelled: true,
      fixtureRemoved: true
    });
    const staleDevice = firstAdminDeviceList?.find(
      (entry) => entry.deviceCode === "SIM-STALE-001"
    );
    const availableDevice = firstAdminDeviceList?.find(
      (entry) => entry.deviceCode === "SIM-AVAILABLE-001"
    );
    assert.equal(staleDevice?.doors?.[0]?.goods?.[0]?.stock, 0);
    assert.ok((availableDevice?.doors?.[0]?.goods?.[0]?.stock ?? 0) >= 1);
    assert.equal(store.devices.some((entry) => entry.deviceCode === fixtureDeviceCode), false);
    assert.equal(store.goodsBatches.length, 2);
  } finally {
    await app.close();
  }
});

test("真实数据平面不补建 App 预约体验库存", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "vm-public-app-acceptance-live-"));
  temporaryDirectories.push(runtimeRoot);
  configureIsolatedEnvironment(runtimeRoot);
  Object.assign(process.env, {
    VM_DATA_PLANE: "live",
    VM_DATA_PLANE_ID: "live-fixture-test",
    VM_SIMULATION_PROFILE: "standard",
    VM_PLATFORM_TENANT_NAME: "isolated live fixture test",
    PUBLIC_BASE_URL: "https://vending.example.test"
  });
  const state = createEmptyPersistedState("live", "live-fixture-test");
  state.initializationSource = "live-bootstrap";
  state.platformTenants = [
    {
      id: "live-fixture-test",
      code: "current",
      name: "isolated live fixture test",
      status: "active",
      instanceUrl: "https://vending.example.test",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  ];
  writePersistedState(state);

  const store = new InMemoryStoreService();
  assert.equal(store.devices.some((entry) => entry.deviceCode === fixtureDeviceCode), false);
});
