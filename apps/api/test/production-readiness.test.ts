import assert from "node:assert/strict";
import test from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";

import { AppController } from "../src/app.controller";
import { createEmptyPersistedState } from "../src/common/store/persistence";

const validProductionConfig: Record<string, string> = {
  PUBLIC_BASE_URL: "https://api.example.com",
  CORS_ORIGINS: "https://admin.example.com,https://mobile.example.com",
  VERIFICATION_CODE_PROVIDER: "aliyun",
  VERIFICATION_CODE_PREVIEW_ENABLED: "false",
  ALIYUN_SMS_ACCESS_KEY_ID: "configured-access-key-id",
  ALIYUN_SMS_ACCESS_KEY_SECRET: "configured-access-key-secret",
  SMARTVM_BASE_URL: "https://smartvm.example.com",
  SMARTVM_CLIENT_ID: "configured-client-id",
  SMARTVM_KEY: "configured-smartvm-key",
  SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "false",
  ALLOW_UNSIGNED_SMARTVM_CALLBACKS: "false",
  SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "false",
  PAYMENT_MODE: "real",
  FINANCIAL_SINGLE_WRITER_ENABLED: "true",
  PAYMENT_RECONCILIATION_ENABLED: "true",
  WEB_CONCURRENCY: "1",
  API_INSTANCE_COUNT: "1",
  WECHAT_PAY_APP_ID: "wechat-app-id",
  WECHAT_MINI_APP_SECRET: "wechat-mini-secret",
  WECHAT_PAY_MCH_ID: "wechat-mch-id",
  WECHAT_PAY_API_V3_KEY: "wechat-v3-key",
  WECHAT_PAY_MERCHANT_PRIVATE_KEY: "wechat-private-key",
  WECHAT_PAY_MERCHANT_CERT_SERIAL_NO: "wechat-cert-serial",
  WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "wechat-platform-cert-serial",
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: "wechat-platform-public-key",
  ALIPAY_APP_ID: "alipay-app-id",
  ALIPAY_SELLER_ID: "alipay-seller-id",
  ALIPAY_APP_PRIVATE_KEY: "alipay-private-key",
  ALIPAY_PUBLIC_KEY: "alipay-public-key",
  ALLOW_DEFAULT_BACKOFFICE_LOGIN: "false"
};

const createController = (
  config: Record<string, string | undefined> = validProductionConfig,
  overrides: Record<string, unknown> = {}
) => {
  const {
    __integrityReady = true,
    __auditReady = true,
    __snapshotThrows = false,
    ...stateOverrides
  } = overrides;
  const snapshot = {
    ...createEmptyPersistedState(),
    ...stateOverrides
  };
  const store = {
    ...snapshot,
    snapshot: () => {
      if (__snapshotThrows === true) {
        throw new Error("readiness must not create a store snapshot");
      }
      return structuredClone(snapshot);
    },
    isPersistedStateIntegrityReady: () => __integrityReady === true
  };

  return new AppController(
    { get: (key: string) => config[key] } as never,
    store as never,
    { isReady: () => __auditReady === true } as never
  );
};

const assertReadinessUnavailable = (controller: AppController) => {
  assert.throws(
    () => controller.productionReadiness(),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      const serialized = JSON.stringify(error.getResponse());
      assert.match(serialized, /生产就绪检查未通过/);
      assert.doesNotMatch(
        serialized,
        /private|configured|password|secret|payment|sms|smartvm|credential|aliyun|public_base_url/i
      );
      return true;
    }
  );
};

const withRuntimeEnvironment = (
  environment: Pick<NodeJS.ProcessEnv, "NODE_ENV" | "APP_ENV">,
  action: () => void
) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppEnv = process.env.APP_ENV;
  process.env.NODE_ENV = environment.NODE_ENV;
  process.env.APP_ENV = environment.APP_ENV;

  try {
    action();
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }

    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
  }
};

test("生产就绪健康契约在开发环境一律以不泄密的 503 拒绝", () => {
  const controller = createController();

  withRuntimeEnvironment(
    {
      NODE_ENV: "development",
      APP_ENV: "development"
    },
    () => {
      assertReadinessUnavailable(controller);
    }
  );
});

test("生产就绪健康契约仅在完整生产门禁通过时返回最小成功结果", () => {
  withRuntimeEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.deepEqual(createController().productionReadiness(), {
        code: 200,
        message: "成功",
        data: { status: "就绪" }
      });
    }
  );
});

test("生产就绪健康契约只读取持久化完整性结论，不重复创建完整快照", () => {
  withRuntimeEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.equal(
        createController(validProductionConfig, { __snapshotThrows: true })
          .productionReadiness().data.status,
        "就绪"
      );
    }
  );
});

test("生产就绪健康契约对模拟数据、默认后台凭据、运行数据和配置门禁失败均拒绝且不泄露原因", () => {
  const blockedCandidates = [
    createController(validProductionConfig, {
      adminCredentials: [],
      backofficeCredentials: [],
      devices: [{ deviceCode: "private-mock-cabinet", isMock: true }],
      paymentOrders: []
    }),
    createController(validProductionConfig, {
      adminCredentials: [],
      backofficeCredentials: [],
      devices: [],
      paymentOrders: [{ id: "private-simulated-payment", metadata: { simulated: true } }]
    }),
    createController(validProductionConfig, {
      adminCredentials: [],
      backofficeCredentials: [{ username: "private-default-admin", usesDefaultPassword: true }],
      devices: [],
      paymentOrders: []
    }),
    createController(validProductionConfig, {
      __integrityReady: false,
      goodsCatalog: [{ goodsId: "private-invalid-goods" }]
    }),
    createController(validProductionConfig, {
      __auditReady: false
    }),
    createController({
      ...validProductionConfig,
      PAYMENT_MODE: "mock",
      SMARTVM_KEY: "private-smartvm-key"
    }),
    createController(validProductionConfig, {
      __integrityReady: false,
      expiredBatchDispositions: undefined
    })
  ];

  withRuntimeEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      for (const controller of blockedCandidates) {
        assertReadinessUnavailable(controller);
      }
    }
  );
});
