import assert from "node:assert/strict";
import test from "node:test";

import {
  getEffectiveSystemSettingValues,
  getSystemSettingOperatorDescription,
  isDeploymentManagedRuntimeSetting,
  isProductionManagedRuntimeSetting,
  isProductionRuntimeSettings
} from "./system-settings-operator-copy";

test("部署管理的运行边界不能在后台当作日常输入项", () => {
  assert.equal(isProductionRuntimeSettings({ NODE_ENV: "production" }), true);
  assert.equal(isProductionRuntimeSettings({ APP_ENV: "production" }), true);
  assert.equal(isProductionRuntimeSettings({ NODE_ENV: " Production " }), true);
  assert.equal(isProductionRuntimeSettings({ NODE_ENV: "test", APP_ENV: "test" }), false);
  assert.equal(isDeploymentManagedRuntimeSetting("VM_DATA_PLANE"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("VM_PLATFORM_TENANT_NAME"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("API_DATA_FILE"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("SYSTEM_LOG_FILE"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("UPLOAD_DIR"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("API_BACKUP_DIR"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("FINANCIAL_SINGLE_WRITER_LEASE_FILE"), true);
  assert.equal(isProductionManagedRuntimeSetting("NODE_ENV"), true);
  assert.equal(isProductionManagedRuntimeSetting("APP_ENV"), true);
  assert.equal(isDeploymentManagedRuntimeSetting("PAYMENT_MODE"), false);
});

test("实际生效的运行环境优先于 .env 编辑值决定生产锁定", () => {
  const effectiveValues = getEffectiveSystemSettingValues([
    { key: "NODE_ENV", effectiveValue: "production" },
    { key: "APP_ENV", effectiveValue: "development" }
  ]);

  assert.equal(isProductionRuntimeSettings(effectiveValues), true);
});

test("高级项默认展示操作说明，不展示实现叙述", () => {
  assert.match(
    getSystemSettingOperatorDescription({ key: "WEB_CONCURRENCY", group: "支付接入" }),
    /保持当前值/
  );
  assert.match(
    getSystemSettingOperatorDescription({ key: "MAP_WEB_KEY", group: "地图服务" }),
    /服务商或部署资料/
  );
  assert.match(
    getSystemSettingOperatorDescription({ key: "NODE_ENV", group: "运行方式" }),
    /固定运行环境/
  );
});
