import type { SystemSettingEntry } from "@vm/shared-types";

export const reservationOnlyPickupSettingKey = "VM_RESERVATION_ONLY_PICKUP";

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

export const settingsVisibleForCurrentPickupMode = (
  settings: SystemSettingEntry[],
  reservationOnlyPickupEnabled: boolean
) =>
  reservationOnlyPickupEnabled
    ? settings.filter((entry) => !isPaymentOnlySetting(entry.key))
    : settings;
