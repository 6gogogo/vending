import assert from "node:assert/strict";
import test from "node:test";
import type { SystemSettingEntry } from "@vm/shared-types";

import {
  adjustmentQuotaModeSettingKey,
  isPaymentOnlySetting,
  isReservationOnlyPickupEnabled,
  orderSystemSettingsGroups,
  settingsVisibleForInstanceAdministration,
  settingsVisibleForCurrentPickupMode
} from "./system-settings-display";

const createSetting = (key: string, value = ""): SystemSettingEntry => ({
  key,
  value,
  group: "测试",
  label: key,
  description: "",
  inputType: "text",
  sensitive: false,
  required: false,
  restartRequired: false,
  source: "env",
  effectiveValue: ""
});

test("预约取货开关只接受常见真值", () => {
  assert.equal(isReservationOnlyPickupEnabled("true"), true);
  assert.equal(isReservationOnlyPickupEnabled("ON"), true);
  assert.equal(isReservationOnlyPickupEnabled("false"), false);
  assert.equal(isReservationOnlyPickupEnabled(undefined), false);
});

test("预约取货时收起支付专用设置，保留领取和登录设置", () => {
  const settings = [
    createSetting("VM_RESERVATION_ONLY_PICKUP"),
    createSetting("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"),
    createSetting("VM_FULL_SIMULATION_VERIFICATION_MODE"),
    createSetting("PAYMENT_MODE"),
    createSetting("WECHAT_PAY_APP_ID"),
    createSetting("SMARTVM_PAYMENT_SUCCESS_PATH"),
    createSetting("VM_FULL_SIMULATION_PAYMENT_MODE")
  ];

  assert.deepEqual(
    settingsVisibleForCurrentPickupMode(settings, true).map((entry) => entry.key),
    [
      "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE",
      "VM_FULL_SIMULATION_VERIFICATION_MODE"
    ]
  );
  assert.deepEqual(
    settingsVisibleForCurrentPickupMode(settings, false).map((entry) => entry.key),
    [
      "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE",
      "VM_FULL_SIMULATION_VERIFICATION_MODE",
      "PAYMENT_MODE",
      "WECHAT_PAY_APP_ID",
      "SMARTVM_PAYMENT_SUCCESS_PATH",
      "VM_FULL_SIMULATION_PAYMENT_MODE"
    ]
  );
});

test("预约取货将柜机支付回调与第三方支付设置一并视为支付专用项", () => {
  assert.equal(isPaymentOnlySetting("SMARTVM_PAYMENT_SUCCESS_PATH"), true);
  assert.equal(isPaymentOnlySetting("PAYMENT_MODE"), true);
  assert.equal(isPaymentOnlySetting("WECHAT_PAY_APP_ID"), true);
  assert.equal(isPaymentOnlySetting(adjustmentQuotaModeSettingKey), false);
});

test("实例设置始终作为系统设置的首个入口", () => {
  assert.deepEqual(
    orderSystemSettingsGroups(["运行方式", "地图服务", "实例设置", "短信服务"]),
    ["实例设置", "运行方式", "地图服务", "短信服务"]
  );
});

test("实例后台在标准模拟或实机服务中只展示日常领取设置", () => {
  const settings = [
    createSetting("NODE_ENV"),
    createSetting("APP_ENV"),
    createSetting("VM_DATA_PLANE"),
    createSetting("VM_SIMULATION_PROFILE", "standard"),
    createSetting("VM_RESERVATION_ONLY_PICKUP"),
    createSetting("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"),
    createSetting("VM_FULL_SIMULATION_VERIFICATION_MODE"),
    createSetting("VM_FULL_SIMULATION_PAYMENT_MODE"),
    createSetting("AMAP_WEB_KEY"),
    createSetting("SMARTVM_CLIENT_ID"),
    createSetting("PAYMENT_MODE"),
    createSetting("WEB_CONCURRENCY")
  ];

  assert.deepEqual(
    settingsVisibleForInstanceAdministration(settings).map((entry) => entry.key),
    [
      "VM_RESERVATION_ONLY_PICKUP",
      "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"
    ]
  );
});

test("实例后台仅在全真模拟演练中显示登录和支付验证选择", () => {
  const settings = [
    createSetting("VM_DATA_PLANE", "simulation"),
    createSetting("VM_SIMULATION_PROFILE", "full"),
    createSetting("VM_FULL_SIMULATION_ENABLED", "true"),
    createSetting("VM_DATA_ROOT", "runtime-data/full-simulation"),
    createSetting("VM_DATA_PLANE_ID", "full-simulation-test"),
    createSetting("VM_RESERVATION_ONLY_PICKUP"),
    createSetting("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"),
    createSetting("VM_FULL_SIMULATION_VERIFICATION_MODE"),
    createSetting("VM_FULL_SIMULATION_PAYMENT_MODE")
  ];

  assert.deepEqual(
    settingsVisibleForInstanceAdministration(settings).map((entry) => entry.key),
    [
      "VM_RESERVATION_ONLY_PICKUP",
      "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE",
      "VM_FULL_SIMULATION_VERIFICATION_MODE",
      "VM_FULL_SIMULATION_PAYMENT_MODE"
    ]
  );
});

test("全真模拟未启用或未隔离时不显示演练专用登录和支付选择", () => {
  const baseSettings = [
    createSetting("VM_DATA_PLANE", "simulation"),
    createSetting("VM_SIMULATION_PROFILE", "full"),
    createSetting("VM_FULL_SIMULATION_ENABLED", "true"),
    createSetting("VM_DATA_ROOT", "runtime-data/full-simulation"),
    createSetting("VM_DATA_PLANE_ID", "full-simulation-test"),
    createSetting("VM_RESERVATION_ONLY_PICKUP"),
    createSetting("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"),
    createSetting("VM_FULL_SIMULATION_VERIFICATION_MODE"),
    createSetting("VM_FULL_SIMULATION_PAYMENT_MODE")
  ];

  for (const invalidSettings of [
    baseSettings.map((entry) =>
      entry.key === "VM_FULL_SIMULATION_ENABLED"
        ? { ...entry, value: "false" }
        : entry
    ),
    baseSettings.map((entry) =>
      entry.key === "VM_DATA_PLANE" ? { ...entry, value: "live" } : entry
    ),
    baseSettings.map((entry) =>
      entry.key === "VM_DATA_ROOT" ? { ...entry, value: "" } : entry
    )
  ]) {
    assert.deepEqual(
      settingsVisibleForInstanceAdministration(invalidSettings).map((entry) => entry.key),
      ["VM_RESERVATION_ONLY_PICKUP", "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"]
    );
  }
});
