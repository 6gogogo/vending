import {
  RUNTIME_DATA_PLANE_ENV_KEY,
  RUNTIME_DATA_PLANE_ID_ENV_KEY,
  RUNTIME_DATA_ROOT_ENV_KEY,
  resolveRuntimeDataPlane,
  type RuntimeDataPlane
} from "./runtime-data-plane";
import {
  assertFullSimulationIsolation,
  FULL_SIMULATION_ENABLED_ENV_KEY,
  FULL_SIMULATION_PROFILE_ENV_KEY,
  isFullSimulationProfile,
  resolveFullSimulationExternalMode,
  fullSimulationExternalModeKeys
} from "./full-simulation-mode";

export const runtimeDataPlaneExternalIntegrationKeys = [
  RUNTIME_DATA_PLANE_ENV_KEY,
  RUNTIME_DATA_ROOT_ENV_KEY,
  RUNTIME_DATA_PLANE_ID_ENV_KEY,
  FULL_SIMULATION_PROFILE_ENV_KEY,
  FULL_SIMULATION_ENABLED_ENV_KEY,
  ...fullSimulationExternalModeKeys,
  "PAYMENT_MODE",
  "VERIFICATION_CODE_PROVIDER",
  "VERIFICATION_CODE_PREVIEW_ENABLED",
  "VERIFICATION_CODE_MANUAL_VALUE",
  "OPENAI_API_KEY",
  "ENABLE_LOCAL_MOCK_DEVICE_API",
  "ENABLE_TEST_DEVICE_BOOTSTRAP",
  "SMARTVM_BASE_URL",
  "SMARTVM_CLIENT_ID",
  "SMARTVM_KEY",
  "SMARTVM_ALLOW_UNSIGNED_CALLBACKS",
  "ALLOW_UNSIGNED_SMARTVM_CALLBACKS",
  "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS"
] as const;

type RuntimeDataPlaneExternalIntegrationKey =
  (typeof runtimeDataPlaneExternalIntegrationKeys)[number];

export type RuntimeDataPlaneExternalIntegrationSettings = Partial<
  Record<RuntimeDataPlaneExternalIntegrationKey, string | undefined>
>;

/**
 * 仅用于运行配置不符合数据平面边界时。启动器可直接显示该错误，服务层会转换为
 * 不含敏感配置内容的 500 响应。
 */
export class RuntimeDataPlanePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeDataPlanePolicyError";
  }
}

const truthyValues = new Set(["1", "true", "yes", "on"]);
const manualVerificationCodePattern = /^\d{4,8}$/;

const normalize = (value?: string) => value?.trim().toLowerCase();

const isTruthy = (value?: string) =>
  truthyValues.has(normalize(value) ?? "");

const resolveDataPlane = (
  settings: RuntimeDataPlaneExternalIntegrationSettings
): RuntimeDataPlane =>
  resolveRuntimeDataPlane({
    [RUNTIME_DATA_PLANE_ENV_KEY]: settings[RUNTIME_DATA_PLANE_ENV_KEY]
  });

const requirePaymentMode = (
  dataPlane: RuntimeDataPlane,
  paymentMode: string | undefined,
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (isFullSimulationProfile(settings)) {
    resolveFullSimulationExternalMode("payment", settings);
    return;
  }

  const normalizedMode = normalize(paymentMode);
  const expectedMode = dataPlane === "live" ? "real" : "mock";

  if (normalizedMode !== expectedMode) {
    throw new RuntimeDataPlanePolicyError(
      dataPlane === "live"
        ? "真实数据平面只能设置 PAYMENT_MODE=real。"
        : "模拟数据平面只能设置 PAYMENT_MODE=mock，不能启用自动或真实支付。"
    );
  }
};

const requireVerificationPolicy = (
  dataPlane: RuntimeDataPlane,
  provider: string | undefined,
  previewEnabled: string | undefined,
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (isFullSimulationProfile(settings)) {
    const mode = resolveFullSimulationExternalMode("verification", settings);

    if (mode === "manual") {
      const manualCode = settings.VERIFICATION_CODE_MANUAL_VALUE?.trim();

      if (!manualVerificationCodePattern.test(manualCode ?? "")) {
        throw new RuntimeDataPlanePolicyError(
          "全真模拟手动验证码必须通过 VERIFICATION_CODE_MANUAL_VALUE 设置为 4 至 8 位数字。"
        );
      }
    }

    return;
  }

  const normalizedProvider = normalize(provider) || "mock";

  if (dataPlane === "simulation") {
    if (normalizedProvider !== "mock") {
      throw new RuntimeDataPlanePolicyError(
        "模拟数据平面只能使用 VERIFICATION_CODE_PROVIDER=mock，不能启用真实短信验证码服务。"
      );
    }
    return;
  }

  if (settings.VERIFICATION_CODE_MANUAL_VALUE?.trim()) {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面不能配置 VERIFICATION_CODE_MANUAL_VALUE。"
    );
  }

  if (normalizedProvider !== "aliyun_pnvs") {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面只能设置 VERIFICATION_CODE_PROVIDER=aliyun_pnvs。"
    );
  }

  if (isTruthy(previewEnabled)) {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面必须关闭 VERIFICATION_CODE_PREVIEW_ENABLED。"
    );
  }
};

/**
 * AI 请求会携带业务上下文并可能产生计费。模拟平面只允许本地规则和夹具，
 * 不能因为误留 API Key 而把测试数据外发；真实平面中的 AI 仍是可选能力。
 */
const requireAiPolicy = (
  dataPlane: RuntimeDataPlane,
  apiKey: string | undefined,
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (isFullSimulationProfile(settings)) {
    resolveFullSimulationExternalMode("ai", settings);
    return;
  }

  if (dataPlane === "simulation" && normalize(apiKey)) {
    throw new RuntimeDataPlanePolicyError(
      "模拟数据平面不能配置 OPENAI_API_KEY 或启用外部 AI 服务。"
    );
  }
};

const requireDevicePolicy = (
  dataPlane: RuntimeDataPlane,
  localMockDeviceApiEnabled: string | undefined,
  testDeviceBootstrapEnabled: string | undefined
) => {
  if (dataPlane === "live" && isTruthy(localMockDeviceApiEnabled)) {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面禁止启用 ENABLE_LOCAL_MOCK_DEVICE_API。"
    );
  }

  if (dataPlane === "live" && isTruthy(testDeviceBootstrapEnabled)) {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面禁止启用 ENABLE_TEST_DEVICE_BOOTSTRAP。"
    );
  }
};

const requireSmartVmPolicy = (
  dataPlane: RuntimeDataPlane,
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  const smartVmConfig = {
    SMARTVM_BASE_URL: normalize(settings.SMARTVM_BASE_URL),
    SMARTVM_CLIENT_ID: normalize(settings.SMARTVM_CLIENT_ID),
    SMARTVM_KEY: normalize(settings.SMARTVM_KEY)
  };
  const configuredKeys = Object.entries(smartVmConfig)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);

  if (isFullSimulationProfile(settings)) {
    const transportMode = resolveFullSimulationExternalMode("smartvm", settings);

    if (transportMode === "mock") {
      return;
    }

    const missingKeys = Object.entries(smartVmConfig)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missingKeys.length > 0) {
      throw new RuntimeDataPlanePolicyError(
        `全真模拟启用真实 SmartVM 时必须配置：${missingKeys.join("、")}。`
      );
    }

    return;
  }

  if (dataPlane === "simulation") {
    if (configuredKeys.length > 0) {
      throw new RuntimeDataPlanePolicyError(
        `模拟数据平面只能使用 SmartVM mock，不能配置真实 SmartVM 接入项：${configuredKeys.join("、")}。`
      );
    }
    return;
  }

  const missingKeys = Object.entries(smartVmConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingKeys.length > 0) {
    throw new RuntimeDataPlanePolicyError(
      `真实数据平面必须配置受控 SmartVM 接入项：${missingKeys.join("、")}。`
    );
  }

  let parsedBaseUrl: URL;

  try {
    parsedBaseUrl = new URL(smartVmConfig.SMARTVM_BASE_URL!);
  } catch {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面 SMARTVM_BASE_URL 必须是有效的生产 HTTPS 地址。"
    );
  }

  if (parsedBaseUrl.protocol !== "https:") {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面 SMARTVM_BASE_URL 必须使用 HTTPS。"
    );
  }

  if (
    isTruthy(settings.SMARTVM_ALLOW_UNSIGNED_CALLBACKS) ||
    isTruthy(settings.ALLOW_UNSIGNED_SMARTVM_CALLBACKS)
  ) {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面禁止允许未签名 SmartVM 回调。"
    );
  }

  if (isTruthy(settings.SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS)) {
    throw new RuntimeDataPlanePolicyError(
      "真实数据平面禁止自动将柜机结算转发为付款成功。"
    );
  }
};

/**
 * 应在主进程取得任何外部集成能力前执行。无论 NODE_ENV/APP_ENV 的值为何，
 * 数据平面本身决定可以调用的支付与短信渠道。
 */
export const assertRuntimeDataPlaneExternalIntegrationPolicy = (
  settings: RuntimeDataPlaneExternalIntegrationSettings = process.env
) => {
  const dataPlane = resolveDataPlane(settings);
  assertFullSimulationIsolation(settings);
  requirePaymentMode(dataPlane, settings.PAYMENT_MODE, settings);
  requireVerificationPolicy(
    dataPlane,
    settings.VERIFICATION_CODE_PROVIDER,
    settings.VERIFICATION_CODE_PREVIEW_ENABLED,
    settings
  );
  requireAiPolicy(dataPlane, settings.OPENAI_API_KEY, settings);
  requireDevicePolicy(
    dataPlane,
    settings.ENABLE_LOCAL_MOCK_DEVICE_API,
    settings.ENABLE_TEST_DEVICE_BOOTSTRAP
  );
  requireSmartVmPolicy(dataPlane, settings);
  return dataPlane;
};

/**
 * 服务层复核配置时只检查显式声明的数据平面。正常 API 进程会在 main.ts 的
 * 全量门禁中处理缺省值；此分支避免脱离启动器的单元夹具意外变成真实外呼。
 */
const hasExplicitRuntimeDataPlane = (
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => Boolean(normalize(settings[RUNTIME_DATA_PLANE_ENV_KEY]));

export const assertConfiguredRuntimeDataPlanePaymentPolicy = (
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (!hasExplicitRuntimeDataPlane(settings)) {
    return undefined;
  }

  const dataPlane = resolveDataPlane(settings);
  assertFullSimulationIsolation(settings);
  requirePaymentMode(dataPlane, settings.PAYMENT_MODE, settings);
  return dataPlane;
};

export const assertConfiguredRuntimeDataPlaneVerificationPolicy = (
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (!hasExplicitRuntimeDataPlane(settings)) {
    return undefined;
  }

  const dataPlane = resolveDataPlane(settings);
  requireVerificationPolicy(
    dataPlane,
    settings.VERIFICATION_CODE_PROVIDER,
    settings.VERIFICATION_CODE_PREVIEW_ENABLED,
    settings
  );
  return dataPlane;
};

export const assertConfiguredRuntimeDataPlaneAiPolicy = (
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (!hasExplicitRuntimeDataPlane(settings)) {
    return undefined;
  }

  const dataPlane = resolveDataPlane(settings);
  assertFullSimulationIsolation(settings);
  requireAiPolicy(dataPlane, settings.OPENAI_API_KEY, settings);
  return dataPlane;
};

export const assertConfiguredRuntimeDataPlaneSmartVmPolicy = (
  settings: RuntimeDataPlaneExternalIntegrationSettings
) => {
  if (!hasExplicitRuntimeDataPlane(settings)) {
    return undefined;
  }

  const dataPlane = resolveDataPlane(settings);
  assertFullSimulationIsolation(settings);
  requireSmartVmPolicy(dataPlane, settings);
  return dataPlane;
};
