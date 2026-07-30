import assert from "node:assert/strict";
import test from "node:test";

import type { ConfigService } from "@nestjs/config";

import { assertProductionSafety } from "../src/common/config/production-safety.js";
import { createEmptyPersistedState } from "../src/common/store/persistence.js";

const validProductionConfig: Record<string, string> = {
  VM_DATA_PLANE: "live",
  VM_DATA_ROOT: "/srv/vending/live",
  VM_DATA_PLANE_ID: "live-production-test",
  VM_PLATFORM_TENANT_NAME: "真实入口测试实例",
  PUBLIC_BASE_URL: "https://api.example.com",
  CORS_ORIGINS: "https://admin.example.com,https://mobile.example.com",
  VERIFICATION_CODE_PROVIDER: "aliyun_pnvs",
  VERIFICATION_CODE_PREVIEW_ENABLED: "false",
  ALIYUN_PNVS_ACCESS_KEY_ID: "configured-access-key-id",
  ALIYUN_PNVS_ACCESS_KEY_SECRET: "configured-access-key-secret",
  ALIYUN_PNVS_SIGN_NAME: "configured-sign-name",
  ALIYUN_PNVS_TEMPLATE_CODE: "configured-template-code",
  ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: "configured-app-login",
  ALIYUN_PNVS_SCHEME_NAME_REGISTER: "configured-register",
  ALIYUN_PNVS_SCHEME_NAME_GENERAL: "configured-general",
  ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: "configured-password-reset",
  SMARTVM_BASE_URL: "https://smartvm.example.com",
  SMARTVM_CLIENT_ID: "configured-client-id",
  SMARTVM_KEY: "configured-smartvm-key",
  SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "false",
  ALLOW_UNSIGNED_SMARTVM_CALLBACKS: "false",
  SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "false",
  PAYMENT_MODE: "real",
  FINANCIAL_SINGLE_WRITER_ENABLED: "true",
  FINANCIAL_SINGLE_WRITER_LEASE_FILE: "runtime-data/financial-single-writer.lock",
  FINANCIAL_SINGLE_WRITER_LEASE_MS: "30000",
  FINANCIAL_SINGLE_WRITER_HEARTBEAT_MS: "10000",
  PAYMENT_RECONCILIATION_ENABLED: "true",
  PAYMENT_RECONCILIATION_INTERVAL_MS: "30000",
  PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "30000",
  PAYMENT_RECONCILIATION_MAX_DELAY_MS: "1800000",
  PAYMENT_RECONCILIATION_BATCH_SIZE: "20",
  PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS: "5",
  WEB_CONCURRENCY: "1",
  API_INSTANCE_COUNT: "1",
  WECHAT_PAY_APP_ID: "wechat-app-id",
  WECHAT_MINI_APP_SECRET: "wechat-app-secret",
  WECHAT_PAY_MCH_ID: "wechat-mch-id",
  WECHAT_PAY_API_V3_KEY: "wechat-api-v3-key",
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

const createConfigService = (overrides: Record<string, string | undefined> = {}) => {
  const values = {
    ...validProductionConfig,
    ...overrides
  };

  return {
    get: (key: string) => values[key]
  } as unknown as ConfigService;
};

const emptyCredentialStore = {
  ...createEmptyPersistedState("live"),
  initializationSource: "live-bootstrap" as const,
  users: [
    {
      id: "live-super-admin",
      role: "admin" as const,
      phone: "13900000000",
      name: "真实超级管理员",
      status: "active" as const,
      tags: ["hidden-backoffice", "super-admin"],
      mobileProfileCompleted: false
    }
  ],
  backofficeCredentials: [
    {
      userId: "live-super-admin",
      username: "live-super",
      role: "super_admin" as const,
      passwordSalt: "test-salt",
      passwordHash: "test-hash",
      usesDefaultPassword: false,
      passwordUpdatedAt: "2026-01-01T00:00:00.000Z"
    }
  ],
  snapshot: () => createEmptyPersistedState("live"),
  isPersistedStateIntegrityReady: () => true,
  isLiveDataPlane: () => true,
  getRuntimeDataPlaneIdentity: () => ({
    dataPlane: "live" as const,
    instanceId: validProductionConfig.VM_DATA_PLANE_ID,
    initializationSource: "live-bootstrap" as const
  })
};

const readyAuditLog = {
  isReady: () => true
};

const reservationOnlyProductionConfig = {
  ...validProductionConfig,
  VM_RESERVATION_ONLY_PICKUP: "true",
  PAYMENT_MODE: "disabled",
  PAYMENT_RECONCILIATION_ENABLED: "false",
  VERIFICATION_CODE_PROVIDER: "manual",
  SMARTVM_MODE: "disabled",
  SMARTVM_BASE_URL: undefined,
  SMARTVM_CLIENT_ID: undefined,
  SMARTVM_KEY: undefined,
  ALIYUN_PNVS_ACCESS_KEY_ID: undefined,
  ALIYUN_PNVS_ACCESS_KEY_SECRET: undefined,
  ALIYUN_PNVS_SIGN_NAME: undefined,
  ALIYUN_PNVS_TEMPLATE_CODE: undefined,
  WECHAT_PAY_APP_ID: undefined,
  WECHAT_MINI_APP_SECRET: undefined,
  WECHAT_PAY_MCH_ID: undefined,
  WECHAT_PAY_API_V3_KEY: undefined,
  WECHAT_PAY_MERCHANT_PRIVATE_KEY: undefined,
  WECHAT_PAY_MERCHANT_CERT_SERIAL_NO: undefined,
  WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: undefined,
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: undefined,
  ALIPAY_APP_ID: undefined,
  ALIPAY_SELLER_ID: undefined,
  ALIPAY_APP_PRIVATE_KEY: undefined,
  ALIPAY_PUBLIC_KEY: undefined
};

test("APP_ENV=production 即使 NODE_ENV=development 也执行完整生产门禁", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppEnv = process.env.APP_ENV;
  process.env.NODE_ENV = "development";
  process.env.APP_ENV = "production";

  try {
    assert.doesNotThrow(() =>
      assertProductionSafety(createConfigService(), emptyCredentialStore as never, readyAuditLog as never)
    );

    for (const schemeValue of [undefined, "", "   "]) {
      assert.doesNotThrow(() =>
        assertProductionSafety(
          createConfigService({
            ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: schemeValue,
            ALIYUN_PNVS_SCHEME_NAME_REGISTER: schemeValue,
            ALIYUN_PNVS_SCHEME_NAME_GENERAL: schemeValue,
            ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: schemeValue
          }),
          emptyCredentialStore as never,
          readyAuditLog as never
        )
      );
    }

    assert.doesNotThrow(() =>
      assertProductionSafety(
        createConfigService({ API_INSTANCE_COUNT: "1" }),
        emptyCredentialStore as never,
        readyAuditLog as never
      )
    );

    assert.throws(
      () =>
        assertProductionSafety(createConfigService(), {
          ...emptyCredentialStore,
          devices: [
            {
              deviceCode: "MOCK-PERSISTED-001",
              isMock: true
            }
          ]
        } as never, readyAuditLog as never),
      /生产环境不能加载模拟设备.*1 台 isMock=true.*清理持久化运行数据/
    );

    assert.throws(
      () =>
        assertProductionSafety(createConfigService(), {
          ...emptyCredentialStore,
          paymentOrders: [
            {
              id: "persisted-mock-payment",
              metadata: { simulated: true },
              status: "paid"
            }
          ]
        } as never, readyAuditLog as never),
      /生产环境不能加载模拟支付单.*1 笔.*清理持久化运行数据/
    );

    assert.throws(
      () =>
        assertProductionSafety(
          createConfigService(),
          {
            ...emptyCredentialStore,
            getRuntimeDataPlaneIdentity: () => ({
              dataPlane: "live" as const,
              instanceId: validProductionConfig.VM_DATA_PLANE_ID,
              initializationSource: "live-bootstrap-pending" as const
            })
          } as never,
          readyAuditLog as never
        ),
      /真实数据平面尚未完成受控初始化/
    );

    assert.throws(
      () =>
        assertProductionSafety(
          createConfigService(),
          {
            ...emptyCredentialStore,
            getRuntimeDataPlaneIdentity: () => ({
              dataPlane: "live" as const,
              instanceId: "other-live-instance",
              initializationSource: "live-bootstrap" as const
            })
          } as never,
          readyAuditLog as never
        ),
      /真实运行数据与受控部署标识不一致/
    );

    const invalidCases: Array<{
      name: string;
      overrides: Record<string, string | undefined>;
      message: RegExp;
    }> = [
      {
        name: "公网基础地址不能使用 IP",
        overrides: { PUBLIC_BASE_URL: "https://127.0.0.2" },
        message: /必须使用公网域名/
      },
      {
        name: "真实当前租户名称必须由部署配置提供",
        overrides: { VM_PLATFORM_TENANT_NAME: undefined },
        message: /VM_PLATFORM_TENANT_NAME/
      },
      {
        name: "CORS 来源不能带路径",
        overrides: { CORS_ORIGINS: "https://admin.example.com/path" },
        message: /只能填写来源/
      },
      {
        name: "SmartVM 必须使用 HTTPS",
        overrides: { SMARTVM_BASE_URL: "http://smartvm.example.com" },
        message: /SMARTVM_BASE_URL 必须使用 HTTPS/
      },
      {
        name: "生产环境不能把正金额结算自动伪装成付款成功",
        overrides: { SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "true" },
        message: /不能开启结算后自动转发付款成功/
      },
      {
        name: "生产环境不能关闭金融单写者租约",
        overrides: { FINANCIAL_SINGLE_WRITER_ENABLED: "false" },
        message: /FINANCIAL_SINGLE_WRITER_ENABLED=true/
      },
      {
        name: "JSON 账本阶段不能启动多个 API 工作者",
        overrides: { WEB_CONCURRENCY: "2" },
        message: /WEB_CONCURRENCY=1/
      },
      {
        name: "JSON 账本阶段不能将 API 实例数设为多个",
        overrides: { API_INSTANCE_COUNT: "2" },
        message: /API_INSTANCE_COUNT=1/
      },
      {
        name: "JSON 账本阶段必须显式声明 Web 工作者数",
        overrides: { WEB_CONCURRENCY: undefined },
        message: /WEB_CONCURRENCY=1/
      },
      {
        name: "JSON 账本阶段必须显式声明 API 实例数",
        overrides: {
          API_INSTANCE_COUNT: undefined
        },
        message: /API_INSTANCE_COUNT=1/
      },
      {
        name: "真实支付必须启用后台自动对账",
        overrides: { PAYMENT_RECONCILIATION_ENABLED: "false" },
        message: /PAYMENT_RECONCILIATION_ENABLED=true/
      },
      {
        name: "真实短信 AccessKey ID 不能为空",
        overrides: { ALIYUN_PNVS_ACCESS_KEY_ID: undefined },
        message: /ALIYUN_PNVS_ACCESS_KEY_ID/
      },
      {
        name: "真实短信密钥不能为空",
        overrides: { ALIYUN_PNVS_ACCESS_KEY_SECRET: undefined },
        message: /ALIYUN_PNVS_ACCESS_KEY_SECRET/
      },
      {
        name: "真实短信签名不能为空",
        overrides: { ALIYUN_PNVS_SIGN_NAME: undefined },
        message: /ALIYUN_PNVS_SIGN_NAME/
      },
      {
        name: "真实短信模板不能为空",
        overrides: { ALIYUN_PNVS_TEMPLATE_CODE: undefined },
        message: /ALIYUN_PNVS_TEMPLATE_CODE/
      },
      {
        name: "严格真实支付配置不能为空",
        overrides: { WECHAT_PAY_API_V3_KEY: undefined },
        message: /WECHAT_PAY_API_V3_KEY/
      },
      {
        name: "微信平台证书序列号不能为空",
        overrides: { WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: undefined },
        message: /WECHAT_PAY_PLATFORM_CERT_SERIAL_NO/
      },
      {
        name: "微信登录地址必须钉住官方域名",
        overrides: { WECHAT_MINI_LOGIN_URL: "https://credentials.example.com/sns/jscode2session" },
        message: /WECHAT_MINI_LOGIN_URL.*官方地址/
      },
      {
        name: "微信支付 API 必须钉住官方域名",
        overrides: { WECHAT_PAY_API_BASE_URL: "https://payments.example.com" },
        message: /WECHAT_PAY_API_BASE_URL.*官方地址/
      },
      {
        name: "支付宝网关必须钉住官方地址",
        overrides: { ALIPAY_GATEWAY_URL: "https://payments.example.com/gateway.do" },
        message: /ALIPAY_GATEWAY_URL.*官方地址/
      },
      {
        name: "支付回调必须回到本方公开来源",
        overrides: { WECHAT_PAY_NOTIFY_URL: "https://callbacks.example.net/api/payments/callbacks/wechat" },
        message: /WECHAT_PAY_NOTIFY_URL.*PUBLIC_BASE_URL.*同源/
      },
      {
        name: "支付回调路径不能指向其他本方接口",
        overrides: { ALIPAY_NOTIFY_URL: "https://api.example.com/api/auth/admin-login" },
        message: /ALIPAY_NOTIFY_URL.*回调路径/
      }
    ];

    for (const invalidCase of invalidCases) {
      assert.throws(
        () => assertProductionSafety(createConfigService(invalidCase.overrides), emptyCredentialStore as never, readyAuditLog as never),
        invalidCase.message,
        invalidCase.name
      );
    }
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
});

test("全新预约制正式实例无需支付渠道配置，但仍拒绝账本或模式漂移", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppEnv = process.env.APP_ENV;
  process.env.NODE_ENV = "production";
  process.env.APP_ENV = "production";

  try {
    assert.doesNotThrow(() =>
      assertProductionSafety(
        createConfigService(reservationOnlyProductionConfig),
        emptyCredentialStore as never,
        readyAuditLog as never
      )
    );

    assert.throws(
      () =>
        assertProductionSafety(
          createConfigService({
            ...reservationOnlyProductionConfig,
            VM_RESERVATION_ONLY_PICKUP: "false"
          }),
          emptyCredentialStore as never,
          readyAuditLog as never
        ),
      /PAYMENT_MODE=disabled 只允许用于预约取货模式/
    );

    assert.throws(
      () =>
        assertProductionSafety(
          createConfigService(reservationOnlyProductionConfig),
          {
            ...emptyCredentialStore,
            paymentOrders: [
              {
                id: "existing-real-payment",
                status: "paid",
                metadata: { simulated: false }
              }
            ]
          } as never,
          readyAuditLog as never
        ),
      /已有支付或退款账本.*不能关闭支付配置/
    );

    assert.throws(
      () =>
        assertProductionSafety(
          createConfigService(reservationOnlyProductionConfig),
          {
            ...emptyCredentialStore,
            devices: [
              {
                deviceCode: "PRODUCTION-DEVICE-001",
                isMock: false
              }
            ]
          } as never,
          readyAuditLog as never
        ),
      /柜机平台尚未启用.*不能加载柜机/
    );
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
});
