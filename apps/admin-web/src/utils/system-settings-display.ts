import type { SystemSettingEntry } from "@vm/shared-types";

export const reservationOnlyPickupSettingKey = "VM_RESERVATION_ONLY_PICKUP";
export const adjustmentQuotaModeSettingKey = "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE";
export const exampleSettingsGroup = "示例设置";

const instanceOperatorSettingKeys = new Set([
  "VM_RESERVATION_ONLY_PICKUP",
  adjustmentQuotaModeSettingKey
]);

const fullSimulationExampleSettingKeys = new Set([
  "VM_FULL_SIMULATION_VERIFICATION_MODE",
  "VM_FULL_SIMULATION_PAYMENT_MODE"
]);

const truthyValues = new Set(["1", "true", "yes", "on"]);

const isEnabledFullSimulation = (settings: SystemSettingEntry[]) => {
  const values = new Map(settings.map((entry) => [entry.key, entry.value.trim()]));

  return (
    values.get("VM_DATA_PLANE") === "simulation" &&
    values.get("VM_SIMULATION_PROFILE") === "full" &&
    truthyValues.has(values.get("VM_FULL_SIMULATION_ENABLED")?.toLowerCase() ?? "") &&
    Boolean(values.get("VM_DATA_ROOT")) &&
    Boolean(values.get("VM_DATA_PLANE_ID"))
  );
};

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
  key.startsWith("SMARTVM_PAYMENT_") ||
  key.startsWith("PAYMENT_") ||
  key.startsWith("WECHAT_") ||
  key.startsWith("ALIPAY_") ||
  key.startsWith("FINANCIAL_");

export const settingsVisibleForInstanceAdministration = (settings: SystemSettingEntry[]) => {
  const fullSimulationEnabled = isEnabledFullSimulation(settings);

  return settings.filter(
    (entry) =>
      instanceOperatorSettingKeys.has(entry.key) ||
      (fullSimulationEnabled && fullSimulationExampleSettingKeys.has(entry.key))
  );
};

export const settingsVisibleForCurrentPickupMode = (
  settings: SystemSettingEntry[],
  reservationOnlyPickupEnabled: boolean
) =>
  settings.filter(
    (entry) =>
      entry.key !== reservationOnlyPickupSettingKey &&
      (!reservationOnlyPickupEnabled || !isPaymentOnlySetting(entry.key))
  );

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
