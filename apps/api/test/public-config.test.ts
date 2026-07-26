import assert from "node:assert/strict";
import test from "node:test";

import { ConfigService } from "@nestjs/config";

import { AppController } from "../src/app.controller.js";
import type { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";
import { VerificationCodeService } from "../src/modules/auth/verification-code.service.js";

const createController = (verificationConfig: Record<string, string>) => {
  const configService = new ConfigService({
    VM_DATA_PLANE: "simulation",
    VM_DATA_ROOT: "runtime-data/public-config-test",
    VM_DATA_PLANE_ID: "public-config-test",
    VM_SIMULATION_PROFILE: "full",
    VM_FULL_SIMULATION_ENABLED: "true",
    VM_FULL_SIMULATION_MAP_MODE: "mock",
    ...verificationConfig
  });
  const store = {} as InMemoryStoreService;
  const verificationCodeService = new VerificationCodeService(configService, store);

  return new AppController(
    configService,
    store,
    verificationCodeService as never
  );
};

const assertSafePublicConfigShape = (data: Record<string, unknown>) => {
  assert.deepEqual(Object.keys(data).sort(), [
    "amapRuntimeMode",
    "amapSecurityJsCode",
    "amapWebKey",
    "runtimeDataPlane",
    "verificationPreviewEnabled",
    "verificationProvider"
  ]);
};

test("公开配置标明后台签发人工码运行状态，且不暴露任何静态通用验证码", () => {
  const controller = createController({
    VM_FULL_SIMULATION_VERIFICATION_MODE: "manual",
    VERIFICATION_CODE_PREVIEW_ENABLED: "true"
  });

  const response = controller.publicConfig();

  assert.equal(response.code, 200);
  assert.equal(response.data.runtimeDataPlane, "simulation");
  assert.equal(response.data.amapRuntimeMode, "mock");
  assert.equal(response.data.verificationProvider, "manual");
  assert.equal(response.data.verificationPreviewEnabled, false);
  assertSafePublicConfigShape(response.data);
  assert.doesNotMatch(
    JSON.stringify(response.data),
    /VERIFICATION_CODE_MANUAL_VALUE/
  );
});

test("公开配置可观测 PNVS 提供方但不泄露供应商配置", () => {
  const controller = createController({
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
  });

  const response = controller.publicConfig();

  assert.equal(response.code, 200);
  assert.equal(response.data.verificationProvider, "aliyun_pnvs");
  assert.equal(response.data.verificationPreviewEnabled, false);
  assertSafePublicConfigShape(response.data);
  assert.doesNotMatch(
    JSON.stringify(response.data),
    /test-access|test-sign|test-template|test-app-login|test-register|test-general|test-password-reset/
  );
});
