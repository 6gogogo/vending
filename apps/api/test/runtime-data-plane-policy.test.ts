import assert from "node:assert/strict";
import test from "node:test";

import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  assertRuntimeDataPlaneExternalIntegrationPolicy
} from "../src/common/config/runtime-data-plane-policy.js";
import type { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";
import type { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service.js";
import type { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service.js";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway.js";
import { DevicesService } from "../src/modules/devices/devices.service.js";
import type { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { VerificationCodeService } from "../src/modules/auth/verification-code.service.js";
import { OpenAiCompatibleService } from "../src/modules/ai-insights/openai-compatible.service.js";

const simulationSettings = {
  VM_DATA_PLANE: "simulation",
  PAYMENT_MODE: "mock",
  VERIFICATION_CODE_PROVIDER: "mock"
};

const liveSettings = {
  VM_DATA_PLANE: "live",
  PAYMENT_MODE: "real",
  VERIFICATION_CODE_PROVIDER: "aliyun_pnvs",
  VERIFICATION_CODE_PREVIEW_ENABLED: "false",
  ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key-id",
  ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-key-secret",
  ALIYUN_PNVS_SIGN_NAME: "test-sign-name",
  ALIYUN_PNVS_TEMPLATE_CODE: "test-template-code",
  ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: "test-app-login",
  ALIYUN_PNVS_SCHEME_NAME_REGISTER: "test-register",
  ALIYUN_PNVS_SCHEME_NAME_GENERAL: "test-general",
  ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: "test-password-reset",
  AMAP_WEB_KEY: "test-web-key",
  AMAP_SECURITY_JS_CODE: "test-security-js-code",
  ENABLE_LOCAL_MOCK_DEVICE_API: "false",
  ENABLE_TEST_DEVICE_BOOTSTRAP: "false",
  SMARTVM_BASE_URL: "https://smartvm.example.test",
  SMARTVM_CLIENT_ID: "live-client-id",
  SMARTVM_KEY: "live-signing-key",
  SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "false",
  ALLOW_UNSIGNED_SMARTVM_CALLBACKS: "false"
};

const fullSimulationSettings = {
  VM_DATA_PLANE: "simulation",
  VM_DATA_ROOT: "runtime-data/full-simulation-test",
  VM_DATA_PLANE_ID: "full-simulation-test",
  VM_SIMULATION_PROFILE: "full",
  VM_FULL_SIMULATION_ENABLED: "true",
  VM_FULL_SIMULATION_SMARTVM_MODE: "mock",
  VM_FULL_SIMULATION_PAYMENT_MODE: "mock",
  VM_FULL_SIMULATION_VERIFICATION_MODE: "mock",
  VM_FULL_SIMULATION_AI_MODE: "mock",
  VM_FULL_SIMULATION_MAP_MODE: "mock",
  PAYMENT_MODE: "mock",
  VERIFICATION_CODE_PROVIDER: "mock"
};

test("数据平面在非 production 下仍强制支付、验证码、设备与 SmartVM 边界", () => {
  assert.doesNotThrow(() =>
    assertRuntimeDataPlaneExternalIntegrationPolicy(simulationSettings)
  );
  assert.doesNotThrow(() =>
    assertRuntimeDataPlaneExternalIntegrationPolicy(liveSettings)
  );

  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...simulationSettings,
        PAYMENT_MODE: "real"
      }),
    /模拟数据平面只能设置 PAYMENT_MODE=mock/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...simulationSettings,
        VERIFICATION_CODE_PROVIDER: "aliyun_pnvs"
      }),
    /模拟数据平面只能使用 VERIFICATION_CODE_PROVIDER=mock/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...simulationSettings,
        SMARTVM_BASE_URL: "https://smartvm.example.test"
      }),
    /模拟数据平面只能使用 SmartVM mock/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...simulationSettings,
        OPENAI_API_KEY: "simulation-only-test-key"
      }),
    /模拟数据平面不能配置 OPENAI_API_KEY/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...liveSettings,
        PAYMENT_MODE: "mock"
      }),
    /真实数据平面只能设置 PAYMENT_MODE=real/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...liveSettings,
        VERIFICATION_CODE_PREVIEW_ENABLED: "true"
      }),
    /必须关闭 VERIFICATION_CODE_PREVIEW_ENABLED/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...liveSettings,
        ENABLE_TEST_DEVICE_BOOTSTRAP: "true"
      }),
    /禁止启用 ENABLE_TEST_DEVICE_BOOTSTRAP/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...liveSettings,
        SMARTVM_KEY: ""
      }),
    /必须配置受控 SmartVM 接入项：SMARTVM_KEY/
  );
});

test("全真模拟使用独立模拟数据，并可逐模块选择真实或 mock 传输", async () => {
  assert.doesNotThrow(() =>
    assertRuntimeDataPlaneExternalIntegrationPolicy(fullSimulationSettings)
  );
  assert.doesNotThrow(() =>
    assertRuntimeDataPlaneExternalIntegrationPolicy({
      ...fullSimulationSettings,
      VM_FULL_SIMULATION_VERIFICATION_MODE: "manual",
      VERIFICATION_CODE_MANUAL_VALUE: "246810"
    })
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...fullSimulationSettings,
        VM_FULL_SIMULATION_VERIFICATION_MODE: "manual"
      }),
    /VERIFICATION_CODE_MANUAL_VALUE/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...fullSimulationSettings,
        VM_DATA_ROOT: ""
      }),
    /全真模拟必须设置独立的 VM_DATA_ROOT/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...fullSimulationSettings,
        VM_FULL_SIMULATION_ENABLED: "false"
      }),
    /VM_FULL_SIMULATION_ENABLED=true/
  );
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...fullSimulationSettings,
        VM_FULL_SIMULATION_SMARTVM_MODE: "real"
      }),
    /全真模拟启用真实 SmartVM 时必须配置/
  );

  const payments = new PaymentsService(
    {} as InMemoryStoreService,
    new ConfigService({
      ...fullSimulationSettings,
      VM_FULL_SIMULATION_PAYMENT_MODE: "real"
    }),
    {} as CabinetEventsService,
    {} as InventoryOrdersService
  );
  const paymentInternals = payments as unknown as {
    resolvePaymentModeSetting: () => { mode: string; source: string };
  };
  assert.deepEqual(paymentInternals.resolvePaymentModeSetting(), {
    mode: "real",
    source: "VM_FULL_SIMULATION_PAYMENT_MODE"
  });

  const verification = new VerificationCodeService(
    new ConfigService({
      ...fullSimulationSettings,
      VM_FULL_SIMULATION_VERIFICATION_MODE: "real",
      VERIFICATION_CODE_PREVIEW_ENABLED: "false",
      ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key-id",
      ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-key-secret",
      ALIYUN_PNVS_SIGN_NAME: "test-sign-name",
      ALIYUN_PNVS_TEMPLATE_CODE: "test-template-code",
      ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: "test-app-login",
      ALIYUN_PNVS_SCHEME_NAME_REGISTER: "test-register",
      ALIYUN_PNVS_SCHEME_NAME_GENERAL: "test-general",
      ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: "test-password-reset"
    }),
    {} as InMemoryStoreService
  );
  assert.equal(verification.getRuntimeConfig().provider, "aliyun_pnvs");

  const smartVmMock = new SmartVmGateway(
    new ConfigService({
      ...fullSimulationSettings,
      SMARTVM_BASE_URL: "https://smartvm.example.test",
      SMARTVM_CLIENT_ID: "full-simulation-client",
      SMARTVM_KEY: "full-simulation-key"
    })
  );
  assert.equal(smartVmMock.isUsingMockTransport(), true);

  const smartVmReal = new SmartVmGateway(
    new ConfigService({
      ...fullSimulationSettings,
      VM_FULL_SIMULATION_SMARTVM_MODE: "real",
      SMARTVM_BASE_URL: "https://smartvm.example.test",
      SMARTVM_CLIENT_ID: "full-simulation-client",
      SMARTVM_KEY: "full-simulation-key"
    })
  );
  assert.equal(smartVmReal.isUsingMockTransport(), false);

  const ai = new OpenAiCompatibleService(new ConfigService(fullSimulationSettings));
  assert.equal(ai.getStatus().enabled, true);
  assert.equal((await ai.testConnection()).model, "full-simulation-mock");
});

test("全真模拟启用真实 PNVS 时必须在保存或启动前发现缺失配置", () => {
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...fullSimulationSettings,
        VM_FULL_SIMULATION_VERIFICATION_MODE: "real"
      }),
    /全真模拟启用真实 PNVS 时必须配置/
  );
});

test("全真模拟启用真实地图时必须成组配置 Web Key 与安全密钥", () => {
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...fullSimulationSettings,
        VM_FULL_SIMULATION_MAP_MODE: "real"
      }),
    /全真模拟启用真实高德地图时必须配置：AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE/
  );
  assert.doesNotThrow(() =>
    assertRuntimeDataPlaneExternalIntegrationPolicy({
      ...fullSimulationSettings,
      VM_FULL_SIMULATION_MAP_MODE: "real",
      AMAP_WEB_KEY: "test-web-key",
      AMAP_SECURITY_JS_CODE: "test-security-js-code"
    })
  );
});

test("真实数据平面启动前必须具备高德 Web Key 与安全密钥", () => {
  assert.throws(
    () =>
      assertRuntimeDataPlaneExternalIntegrationPolicy({
        ...liveSettings,
        AMAP_SECURITY_JS_CODE: ""
      }),
    /真实数据平面启用高德地图时必须配置：AMAP_SECURITY_JS_CODE/
  );
});

test("服务层复核阻止模拟入口使用真实支付或短信配置", () => {
  const payments = new PaymentsService(
    {} as InMemoryStoreService,
    new ConfigService({
      VM_DATA_PLANE: "simulation",
      PAYMENT_MODE: "real"
    }),
    {} as CabinetEventsService,
    {} as InventoryOrdersService
  );
  const paymentInternals = payments as unknown as {
    resolvePaymentModeSetting: () => unknown;
  };
  assert.throws(
    () => paymentInternals.resolvePaymentModeSetting(),
    (error) =>
      error instanceof BadRequestException &&
      /模拟数据平面只能设置 PAYMENT_MODE=mock/.test(error.message)
  );

  const verification = new VerificationCodeService(
    new ConfigService({
      VM_DATA_PLANE: "simulation",
      VERIFICATION_CODE_PROVIDER: "aliyun_pnvs"
    }),
    {} as InMemoryStoreService
  );
  assert.throws(
    () => verification.getRuntimeConfig(),
    (error) =>
      error instanceof InternalServerErrorException &&
      /模拟数据平面只能使用 VERIFICATION_CODE_PROVIDER=mock/.test(error.message)
  );
});

test("SmartVM 在模拟平面不接受真实凭据，在真实平面不允许回退 mock", () => {
  const gatewayWithSimulationCredentials = new SmartVmGateway(
    new ConfigService({
      VM_DATA_PLANE: "simulation",
      SMARTVM_BASE_URL: "https://smartvm.example.test",
      SMARTVM_CLIENT_ID: "simulation-client-id",
      SMARTVM_KEY: "simulation-signing-key"
    })
  );
  assert.throws(
    () => gatewayWithSimulationCredentials.isUsingMockTransport(),
    (error) =>
      error instanceof BadRequestException &&
      /模拟数据平面只能使用 SmartVM mock/.test(error.message)
  );

  const incompleteLiveGateway = new SmartVmGateway(
    new ConfigService({
      VM_DATA_PLANE: "live",
      SMARTVM_BASE_URL: "https://smartvm.example.test",
      SMARTVM_CLIENT_ID: "live-client-id"
    })
  );
  assert.throws(
    () => incompleteLiveGateway.isUsingMockTransport(),
    (error) =>
      error instanceof BadRequestException &&
      /必须配置受控 SmartVM 接入项：SMARTVM_KEY/.test(error.message)
  );

  const liveGateway = new SmartVmGateway(
    new ConfigService(liveSettings)
  );
  assert.equal(liveGateway.isUsingMockTransport(), false);
});

test("真实数据平面拒绝本地 mock 柜机接口，即使进程不是 production", () => {
  const previousEnvironment = {
    ENABLE_LOCAL_MOCK_DEVICE_API: process.env.ENABLE_LOCAL_MOCK_DEVICE_API,
    API_HOST: process.env.API_HOST,
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV
  };
  process.env.ENABLE_LOCAL_MOCK_DEVICE_API = "true";
  process.env.API_HOST = "127.0.0.1";
  process.env.NODE_ENV = "development";
  delete process.env.APP_ENV;

  try {
    const devices = new DevicesService(
      { isLiveDataPlane: () => true } as InMemoryStoreService,
      {} as InventoryBatchChangesService,
      {} as SmartVmGateway
    );

    assert.throws(
      () =>
        devices.upsertMockDevice({
          deviceCode: "LIVE-MOCK-BLOCKED",
          name: "不应创建的模拟柜机",
          location: "本地测试",
          goods: []
        }),
      (error) =>
        error instanceof ForbiddenException && /模拟柜机接口未启用/.test(error.message)
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
