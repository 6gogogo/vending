import { isProductionRuntime } from "./runtime-environment";
import type { PlatformTenantRecord } from "@vm/shared-types";

export const runtimeDataPlanes = ["simulation", "live"] as const;
export type RuntimeDataPlane = (typeof runtimeDataPlanes)[number];

export const RUNTIME_DATA_PLANE_ENV_KEY = "VM_DATA_PLANE";
export const RUNTIME_DATA_ROOT_ENV_KEY = "VM_DATA_ROOT";
export const RUNTIME_DATA_PLANE_ID_ENV_KEY = "VM_DATA_PLANE_ID";
/**
 * 真实平面中唯一当前客户实例的展示名称。它属于部署身份而非后台可热更新设置，
 * 因而与数据平面 ID 一起由进程启动配置提供。
 */
export const RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY = "VM_PLATFORM_TENANT_NAME";

const runtimeDataPlaneSet = new Set<string>(runtimeDataPlanes);
const dataPlaneInstanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const maxPlatformTenantNameLength = 100;

export interface LivePlatformTenantConfiguration {
  id: string;
  name: string;
  instanceUrl: string;
}

type RuntimePlatformTenantEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | typeof RUNTIME_DATA_PLANE_ENV_KEY
    | typeof RUNTIME_DATA_PLANE_ID_ENV_KEY
    | typeof RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY
    | "PUBLIC_BASE_URL"
  >
>;

/**
 * 模拟平面沿用既有单租户身份，避免已有本地测试数据和夹具失效。真实平面绝不能复用它。
 */
export const createSimulationPlatformTenant = (): PlatformTenantRecord => ({
  id: "tenant-a",
  code: "current",
  name: "公益智助柜当前实例",
  status: "active",
  instanceUrl: "https://vending.5gogogo.top",
  contactName: "实例管理员",
  planName: "正式版",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const requireLiveTenantSetting = (
  environment: RuntimePlatformTenantEnvironment,
  key: typeof RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY | "PUBLIC_BASE_URL"
) => {
  const value = environment[key]?.trim();

  if (!value) {
    throw new Error(`真实数据平面缺少必填配置：${key}。`);
  }

  return value;
};

/**
 * 真实平面只有一个当前客户实例。其 ID 与平面 ID 绑定，展示 URL 与公开入口绑定，
 * 两者不从历史快照推断，防止错根目录或旧快照改变真实实例归属。
 */
export const resolveLivePlatformTenantConfiguration = (
  environment: RuntimePlatformTenantEnvironment = process.env
): LivePlatformTenantConfiguration => {
  if (resolveRuntimeDataPlane(environment) !== "live") {
    throw new Error("只有真实数据平面可以解析真实客户实例配置。");
  }

  const id = resolveRuntimeDataPlaneInstanceId(environment);
  const name = requireLiveTenantSetting(environment, RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY);
  const instanceUrl = requireLiveTenantSetting(environment, "PUBLIC_BASE_URL");

  if ([...name].length > maxPlatformTenantNameLength || /[\r\n]/.test(name)) {
    throw new Error(
      `${RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY} 必须是 1 至 ${maxPlatformTenantNameLength} 个字符的单行名称。`
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(instanceUrl);
  } catch {
    throw new Error("真实数据平面 PUBLIC_BASE_URL 必须是有效的完整 URL。");
  }

  if (
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "真实数据平面 PUBLIC_BASE_URL 必须是不含账号、查询参数或片段的 HTTP(S) URL。"
    );
  }

  return { id, name, instanceUrl };
};

/**
 * 真实快照必须只持久化一个、且与本次受控部署配置完全一致的客户实例。比较使用配置原值，
 * 避免 URL 尾斜杠等看似等价的差异掩盖错误部署或错误恢复。
 */
export const assertLivePlatformTenantConfiguration = (
  tenants: unknown,
  environment: RuntimePlatformTenantEnvironment = process.env
) => {
  const expected = resolveLivePlatformTenantConfiguration(environment);

  if (!Array.isArray(tenants) || tenants.length !== 1) {
    throw new Error("真实数据平面必须持久化且仅持久化一个当前客户实例。");
  }

  const tenant = tenants[0];

  if (typeof tenant !== "object" || tenant === null || Array.isArray(tenant)) {
    throw new Error("真实数据平面的当前客户实例记录无效。");
  }

  const record = tenant as Record<string, unknown>;

  if (record.id !== expected.id) {
    throw new Error(
      `真实数据平面的客户实例 ID 必须与 ${RUNTIME_DATA_PLANE_ID_ENV_KEY} 一致。`
    );
  }

  if (record.instanceUrl !== expected.instanceUrl) {
    throw new Error("真实数据平面的客户实例 URL 必须与 PUBLIC_BASE_URL 一致。");
  }

  if (record.name !== expected.name) {
    throw new Error(
      `真实数据平面的客户实例名称必须与 ${RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY} 一致。`
    );
  }
};

export const parseRuntimeDataPlane = (raw?: string): RuntimeDataPlane => {
  const normalized = raw?.trim().toLowerCase();

  if (!normalized) {
    return "simulation";
  }

  if (runtimeDataPlaneSet.has(normalized)) {
    return normalized as RuntimeDataPlane;
  }

  throw new Error(
    `${RUNTIME_DATA_PLANE_ENV_KEY} 只能设置为 simulation 或 live。`
  );
};

export const resolveRuntimeDataPlane = (
  environment: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | typeof RUNTIME_DATA_PLANE_ENV_KEY
      | typeof RUNTIME_DATA_ROOT_ENV_KEY
      | typeof RUNTIME_DATA_PLANE_ID_ENV_KEY
    >
  > = process.env
) => {
  const configuredPlane = environment[RUNTIME_DATA_PLANE_ENV_KEY]?.trim();
  const hasDataPlaneBoundaryConfig = Boolean(
    environment[RUNTIME_DATA_ROOT_ENV_KEY]?.trim() ||
      environment[RUNTIME_DATA_PLANE_ID_ENV_KEY]?.trim()
  );

  if (!configuredPlane && hasDataPlaneBoundaryConfig) {
    throw new Error(
      `${RUNTIME_DATA_PLANE_ENV_KEY} 不能为空：设置 ${RUNTIME_DATA_ROOT_ENV_KEY} 或 ${RUNTIME_DATA_PLANE_ID_ENV_KEY} 时必须显式选择 simulation 或 live。`
    );
  }

  return parseRuntimeDataPlane(configuredPlane);
};

export const isLiveRuntimeDataPlane = (
  environment: Partial<Pick<NodeJS.ProcessEnv, typeof RUNTIME_DATA_PLANE_ENV_KEY>> = process.env
) => resolveRuntimeDataPlane(environment) === "live";

/**
 * 平面 ID 是部署边界的一部分，不能从易损坏的状态文件反推。这样即使状态文件本身已损坏，
 * 恢复流程仍能拒绝来自另一真实实例的备份。
 */
export const resolveRuntimeDataPlaneInstanceId = (
  environment: Partial<
    Pick<
      NodeJS.ProcessEnv,
      typeof RUNTIME_DATA_PLANE_ENV_KEY | typeof RUNTIME_DATA_PLANE_ID_ENV_KEY
    >
  > = process.env
) => {
  const dataPlane = resolveRuntimeDataPlane(environment);
  const instanceId =
    environment[RUNTIME_DATA_PLANE_ID_ENV_KEY]?.trim() ||
    (dataPlane === "simulation" ? "simulation-default" : "");

  if (!dataPlaneInstanceIdPattern.test(instanceId)) {
    throw new Error(
      `${RUNTIME_DATA_PLANE_ID_ENV_KEY} 必须是 8 至 128 位字母、数字、点、下划线或连字符；真实平面必须显式设置。`
    );
  }

  return instanceId;
};

/**
 * 真实平面与生产运行态必须成对出现：不能借由缺省值把模拟数据当作真实数据启动，
 * 也不能把持有真实支付、短信和柜机能力的进程伪装成 development 而跳过生产门禁。
 */
export const assertProductionRuntimeDataPlane = (
  environment: Partial<Pick<
    NodeJS.ProcessEnv,
      "NODE_ENV" |
      "APP_ENV" |
      typeof RUNTIME_DATA_PLANE_ENV_KEY |
      typeof RUNTIME_DATA_ROOT_ENV_KEY |
      typeof RUNTIME_DATA_PLANE_ID_ENV_KEY
  >> = process.env
) => {
  const dataPlane = resolveRuntimeDataPlane(environment);
  const productionRuntime = isProductionRuntime(environment);

  if (dataPlane === "live" && !productionRuntime) {
    throw new Error(
      `真实数据平面必须在 NODE_ENV 或 APP_ENV 为 production 的受控运行态启动。`
    );
  }

  if (productionRuntime && dataPlane !== "live") {
    throw new Error(
      `生产环境必须显式设置 ${RUNTIME_DATA_PLANE_ENV_KEY}=live。`
    );
  }

  if (productionRuntime || dataPlane === "live") {
    resolveRuntimeDataPlaneInstanceId(environment);
  }

  return dataPlane;
};
