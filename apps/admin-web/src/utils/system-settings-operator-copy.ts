import type { SystemSettingEntry } from "@vm/shared-types";

const deploymentManagedRuntimeKeys = new Set([
  "API_HOST",
  "TRUST_PROXY_HOPS",
  "VM_DATA_PLANE",
  "VM_DATA_ROOT",
  "VM_DATA_PLANE_ID",
  "VM_PLATFORM_TENANT_NAME",
  "API_DATA_FILE",
  "SYSTEM_LOG_FILE",
  "UPLOAD_DIR",
  "API_BACKUP_DIR",
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE"
]);

const productionManagedRuntimeKeys = new Set(["NODE_ENV", "APP_ENV"]);

const consistencyKeys = new Set([
  "FINANCIAL_SINGLE_WRITER_ENABLED",
  "WEB_CONCURRENCY",
  "API_INSTANCE_COUNT",
  "NODE_APP_INSTANCE",
  "FINANCIAL_INSTANCE_ID",
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
  "FINANCIAL_SINGLE_WRITER_LEASE_MS"
]);

export const isDeploymentManagedRuntimeSetting = (key: string) =>
  deploymentManagedRuntimeKeys.has(key);

export const isProductionManagedRuntimeSetting = (key: string) =>
  productionManagedRuntimeKeys.has(key);

const isProductionValue = (value: string | undefined) =>
  value?.trim().toLowerCase() === "production";

export const isProductionRuntimeSettings = (values: Record<string, string>) =>
  isProductionValue(values.NODE_ENV) || isProductionValue(values.APP_ENV);

export const getEffectiveSystemSettingValues = (
  entries: Array<Pick<SystemSettingEntry, "key" | "effectiveValue">>
) => Object.fromEntries(entries.map((entry) => [entry.key, entry.effectiveValue]));

export const getSystemSettingOperatorDescription = (
  entry: Pick<SystemSettingEntry, "key" | "group"> &
    Partial<Pick<SystemSettingEntry, "description">>
) => {
  if (entry.key === "VM_RESERVATION_ONLY_PICKUP") {
    return "开启后，用户须先预约再取货；本页不会显示或要求支付设置。关闭后按即时领取处理。";
  }

  if (entry.key === "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE") {
    return "选择柜机实际领取数量与预约不一致时，差额计入哪一天的领取额度。一般保持“自动”。";
  }

  if (entry.key === "VM_FULL_SIMULATION_VERIFICATION_MODE") {
    return "选择 App 登录验证方式。手动验证码只能由实例管理员为已启用人员签发。";
  }

  if (entry.key === "VM_FULL_SIMULATION_PAYMENT_MODE") {
    return "仅即时领取需要选择支付验证方式；预约取货时此项不会显示。";
  }

  if (isDeploymentManagedRuntimeSetting(entry.key)) {
    return entry.description
      ? `${entry.description} 此项由发布方案固定，后台仅供核对。`
      : "当前值由服务管理员的发布方案固定，实例管理员无需填写或修改。";
  }

  if (isProductionManagedRuntimeSetting(entry.key)) {
    return entry.description
      ? `${entry.description} 正式环境由发布方案锁定，后台仅供查看。`
      : "运行环境由已启用的发布方案决定，实例后台仅供查看。";
  }

  if (consistencyKeys.has(entry.key)) {
    return entry.description || "该项由服务管理员固定，用于保证支付和退款记录一致。";
  }

  if (entry.group === "运行方式") {
    return entry.description || "当前服务方式由服务管理员维护，实例管理员无需在此页设置。";
  }

  return entry.description || "按已确认的业务方案设置；不确定时请联系服务管理员。";
};
