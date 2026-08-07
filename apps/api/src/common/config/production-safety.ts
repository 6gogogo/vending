import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { isIP } from "node:net";

import type { InMemoryStoreService } from "../store/in-memory-store.service";
import type { SystemAuditLogService } from "../store/system-audit-log.service";
import { findActiveWarehouse } from "../store/default-warehouse";
import { isProductionRuntime } from "./runtime-environment";
import {
  RUNTIME_DATA_PLANE_ENV_KEY,
  RUNTIME_DATA_PLANE_ID_ENV_KEY,
  RUNTIME_DATA_ROOT_ENV_KEY,
  RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY
} from "./runtime-data-plane";
import {
  isReservationOnlyPickup,
  RESERVATION_ONLY_PICKUP_ENV_KEY
} from "./reservation-only-pickup";

export { isProductionRuntime } from "./runtime-environment";

const truthyValues = new Set(["1", "true", "yes", "on"]);
const falseyValues = new Set(["0", "false", "no", "off"]);

const isTruthy = (value: string | undefined) =>
  truthyValues.has(value?.trim().toLowerCase() ?? "");

const isFalsey = (value: string | undefined) =>
  falseyValues.has(value?.trim().toLowerCase() ?? "");

const readConfig = (configService: ConfigService, key: string) =>
  configService.get<string>(key)?.trim();

const requireConfig = (configService: ConfigService, key: string) => {
  const value = readConfig(configService, key);

  if (!value) {
    throw new BadRequestException(`生产环境缺少必填配置：${key}`);
  }

  return value;
};

const assertPublicHttpsUrl = (value: string, key: string) => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException(`生产环境 ${key} 必须是有效 URL。`);
  }

  if (parsed.protocol !== "https:") {
    throw new BadRequestException(`生产环境 ${key} 必须使用 HTTPS。`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::" ||
    hostname === "::1" ||
    isIP(hostname) !== 0
  ) {
    throw new BadRequestException(`生产环境 ${key} 必须使用公网域名，不能使用本机名或 IP 地址。`);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BadRequestException(`生产环境 ${key} 不能包含账号、密码、查询参数或片段。`);
  }

  return parsed;
};

const assertOfficialEndpoint = (
  value: string,
  key: string,
  allowedOrigins: readonly string[],
  allowedPathnames: readonly string[]
) => {
  const parsed = assertPublicHttpsUrl(value, key);

  if (!allowedOrigins.includes(parsed.origin)) {
    throw new BadRequestException(
      `生产环境 ${key} 必须使用支付渠道官方地址：${allowedOrigins.join(" 或 ")}。`
    );
  }

  if (!allowedPathnames.includes(parsed.pathname)) {
    throw new BadRequestException(
      `生产环境 ${key} 必须使用支付渠道官方路径：${allowedPathnames.join(" 或 ")}。`
    );
  }
};

const assertTrustedPaymentCallback = (
  value: string,
  key: string,
  publicBaseUrl: string,
  expectedPathname: string
) => {
  const parsed = assertPublicHttpsUrl(value, key);
  const trustedOrigin = new URL(publicBaseUrl).origin;

  if (parsed.origin !== trustedOrigin) {
    throw new BadRequestException(
      `生产环境 ${key} 必须与 PUBLIC_BASE_URL 同源，不能把支付回调发送到其他站点。`
    );
  }

  if (parsed.pathname !== expectedPathname) {
    throw new BadRequestException(
      `生产环境 ${key} 必须使用固定回调路径 ${expectedPathname}。`
    );
  }
};

const assertHttpsOrigin = (value: string, key: string) => {
  assertPublicHttpsUrl(value, key);
  const parsed = new URL(value);

  if (parsed.pathname !== "/") {
    throw new BadRequestException(`生产环境 ${key} 只能填写来源，不能包含路径。`);
  }
};

const requireConfigs = (configService: ConfigService, keys: readonly string[]) => {
  for (const key of keys) {
    requireConfig(configService, key);
  }
};

export const productionPaymentSafetyCriticalKeys = [
  "PUBLIC_BASE_URL",
  RESERVATION_ONLY_PICKUP_ENV_KEY,
  "PAYMENT_MODE",
  "PAYMENT_MOCK_ENABLED",
  "FINANCIAL_SINGLE_WRITER_ENABLED",
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
  "PAYMENT_RECONCILIATION_ENABLED",
  "PAYMENT_RECONCILIATION_INTERVAL_MS",
  "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS",
  "PAYMENT_RECONCILIATION_MAX_DELAY_MS",
  "PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS",
  "WEB_CONCURRENCY",
  "API_INSTANCE_COUNT",
  "NODE_APP_INSTANCE",
  "WECHAT_PAY_APP_ID",
  "WECHAT_MINI_APP_SECRET",
  "WECHAT_MINI_LOGIN_URL",
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_API_BASE_URL",
  "WECHAT_PAY_NOTIFY_URL",
  "WECHAT_PAY_REFUND_NOTIFY_URL",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_MERCHANT_PRIVATE_KEY",
  "WECHAT_PAY_MERCHANT_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_PUBLIC_KEY",
  "ALIPAY_APP_ID",
  "ALIPAY_GATEWAY_URL",
  "ALIPAY_NOTIFY_URL",
  "ALIPAY_SELLER_ID",
  "ALIPAY_APP_PRIVATE_KEY",
  "ALIPAY_PUBLIC_KEY"
] as const;

export const productionSmartVmSafetyCriticalKeys = [
  "SMARTVM_MODE",
  "SMARTVM_BASE_URL",
  "SMARTVM_ALLOWED_NOTIFY_ORIGINS",
  "SMARTVM_CLIENT_ID",
  "SMARTVM_KEY",
  "SMARTVM_ALLOW_UNSIGNED_CALLBACKS",
  "ALLOW_UNSIGNED_SMARTVM_CALLBACKS",
  "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS",
  "SMARTVM_PAYMENT_SUCCESS_PATH",
  "SMARTVM_DOOR_STATUS_CALLBACK_PATH",
  "SMARTVM_SETTLEMENT_CALLBACK_PATH",
  "SMARTVM_ADJUSTMENT_CALLBACK_PATH",
  "SMARTVM_REFUND_CALLBACK_PATH",
  "SMARTVM_CALLBACK_MAX_AGE_SECONDS",
  "SMARTVM_CALLBACK_FUTURE_TOLERANCE_SECONDS",
  "SMARTVM_CALLBACK_EVENT_MAX_AGE_SECONDS"
] as const;

export const productionConfigurationSafetyCriticalKeys = [
  "NODE_ENV",
  "APP_ENV",
  RUNTIME_DATA_PLANE_ENV_KEY,
  RUNTIME_DATA_PLANE_ID_ENV_KEY,
  RUNTIME_DATA_ROOT_ENV_KEY,
  RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY,
  "PUBLIC_BASE_URL",
  "CORS_ORIGINS",
  "VERIFICATION_CODE_PROVIDER",
  "VERIFICATION_CODE_PREVIEW_ENABLED",
  "ALIYUN_PNVS_ACCESS_KEY_ID",
  "ALIYUN_PNVS_ACCESS_KEY_SECRET",
  "ALIYUN_PNVS_SIGN_NAME",
  "ALIYUN_PNVS_TEMPLATE_CODE",
  "ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN",
  "ALIYUN_PNVS_SCHEME_NAME_REGISTER",
  "ALIYUN_PNVS_SCHEME_NAME_GENERAL",
  "ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET",
  "ALLOW_DEFAULT_BACKOFFICE_LOGIN",
  ...productionSmartVmSafetyCriticalKeys,
  ...productionPaymentSafetyCriticalKeys
] as const;

export const assertProductionPaymentSafety = (configService: ConfigService) => {
  const publicBaseUrl = requireConfig(configService, "PUBLIC_BASE_URL");
  assertPublicHttpsUrl(publicBaseUrl, "PUBLIC_BASE_URL");

  const paymentMode = readConfig(configService, "PAYMENT_MODE")?.toLowerCase();
  const legacyPaymentMockEnabled = readConfig(configService, "PAYMENT_MOCK_ENABLED");
  const reservationOnly = isReservationOnlyPickup({
    [RESERVATION_ONLY_PICKUP_ENV_KEY]: readConfig(
      configService,
      RESERVATION_ONLY_PICKUP_ENV_KEY
    )
  });
  const paymentDisabled = paymentMode === "disabled";

  if (paymentDisabled && !reservationOnly) {
    throw new BadRequestException(
      "PAYMENT_MODE=disabled 只允许用于预约取货模式。"
    );
  }

  if (paymentMode && !paymentDisabled) {
    if (paymentMode !== "real") {
      throw new BadRequestException("生产环境必须显式设置 PAYMENT_MODE=real。");
    }
  } else if (!paymentDisabled && !isFalsey(legacyPaymentMockEnabled)) {
    throw new BadRequestException("生产环境必须显式设置 PAYMENT_MODE=real，或兼容设置 PAYMENT_MOCK_ENABLED=false。");
  }

  if (!isTruthy(readConfig(configService, "FINANCIAL_SINGLE_WRITER_ENABLED"))) {
    throw new BadRequestException(
      "JSON 账本生产阶段必须显式设置 FINANCIAL_SINGLE_WRITER_ENABLED=true。"
    );
  }

  if (
    !paymentDisabled &&
    !isTruthy(readConfig(configService, "PAYMENT_RECONCILIATION_ENABLED"))
  ) {
    throw new BadRequestException(
      "真实支付必须显式设置 PAYMENT_RECONCILIATION_ENABLED=true。"
    );
  }

  const apiWorkerCounts = ["WEB_CONCURRENCY", "API_INSTANCE_COUNT"] as const;

  for (const key of apiWorkerCounts) {
    const rawValue = readConfig(configService, key);
    if (rawValue !== "1") {
      throw new BadRequestException(
        `JSON 账本阶段只支持一个 API 工作者，生产环境必须设置 ${key}=1。`
      );
    }
  }

  const nodeAppInstance = readConfig(configService, "NODE_APP_INSTANCE");
  if (nodeAppInstance && nodeAppInstance !== "0") {
    throw new BadRequestException(
      "JSON 账本阶段不能使用 PM2 cluster 多实例，NODE_APP_INSTANCE 只能为空或 0。"
    );
  }

  if (paymentDisabled) {
    return;
  }

  requireConfigs(configService, [
    "WECHAT_PAY_APP_ID",
    "WECHAT_MINI_APP_SECRET",
    "WECHAT_PAY_MCH_ID",
    "WECHAT_PAY_API_V3_KEY",
    "WECHAT_PAY_MERCHANT_PRIVATE_KEY",
    "WECHAT_PAY_MERCHANT_CERT_SERIAL_NO",
    "WECHAT_PAY_PLATFORM_CERT_SERIAL_NO",
    "WECHAT_PAY_PLATFORM_PUBLIC_KEY",
    "ALIPAY_APP_ID",
    "ALIPAY_SELLER_ID",
    "ALIPAY_APP_PRIVATE_KEY",
    "ALIPAY_PUBLIC_KEY"
  ]);

  const wechatLoginUrl = readConfig(configService, "WECHAT_MINI_LOGIN_URL");
  if (wechatLoginUrl) {
    assertOfficialEndpoint(
      wechatLoginUrl,
      "WECHAT_MINI_LOGIN_URL",
      ["https://api.weixin.qq.com"],
      ["/sns/jscode2session"]
    );
  }

  const wechatApiBaseUrl = readConfig(configService, "WECHAT_PAY_API_BASE_URL");
  if (wechatApiBaseUrl) {
    assertOfficialEndpoint(
      wechatApiBaseUrl,
      "WECHAT_PAY_API_BASE_URL",
      ["https://api.mch.weixin.qq.com", "https://api2.mch.weixin.qq.com"],
      ["/"]
    );
  }

  const alipayGatewayUrl = readConfig(configService, "ALIPAY_GATEWAY_URL");
  if (alipayGatewayUrl) {
    assertOfficialEndpoint(
      alipayGatewayUrl,
      "ALIPAY_GATEWAY_URL",
      ["https://openapi.alipay.com"],
      ["/gateway.do"]
    );
  }

  for (const [key, pathname] of [
    ["WECHAT_PAY_NOTIFY_URL", "/api/payments/callbacks/wechat"],
    ["WECHAT_PAY_REFUND_NOTIFY_URL", "/api/payments/callbacks/wechat-refund"],
    ["ALIPAY_NOTIFY_URL", "/api/payments/callbacks/alipay"]
  ] as const) {
    const value = readConfig(configService, key);
    if (value) {
      assertTrustedPaymentCallback(value, key, publicBaseUrl, pathname);
    }
  }
};

export const assertProductionSmartVmSafety = (configService: ConfigService) => {
  const mode = readConfig(configService, "SMARTVM_MODE")?.toLowerCase() || "real";

  if (!["real", "disabled"].includes(mode)) {
    throw new BadRequestException(
      "生产环境 SMARTVM_MODE 只能设置为 real 或 disabled。"
    );
  }

  if (
    isTruthy(readConfig(configService, "SMARTVM_ALLOW_UNSIGNED_CALLBACKS")) ||
    isTruthy(readConfig(configService, "ALLOW_UNSIGNED_SMARTVM_CALLBACKS"))
  ) {
    throw new BadRequestException("生产环境不能允许未签名 SmartVM 回调。");
  }

  if (
    isTruthy(
      readConfig(
        configService,
        "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS"
      )
    )
  ) {
    throw new BadRequestException(
      "生产环境不能开启结算后自动转发付款成功；正金额订单必须由已确认支付单驱动回写。"
    );
  }

  if (mode === "disabled") {
    const configuredKeys = [
      "SMARTVM_BASE_URL",
      "SMARTVM_ALLOWED_NOTIFY_ORIGINS",
      "SMARTVM_CLIENT_ID",
      "SMARTVM_KEY"
    ].filter((key) => Boolean(readConfig(configService, key)));

    if (configuredKeys.length > 0) {
      throw new BadRequestException(
        `柜机平台禁用时不能保留 SmartVM 接入配置：${configuredKeys.join("、")}。`
      );
    }

    return;
  }

  const smartVmBaseUrl = requireConfig(configService, "SMARTVM_BASE_URL");
  assertPublicHttpsUrl(smartVmBaseUrl, "SMARTVM_BASE_URL");
  requireConfigs(configService, ["SMARTVM_CLIENT_ID", "SMARTVM_KEY"]);

  const allowedNotifyOrigins =
    readConfig(configService, "SMARTVM_ALLOWED_NOTIFY_ORIGINS")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  for (const origin of allowedNotifyOrigins) {
    assertHttpsOrigin(origin, "SMARTVM_ALLOWED_NOTIFY_ORIGINS");
  }

  const paymentSuccessPath = readConfig(
    configService,
    "SMARTVM_PAYMENT_SUCCESS_PATH"
  );
  if (
    paymentSuccessPath &&
    (
      !paymentSuccessPath.startsWith("/") ||
      paymentSuccessPath.startsWith("//") ||
      paymentSuccessPath.includes("?") ||
      paymentSuccessPath.includes("#")
    )
  ) {
    throw new BadRequestException(
      "生产环境 SMARTVM_PAYMENT_SUCCESS_PATH 必须是站内绝对路径，不能包含来源、查询参数或片段。"
    );
  }
};

export const assertProductionConfigurationSafety = (
  configService: ConfigService
) => {
  const runtimeDataPlane = readConfig(configService, RUNTIME_DATA_PLANE_ENV_KEY);

  if (runtimeDataPlane !== "live") {
    throw new BadRequestException(
      `生产环境必须显式设置 ${RUNTIME_DATA_PLANE_ENV_KEY}=live。`
    );
  }

  requireConfig(configService, RUNTIME_DATA_ROOT_ENV_KEY);
  requireConfig(configService, RUNTIME_DATA_PLANE_ID_ENV_KEY);

  const publicBaseUrl = requireConfig(configService, "PUBLIC_BASE_URL");
  assertPublicHttpsUrl(publicBaseUrl, "PUBLIC_BASE_URL");

  const platformTenantName = requireConfig(
    configService,
    RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY
  );
  if ([...platformTenantName].length > 100 || /[\r\n]/.test(platformTenantName)) {
    throw new BadRequestException(
      `${RUNTIME_PLATFORM_TENANT_NAME_ENV_KEY} 必须是 1 至 100 个字符的单行名称。`
    );
  }

  const corsOrigins = requireConfig(configService, "CORS_ORIGINS");
  const parsedCorsOrigins = corsOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (parsedCorsOrigins.length === 0) {
    throw new BadRequestException(
      "生产环境 CORS_ORIGINS 至少要包含一个可信 HTTPS 来源。"
    );
  }

  for (const origin of parsedCorsOrigins) {
    assertHttpsOrigin(origin, "CORS_ORIGINS");
  }

  const verificationProvider = requireConfig(
    configService,
    "VERIFICATION_CODE_PROVIDER"
  );
  if (verificationProvider !== "aliyun_pnvs") {
    throw new BadRequestException(
      "生产环境验证码必须使用阿里云 PNVS 发送短信；后台签发的一次性人工验证码仅作为应急保底。"
    );
  }

  if (
    isTruthy(
      readConfig(configService, "VERIFICATION_CODE_PREVIEW_ENABLED")
    )
  ) {
    throw new BadRequestException("生产环境不能开启验证码预览。");
  }

  if (verificationProvider === "aliyun_pnvs") {
    requireConfigs(configService, [
      "ALIYUN_PNVS_ACCESS_KEY_ID",
      "ALIYUN_PNVS_ACCESS_KEY_SECRET",
      "ALIYUN_PNVS_SIGN_NAME",
      "ALIYUN_PNVS_TEMPLATE_CODE"
    ]);
  }
  assertProductionSmartVmSafety(configService);
  assertProductionPaymentSafety(configService);

  if (
    isTruthy(readConfig(configService, "ALLOW_DEFAULT_BACKOFFICE_LOGIN"))
  ) {
    throw new BadRequestException("生产环境不能允许默认后台密码登录。");
  }
};

type PaymentLedgerStore = Pick<
  InMemoryStoreService,
  "paymentOrders" | "paymentRefunds"
>;

export const assertPaymentDisablementStoreSafety = (
  configService: ConfigService,
  store?: PaymentLedgerStore
) => {
  const paymentMode = readConfig(configService, "PAYMENT_MODE")?.toLowerCase();

  if (paymentMode !== "disabled") {
    return;
  }

  if (!store) {
    throw new BadRequestException(
      "无法核验当前实例的支付与退款账本，已拒绝关闭支付配置。"
    );
  }

  if (
    (store.paymentOrders?.length ?? 0) > 0 ||
    (store.paymentRefunds?.length ?? 0) > 0
  ) {
    throw new BadRequestException(
      "当前实例已有支付或退款账本，不能关闭支付配置；请保留真实支付配置用于历史账务处理。"
    );
  }
};

export const assertProductionSafety = (
  configService: ConfigService,
  store: InMemoryStoreService,
  auditLog: SystemAuditLogService
) => {
  if (!isProductionRuntime()) {
    return;
  }

  const mockDeviceCount = store.devices.filter((device) => device.isMock === true).length;

  if (!store.isLiveDataPlane()) {
    throw new BadRequestException("生产进程只能加载真实数据平面。");
  }

  const runtimeDataPlane = store.getRuntimeDataPlaneIdentity();
  const configuredDataPlaneId = requireConfig(
    configService,
    RUNTIME_DATA_PLANE_ID_ENV_KEY
  );

  if (
    runtimeDataPlane.dataPlane !== "live" ||
    runtimeDataPlane.instanceId !== configuredDataPlaneId
  ) {
    throw new BadRequestException("真实运行数据与受控部署标识不一致。");
  }

  if (runtimeDataPlane.initializationSource !== "live-bootstrap") {
    throw new BadRequestException("真实数据平面尚未完成受控初始化。");
  }

  if (mockDeviceCount > 0) {
    throw new BadRequestException(
      `生产环境不能加载模拟设备，检测到 ${mockDeviceCount} 台 isMock=true 设备，请先清理持久化运行数据。`
    );
  }

  const simulatedPaymentCount = (store.paymentOrders ?? []).filter(
    (order) => order.metadata?.simulated === true || order.invokePayload?.simulated === true
  ).length;

  if (simulatedPaymentCount > 0) {
    throw new BadRequestException(
      `生产环境不能加载模拟支付单，检测到 ${simulatedPaymentCount} 笔模拟支付数据，请先清理持久化运行数据。`
    );
  }

  assertProductionConfigurationSafety(configService);
  assertPaymentDisablementStoreSafety(configService, store);

  if (
    readConfig(configService, "SMARTVM_MODE")?.toLowerCase() === "disabled" &&
    store.devices.length > 0
  ) {
    throw new BadRequestException(
      "柜机平台尚未启用，真实数据平面不能加载柜机；请先配置生产 SmartVM 再录入设备。"
    );
  }

  if (!auditLog.isReady()) {
    throw new BadRequestException("系统审计日志未就绪。");
  }

  if (!store.isPersistedStateIntegrityReady()) {
    throw new BadRequestException("生产运行数据完整性检查未通过。");
  }

  if (!findActiveWarehouse(store.warehouses)) {
    throw new BadRequestException("真实数据平面至少需要一个启用的本地仓库。");
  }

  const defaultCredentialCount = [
    ...store.adminCredentials,
    ...store.backofficeCredentials
  ].filter((credential) => credential.usesDefaultPassword !== false).length;

  if (defaultCredentialCount > 0) {
    throw new BadRequestException("生产环境仍存在默认后台密码账号。");
  }

  if (store.adminCredentials.length > 0) {
    throw new BadRequestException("真实数据平面不能保留旧管理员密码凭据。");
  }

  const hasActiveSuperAdmin = store.backofficeCredentials.some((credential) => {
    if (credential.role !== "super_admin" || credential.usesDefaultPassword !== false) {
      return false;
    }

    const user = store.users.find((entry) => entry.id === credential.userId);
    return user?.status === "active" && user.role === "admin";
  });

  if (!hasActiveSuperAdmin) {
    throw new BadRequestException("真实数据平面尚未配置有效的超级管理员账号。");
  }
};

// 受控网关只需要一个布尔结论；内部配置和运行数据的具体失败原因不能出现在公网响应中。
export const isProductionReady = (
  configService: ConfigService,
  store: InMemoryStoreService,
  auditLog: SystemAuditLogService
) => {
  if (!isProductionRuntime()) {
    return false;
  }

  try {
    assertProductionSafety(configService, store, auditLog);
    return true;
  } catch {
    return false;
  }
};
