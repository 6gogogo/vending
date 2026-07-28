import type { SystemSettingEntry } from "@vm/shared-types";

export const reservationOnlyPickupSettingKey = "VM_RESERVATION_ONLY_PICKUP";
export const exampleSettingsGroup = "示例设置";

const instanceOperatorSettingKeys = new Set([
  "NODE_ENV",
  "APP_ENV",
  "VM_DATA_PLANE",
  "VM_RESERVATION_ONLY_PICKUP",
  "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE",
  "VM_FULL_SIMULATION_VERIFICATION_MODE",
  "VM_FULL_SIMULATION_PAYMENT_MODE"
]);

const paymentOnlySettingKeys = new Set([
  "VM_FULL_SIMULATION_PAYMENT_MODE",
  "SMARTVM_DEFAULT_PAY_STYLE",
  "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS",
  "SMARTVM_PAYMENT_SUCCESS_PATH"
]);

export const isReservationOnlyPickupEnabled = (value: string | undefined) =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

export const isPaymentOnlySetting = (key: string) =>
  paymentOnlySettingKeys.has(key) ||
  key.startsWith("PAYMENT_") ||
  key.startsWith("WECHAT_") ||
  key.startsWith("ALIPAY_") ||
  key.startsWith("FINANCIAL_");

export const settingsVisibleForInstanceAdministration = (settings: SystemSettingEntry[]) =>
  settings.filter((entry) => instanceOperatorSettingKeys.has(entry.key));

export const settingsVisibleForCurrentPickupMode = (
  settings: SystemSettingEntry[],
  reservationOnlyPickupEnabled: boolean
) =>
  reservationOnlyPickupEnabled
    ? settings.filter((entry) => !isPaymentOnlySetting(entry.key))
    : settings;

export const orderSystemSettingsGroups = (groups: string[]) =>
  [...groups].sort((left, right) => {
    if (left === right) {
      return 0;
    }

    if (left === exampleSettingsGroup) {
      return -1;
    }

    if (right === exampleSettingsGroup) {
      return 1;
    }

    return 0;
  });
