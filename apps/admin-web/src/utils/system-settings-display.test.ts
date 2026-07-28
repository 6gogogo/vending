import assert from "node:assert/strict";
import test from "node:test";
import type { SystemSettingEntry } from "@vm/shared-types";

import {
  isReservationOnlyPickupEnabled,
  orderSystemSettingsGroups,
  settingsVisibleForCurrentPickupMode
} from "./system-settings-display";

const createSetting = (key: string): SystemSettingEntry => ({
  key,
  value: "",
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
    createSetting("VM_FULL_SIMULATION_PAYMENT_MODE")
  ];

  assert.deepEqual(
    settingsVisibleForCurrentPickupMode(settings, true).map((entry) => entry.key),
    [
      "VM_RESERVATION_ONLY_PICKUP",
      "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE",
      "VM_FULL_SIMULATION_VERIFICATION_MODE"
    ]
  );
  assert.equal(settingsVisibleForCurrentPickupMode(settings, false).length, settings.length);
});

test("示例设置始终作为系统设置的首个入口", () => {
  assert.deepEqual(
    orderSystemSettingsGroups(["运行方式", "地图服务", "示例设置", "短信服务"]),
    ["示例设置", "运行方式", "地图服务", "短信服务"]
  );
});
