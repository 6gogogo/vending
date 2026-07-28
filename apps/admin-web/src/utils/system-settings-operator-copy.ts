import type { SystemSettingEntry } from "@vm/shared-types";

const deploymentManagedRuntimeKeys = new Set([
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
  entry: Pick<SystemSettingEntry, "key" | "group">
) => {
  if (isDeploymentManagedRuntimeSetting(entry.key)) {
    return "由发布流程固定；此处用于确认当前已加载的值，日常验收不需要填写。";
  }

  if (isProductionManagedRuntimeSetting(entry.key)) {
    return "只能选择固定运行环境；公网运行期间由发布流程管理。";
  }

  if (consistencyKeys.has(entry.key)) {
    return "保障账目与服务状态一致，请保持当前值；需要调整时由部署人员统一处理。";
  }

  if (entry.group === "运行方式") {
    return "决定本次演示是否连接外部服务。日常预约演示通常保持当前选项。";
  }

  return "按服务商或部署资料确认后填写；保存后按页面提示重启或复核。";
};
