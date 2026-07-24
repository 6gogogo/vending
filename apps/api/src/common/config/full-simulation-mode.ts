import {
  RUNTIME_DATA_PLANE_ENV_KEY,
  RUNTIME_DATA_PLANE_ID_ENV_KEY,
  RUNTIME_DATA_ROOT_ENV_KEY,
  resolveRuntimeDataPlane
} from "./runtime-data-plane";

/**
 * 全真模拟仍属于 simulation 数据平面：它只允许在隔离的本地业务数据上，
 * 针对单个外部模块选择真实或 mock 传输。它不是生产平面的降级开关。
 */
export const FULL_SIMULATION_PROFILE_ENV_KEY = "VM_SIMULATION_PROFILE";
export const FULL_SIMULATION_ENABLED_ENV_KEY = "VM_FULL_SIMULATION_ENABLED";

export const fullSimulationProfiles = ["standard", "full"] as const;
export type FullSimulationProfile = (typeof fullSimulationProfiles)[number];

export const fullSimulationExternalModules = [
  "smartvm",
  "payment",
  "verification",
  "ai",
  "map"
] as const;
export type FullSimulationExternalModule =
  (typeof fullSimulationExternalModules)[number];
export type FullSimulationExternalMode = "mock" | "real";
export type FullSimulationVerificationMode = FullSimulationExternalMode | "manual";
type FullSimulationModeFor<Module extends FullSimulationExternalModule> =
  Module extends "verification" ? FullSimulationVerificationMode : FullSimulationExternalMode;

export const fullSimulationExternalModeEnvKeys: Record<
  FullSimulationExternalModule,
  string
> = {
  smartvm: "VM_FULL_SIMULATION_SMARTVM_MODE",
  payment: "VM_FULL_SIMULATION_PAYMENT_MODE",
  verification: "VM_FULL_SIMULATION_VERIFICATION_MODE",
  ai: "VM_FULL_SIMULATION_AI_MODE",
  map: "VM_FULL_SIMULATION_MAP_MODE"
};

export const fullSimulationExternalModeKeys = Object.values(
  fullSimulationExternalModeEnvKeys
);

export type FullSimulationEnvironment = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | typeof RUNTIME_DATA_PLANE_ENV_KEY
    | typeof RUNTIME_DATA_ROOT_ENV_KEY
    | typeof RUNTIME_DATA_PLANE_ID_ENV_KEY
    | typeof FULL_SIMULATION_PROFILE_ENV_KEY
    | typeof FULL_SIMULATION_ENABLED_ENV_KEY
    | "VM_FULL_SIMULATION_SMARTVM_MODE"
    | "VM_FULL_SIMULATION_PAYMENT_MODE"
    | "VM_FULL_SIMULATION_VERIFICATION_MODE"
    | "VM_FULL_SIMULATION_AI_MODE"
    | "VM_FULL_SIMULATION_MAP_MODE"
  >
>;

const truthyValues = new Set(["1", "true", "yes", "on"]);

const normalize = (value?: string) => value?.trim().toLowerCase();

const isTruthy = (value?: string) => truthyValues.has(normalize(value) ?? "");

export const resolveFullSimulationProfile = (
  environment: FullSimulationEnvironment = process.env
): FullSimulationProfile => {
  const raw = normalize(environment[FULL_SIMULATION_PROFILE_ENV_KEY]);

  if (!raw || raw === "standard") {
    return "standard";
  }

  if (raw === "full") {
    return "full";
  }

  throw new Error(
    `${FULL_SIMULATION_PROFILE_ENV_KEY} 只能设置为 standard 或 full。`
  );
};

export const isFullSimulationProfile = (
  environment: FullSimulationEnvironment = process.env
) => resolveFullSimulationProfile(environment) === "full";

/**
 * 只在全真模拟档返回模块传输模式；标准模拟和真实平面由它们各自的既有规则处理。
 */
export const resolveFullSimulationExternalMode = <Module extends FullSimulationExternalModule>(
  module: Module,
  environment: FullSimulationEnvironment = process.env
): FullSimulationModeFor<Module> | undefined => {
  if (!isFullSimulationProfile(environment)) {
    return undefined;
  }

  const key = fullSimulationExternalModeEnvKeys[module];
  const raw = normalize(environment[key as keyof FullSimulationEnvironment]);

  if (!raw || raw === "mock") {
    return "mock" as FullSimulationModeFor<Module>;
  }

  if (raw === "real") {
    return "real" as FullSimulationModeFor<Module>;
  }

  if (module === "verification" && raw === "manual") {
    return "manual" as FullSimulationModeFor<Module>;
  }

  throw new Error(
    module === "verification"
      ? `${key} 只能设置为 mock、real 或 manual。`
      : `${key} 只能设置为 mock 或 real。`
  );
};

/**
 * 进入全真模拟前必须显式声明 simulation 平面、独立根目录和实例标识。
 * 这样不会复用日常模拟数据，更不会碰到 live 数据根。
 */
export const assertFullSimulationIsolation = (
  environment: FullSimulationEnvironment = process.env
) => {
  if (!isFullSimulationProfile(environment)) {
    return false;
  }

  if (normalize(environment[RUNTIME_DATA_PLANE_ENV_KEY]) !== "simulation") {
    throw new Error(
      `全真模拟只能设置在 ${RUNTIME_DATA_PLANE_ENV_KEY}=simulation 的隔离数据平面中。`
    );
  }

  if (!isTruthy(environment[FULL_SIMULATION_ENABLED_ENV_KEY])) {
    throw new Error(
      `全真模拟必须显式设置 ${FULL_SIMULATION_ENABLED_ENV_KEY}=true。`
    );
  }

  if (!environment[RUNTIME_DATA_ROOT_ENV_KEY]?.trim()) {
    throw new Error(
      `全真模拟必须设置独立的 ${RUNTIME_DATA_ROOT_ENV_KEY}。`
    );
  }

  if (!environment[RUNTIME_DATA_PLANE_ID_ENV_KEY]?.trim()) {
    throw new Error(
      `全真模拟必须设置独立的 ${RUNTIME_DATA_PLANE_ID_ENV_KEY}。`
    );
  }

  for (const module of fullSimulationExternalModules) {
    resolveFullSimulationExternalMode(module, environment);
  }

  // 复核 data plane，避免仅靠 profile 文本绕过 resolveRuntimeDataPlane 的边界检查。
  if (resolveRuntimeDataPlane(environment) !== "simulation") {
    throw new Error("全真模拟必须使用 simulation 数据平面。");
  }

  return true;
};
