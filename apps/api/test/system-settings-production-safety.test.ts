import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import { SystemAuditLogService } from "../src/common/store/system-audit-log.service.js";
import { SystemSettingsService } from "../src/modules/system-settings/system-settings.service.js";

const validPaymentSettings: Record<string, string> = {
  APP_ENV: "production",
  VM_DATA_PLANE: "live",
  VM_DATA_ROOT: "/srv/vending/live",
  VM_DATA_PLANE_ID: "live-production-test",
  VM_PLATFORM_TENANT_NAME: "真实入口测试实例",
  PUBLIC_BASE_URL: "https://api.example.com",
  CORS_ORIGINS: "https://admin.example.com,https://mobile.example.com",
  API_DATA_FILE: "runtime-data/store.json",
  SYSTEM_LOG_FILE: "runtime-data/system-audit.ndjson",
  UPLOAD_DIR: "runtime-uploads",
  API_BACKUP_DIR: "runtime-backups",
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
  AMAP_RUNTIME_MODE: "real",
  AMAP_WEB_KEY: "configured-web-key",
  AMAP_SECURITY_JS_CODE: "configured-security-js-code",
  ALLOW_DEFAULT_BACKOFFICE_LOGIN: "false",
  SMARTVM_BASE_URL: "https://smartvm.example.com",
  SMARTVM_ALLOWED_NOTIFY_ORIGINS: "",
  SMARTVM_CLIENT_ID: "configured-client-id",
  SMARTVM_KEY: "configured-smartvm-key",
  SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "false",
  SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "false",
  SMARTVM_PAYMENT_SUCCESS_PATH: "/api/pay/container/paymentSuccess",
  PAYMENT_MODE: "real",
  PAYMENT_MOCK_ENABLED: "false",
  PAYMENT_PROVIDER_TIMEOUT_MS: "15000",
  FINANCIAL_SINGLE_WRITER_ENABLED: "true",
  WEB_CONCURRENCY: "1",
  API_INSTANCE_COUNT: "1",
  FINANCIAL_SINGLE_WRITER_LEASE_FILE: "runtime-data/financial-single-writer.lock",
  FINANCIAL_SINGLE_WRITER_LEASE_MS: "30000",
  FINANCIAL_SINGLE_WRITER_HEARTBEAT_MS: "10000",
  PAYMENT_RECONCILIATION_ENABLED: "true",
  PAYMENT_RECONCILIATION_INTERVAL_MS: "30000",
  PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "30000",
  PAYMENT_RECONCILIATION_MAX_DELAY_MS: "1800000",
  PAYMENT_RECONCILIATION_BATCH_SIZE: "20",
  PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS: "5",
  PAYMENT_RECONCILIATION_USER_REQUEST_COOLDOWN_MS: "15000",
  WECHAT_PAY_APP_ID: "wechat-app-id",
  WECHAT_MINI_APP_SECRET: "wechat-app-secret",
  WECHAT_MINI_LOGIN_URL: "https://api.weixin.qq.com/sns/jscode2session",
  WECHAT_PAY_MCH_ID: "wechat-mch-id",
  WECHAT_PAY_API_BASE_URL: "https://api.mch.weixin.qq.com",
  WECHAT_PAY_NOTIFY_URL: "https://api.example.com/api/payments/callbacks/wechat",
  WECHAT_PAY_REFUND_NOTIFY_URL:
    "https://api.example.com/api/payments/callbacks/wechat-refund",
  WECHAT_PAY_API_V3_KEY: "wechat-api-v3-key",
  WECHAT_PAY_MERCHANT_PRIVATE_KEY: "wechat-private-key",
  WECHAT_PAY_MERCHANT_CERT_SERIAL_NO: "wechat-merchant-cert-serial",
  WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: "wechat-platform-cert-serial",
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: "wechat-platform-public-key",
  ALIPAY_APP_ID: "alipay-app-id",
  ALIPAY_GATEWAY_URL: "https://openapi.alipay.com/gateway.do",
  ALIPAY_NOTIFY_URL: "https://api.example.com/api/payments/callbacks/alipay",
  ALIPAY_SELLER_ID: "alipay-seller-id",
  ALIPAY_APP_PRIVATE_KEY: "alipay-private-key",
  ALIPAY_PUBLIC_KEY: "alipay-public-key"
};

const encodeEnv = (values: Record<string, string>) =>
  `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;

test("示例设置将领取和 App 验证选项集中展示，运行环境只能从模板选项选择", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-example-options-"));
  const envFilePath = join(directory, ".env");
  const settings = {
    NODE_ENV: "development",
    APP_ENV: "development",
    VM_RESERVATION_ONLY_PICKUP: "true",
    VM_FULL_SIMULATION_VERIFICATION_MODE: "manual",
    SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE: "auto"
  };
  writeFileSync(envFilePath, encodeEnv(settings), "utf8");
  const service = new SystemSettingsService(
    {
      get: (key: string) => settings[key as keyof typeof settings],
      set: () => undefined
    } as unknown as ConfigService,
    { envFilePath, appendAuditLog: () => "" }
  );

  try {
    const entries = new Map(service.getSettings().settings.map((entry) => [entry.key, entry]));

    assert.deepEqual(entries.get("NODE_ENV")?.options?.map((option) => option.value), [
      "development",
      "test",
      "production"
    ]);
    assert.equal(entries.get("VM_RESERVATION_ONLY_PICKUP")?.group, "示例设置");
    assert.equal(entries.get("VM_FULL_SIMULATION_VERIFICATION_MODE")?.group, "示例设置");
    assert.equal(entries.get("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE")?.group, "示例设置");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("真实数据平面没有受控配置写入适配器时拒绝后台改写默认 .env", () => {
  const service = new SystemSettingsService(
    {
      get: (key: string) => validPaymentSettings[key],
      set: () => undefined
    } as unknown as ConfigService,
    undefined,
    { appendSafely: () => undefined } as never
  );

  assert.throws(
    () => service.updateSettings({ values: {} }),
    /真实数据平面禁止通过后台写入默认 .env/
  );
});

test("生产配置审计意图不可用时，不改写文件或热应用运行时配置", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-audit-intent-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const auditLog = new SystemAuditLogService({
    appendAuditLog: () => {
      throw new Error("private-audit-write-failed");
    },
    reportFailure: () => undefined
  });
  const service = new SystemSettingsService(configService, { envFilePath }, auditLog);
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    assert.throws(
      () =>
        service.updateSettings({
          values: { PAYMENT_PROVIDER_TIMEOUT_MS: "20000" }
        }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException && error.getStatus() === 503
    );
    assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
    assert.deepEqual(setCalls, []);
    assert.equal(runtimeValues.get("PAYMENT_PROVIDER_TIMEOUT_MS"), "15000");
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("生产环境拒绝模拟支付候选配置且不改写文件或运行时配置", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    assert.throws(
      () =>
        service.updateSettings({
          values: {
            PAYMENT_MODE: "mock"
          }
        }),
      /(?:生产环境必须显式设置|真实数据平面只能设置) PAYMENT_MODE=real/
    );
    assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
    assert.deepEqual(setCalls, []);
    assert.equal(runtimeValues.get("PAYMENT_MODE"), "real");
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("运行中拒绝切换金融租约路径，避免维护命令绕到另一把锁", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  let auditCalls = 0;
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => {
      auditCalls += 1;
      return "";
    }
  });

  try {
    assert.throws(
      () =>
        service.updateSettings({
          values: {
            FINANCIAL_SINGLE_WRITER_LEASE_FILE:
              "runtime-data/financial-writer-next.lock"
          }
        }),
      /必须先停止 API 和运行数据维护命令/
    );
    assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
    assert.deepEqual(setCalls, []);
    assert.equal(auditCalls, 0);
    assert.equal(
      runtimeValues.get("FINANCIAL_SINGLE_WRITER_LEASE_FILE"),
      "runtime-data/financial-single-writer.lock"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("运行中拒绝切换数据、审计、上传和备份路径，避免状态分叉", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  let auditCalls = 0;
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-runtime-paths-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => {
      auditCalls += 1;
      return "";
    }
  });
  const blockedChanges: Record<string, string> = {
    API_DATA_FILE: "runtime-data/store-next.json",
    SYSTEM_LOG_FILE: "runtime-data/system-audit-next.ndjson",
    UPLOAD_DIR: "runtime-uploads-next",
    API_BACKUP_DIR: "runtime-backups-next",
    FINANCIAL_SINGLE_WRITER_LEASE_FILE: "runtime-data/financial-writer-next.lock"
  };

  try {
    for (const [key, value] of Object.entries(blockedChanges)) {
      assert.throws(
        () => service.updateSettings({ values: { [key]: value } }),
        /运行中不能切换运行数据、审计、上传、备份或金融租约路径/
      );
      assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
      assert.deepEqual(setCalls, []);
      assert.equal(auditCalls, 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("生产环境合法支付关键配置仅持久化并标记需重启，不热应用", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  writeFileSync(envFilePath, encodeEnv(validPaymentSettings), "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    const result = service.updateSettings({
      values: {
        WECHAT_PAY_API_BASE_URL: "https://api2.mch.weixin.qq.com"
      }
    });

    assert.deepEqual(result.changedKeys, ["WECHAT_PAY_API_BASE_URL"]);
    assert.deepEqual(result.restartRequiredKeys, ["WECHAT_PAY_API_BASE_URL"]);
    assert.deepEqual(result.runtimeAppliedKeys, []);
    assert.match(
      readFileSync(envFilePath, "utf8"),
      /^WECHAT_PAY_API_BASE_URL=https:\/\/api2\.mch\.weixin\.qq\.com$/m
    );
    assert.equal(runtimeValues.get("WECHAT_PAY_API_BASE_URL"), "https://api.mch.weixin.qq.com");
    assert.equal(
      setCalls.some(([key]) => key === "WECHAT_PAY_API_BASE_URL"),
      false
    );
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("生产环境拒绝削弱 SmartVM 签名与付款事实边界且保持文件和运行时零副作用", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    const invalidCases: Array<{
      values: Record<string, string>;
      message: RegExp;
    }> = [
      {
        values: { SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "true" },
        message: /(?:不能开启结算后自动转发付款成功|禁止自动将柜机结算转发为付款成功)/
      },
      {
        values: { SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "true" },
        message: /(?:不能允许|禁止允许)未签名 SmartVM 回调/
      },
      {
        values: { SMARTVM_KEY: "" },
        message: /SMARTVM_KEY/
      },
      {
        values: { SMARTVM_BASE_URL: "http://smartvm.example.com" },
        message: /SMARTVM_BASE_URL 必须使用 HTTPS/
      },
      {
        values: { APP_ENV: "development" },
        message: /不能在线修改 NODE_ENV 或 APP_ENV/
      }
    ];

    for (const invalidCase of invalidCases) {
      assert.throws(
        () => service.updateSettings({ values: invalidCase.values }),
        invalidCase.message
      );
      assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
      assert.deepEqual(setCalls, []);
    }
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("生产环境合法 SmartVM 信任配置只写入待重启文件而不热应用", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  writeFileSync(envFilePath, encodeEnv(validPaymentSettings), "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    const result = service.updateSettings({
      values: {
        SMARTVM_ALLOWED_NOTIFY_ORIGINS: "https://notify.smartvm.example.com"
      }
    });

    assert.deepEqual(result.changedKeys, ["SMARTVM_ALLOWED_NOTIFY_ORIGINS"]);
    assert.deepEqual(result.restartRequiredKeys, ["SMARTVM_ALLOWED_NOTIFY_ORIGINS"]);
    assert.deepEqual(result.runtimeAppliedKeys, []);
    assert.match(
      readFileSync(envFilePath, "utf8"),
      /^SMARTVM_ALLOWED_NOTIFY_ORIGINS=https:\/\/notify\.smartvm\.example\.com$/m
    );
    assert.equal(runtimeValues.get("SMARTVM_ALLOWED_NOTIFY_ORIGINS"), "");
    assert.deepEqual(setCalls, []);
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("非关键运行时配置仍可热应用", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  writeFileSync(envFilePath, encodeEnv(validPaymentSettings), "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });

  try {
    const result = service.updateSettings({
      values: {
        PAYMENT_PROVIDER_TIMEOUT_MS: "20000"
      }
    });

    assert.deepEqual(result.restartRequiredKeys, []);
    assert.deepEqual(result.runtimeAppliedKeys, ["PAYMENT_PROVIDER_TIMEOUT_MS"]);
    assert.deepEqual(setCalls, [["PAYMENT_PROVIDER_TIMEOUT_MS", "20000"]]);
    assert.equal(runtimeValues.get("PAYMENT_PROVIDER_TIMEOUT_MS"), "20000");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("自动对账数值配置拒绝越界或小数且失败时无文件和运行时副作用", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });
  const invalidCases: Array<{
    key: string;
    value: string;
    message: RegExp;
  }> = [
    {
      key: "PAYMENT_RECONCILIATION_INTERVAL_MS",
      value: "999",
      message: /支付对账扫描间隔毫秒不能小于 1000/
    },
    {
      key: "PAYMENT_RECONCILIATION_INTERVAL_MS",
      value: "3600001",
      message: /支付对账扫描间隔毫秒不能大于 3600000/
    },
    {
      key: "PAYMENT_RECONCILIATION_INTERVAL_MS",
      value: "1000.5",
      message: /支付对账扫描间隔毫秒必须是整数/
    },
    {
      key: "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS",
      value: "0",
      message: /支付对账首次等待毫秒不能小于 1000/
    },
    {
      key: "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS",
      value: "3600001",
      message: /支付对账首次等待毫秒不能大于 3600000/
    },
    {
      key: "PAYMENT_RECONCILIATION_MAX_DELAY_MS",
      value: "999",
      message: /支付对账最大退避毫秒不能小于 1000/
    },
    {
      key: "PAYMENT_RECONCILIATION_MAX_DELAY_MS",
      value: "86400001",
      message: /支付对账最大退避毫秒不能大于 86400000/
    },
    {
      key: "PAYMENT_RECONCILIATION_BATCH_SIZE",
      value: "0",
      message: /支付对账单轮上限不能小于 1/
    },
    {
      key: "PAYMENT_RECONCILIATION_BATCH_SIZE",
      value: "101",
      message: /支付对账单轮上限不能大于 100/
    },
    {
      key: "PAYMENT_RECONCILIATION_BATCH_SIZE",
      value: "1.5",
      message: /支付对账单轮上限必须是整数/
    },
    {
      key: "PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS",
      value: "-1",
      message: /支付对账告警阈值不能小于 1/
    },
    {
      key: "PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS",
      value: "101",
      message: /支付对账告警阈值不能大于 100/
    },
    {
      key: "PAYMENT_RECONCILIATION_USER_REQUEST_COOLDOWN_MS",
      value: "999",
      message: /本人核对请求冷却毫秒不能小于 1000/
    },
    {
      key: "PAYMENT_RECONCILIATION_USER_REQUEST_COOLDOWN_MS",
      value: "3600001",
      message: /本人核对请求冷却毫秒不能大于 3600000/
    }
  ];

  try {
    for (const invalidCase of invalidCases) {
      assert.throws(
        () =>
          service.updateSettings({
            values: {
              [invalidCase.key]: invalidCase.value
            }
          }),
        invalidCase.message
      );
      assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
      assert.deepEqual(setCalls, []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("自动对账数值配置暴露前端边界并拒绝首次等待大于最大退避", () => {
  const runtimeValues = new Map(Object.entries(validPaymentSettings));
  const setCalls: Array<[string, string]> = [];
  const configService = {
    get: (key: string) => runtimeValues.get(key),
    set: (key: string, value: string) => {
      setCalls.push([key, value]);
      runtimeValues.set(key, value);
    }
  } as unknown as ConfigService;
  const directory = mkdtempSync(join(tmpdir(), "vm-system-settings-"));
  const envFilePath = join(directory, ".env");
  const originalContent = encodeEnv(validPaymentSettings);
  writeFileSync(envFilePath, originalContent, "utf8");
  const service = new SystemSettingsService(configService, {
    envFilePath,
    appendAuditLog: () => ""
  });

  try {
    const settingsByKey = new Map(
      service.getSettings().settings.map((entry) => [entry.key, entry])
    );
    assert.deepEqual(
      settingsByKey.get("PAYMENT_RECONCILIATION_INTERVAL_MS")
        ?.numberConstraints,
      {
        min: 1_000,
        max: 3_600_000,
        integerOnly: true
      }
    );
    assert.deepEqual(
      settingsByKey.get("PAYMENT_RECONCILIATION_BATCH_SIZE")
        ?.numberConstraints,
      {
        min: 1,
        max: 100,
        integerOnly: true
      }
    );

    assert.throws(
      () =>
        service.updateSettings({
          values: {
            PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: "60000",
            PAYMENT_RECONCILIATION_MAX_DELAY_MS: "30000"
          }
        }),
      /支付对账首次等待毫秒不能大于支付对账最大退避毫秒/
    );
    assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
    assert.deepEqual(setCalls, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
