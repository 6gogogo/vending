import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { isIP } from "node:net";

import type { InMemoryStoreService } from "../store/in-memory-store.service";
import { isProductionRuntime } from "./runtime-environment";

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
  "PUBLIC_BASE_URL",
  "CORS_ORIGINS",
  "VERIFICATION_CODE_PROVIDER",
  "VERIFICATION_CODE_PREVIEW_ENABLED",
  "ALIYUN_SMS_ACCESS_KEY_ID",
  "ALIYUN_SMS_ACCESS_KEY_SECRET",
  "ALLOW_DEFAULT_BACKOFFICE_LOGIN",
  ...productionSmartVmSafetyCriticalKeys,
  ...productionPaymentSafetyCriticalKeys
] as const;

export const assertProductionPaymentSafety = (configService: ConfigService) => {
  const publicBaseUrl = requireConfig(configService, "PUBLIC_BASE_URL");
  assertPublicHttpsUrl(publicBaseUrl, "PUBLIC_BASE_URL");

  const paymentMode = readConfig(configService, "PAYMENT_MODE")?.toLowerCase();
  const legacyPaymentMockEnabled = readConfig(configService, "PAYMENT_MOCK_ENABLED");

  if (paymentMode) {
    if (paymentMode !== "real") {
      throw new BadRequestException("生产环境必须显式设置 PAYMENT_MODE=real。");
    }
  } else if (!isFalsey(legacyPaymentMockEnabled)) {
    throw new BadRequestException("生产环境必须显式设置 PAYMENT_MODE=real，或兼容设置 PAYMENT_MOCK_ENABLED=false。");
  }

  if (!isTruthy(readConfig(configService, "FINANCIAL_SINGLE_WRITER_ENABLED"))) {
    throw new BadRequestException(
      "JSON 账本生产阶段必须显式设置 FINANCIAL_SINGLE_WRITER_ENABLED=true。"
    );
  }

  if (!isTruthy(readConfig(configService, "PAYMENT_RECONCILIATION_ENABLED"))) {
    throw new BadRequestException(
      "真实支付必须显式设置 PAYMENT_RECONCILIATION_ENABLED=true。"
    );
  }

  for (const key of ["WEB_CONCURRENCY", "API_INSTANCE_COUNT"] as const) {
    const rawValue = readConfig(configService, key);
    if (rawValue && rawValue !== "1") {
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
  const smartVmBaseUrl = requireConfig(configService, "SMARTVM_BASE_URL");
  assertPublicHttpsUrl(smartVmBaseUrl, "SMARTVM_BASE_URL");
  requireConfigs(configService, ["SMARTVM_CLIENT_ID", "SMARTVM_KEY"]);

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
  const publicBaseUrl = requireConfig(configService, "PUBLIC_BASE_URL");
  assertPublicHttpsUrl(publicBaseUrl, "PUBLIC_BASE_URL");

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
  if (verificationProvider !== "aliyun") {
    throw new BadRequestException("生产环境必须使用真实短信验证码服务。");
  }

  if (
    isTruthy(
      readConfig(configService, "VERIFICATION_CODE_PREVIEW_ENABLED")
    )
  ) {
    throw new BadRequestException("生产环境不能开启验证码预览。");
  }

  requireConfigs(configService, [
    "ALIYUN_SMS_ACCESS_KEY_ID",
    "ALIYUN_SMS_ACCESS_KEY_SECRET"
  ]);
  assertProductionSmartVmSafety(configService);
  assertProductionPaymentSafety(configService);

  if (
    isTruthy(readConfig(configService, "ALLOW_DEFAULT_BACKOFFICE_LOGIN"))
  ) {
    throw new BadRequestException("生产环境不能允许默认后台密码登录。");
  }
};

export const assertProductionSafety = (
  configService: ConfigService,
  store: InMemoryStoreService
) => {
  if (!isProductionRuntime()) {
    return;
  }

  const mockDeviceCount = store.devices.filter((device) => device.isMock === true).length;

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

  const defaultCredentials = [
    ...store.adminCredentials
      .filter((credential) => credential.usesDefaultPassword)
      .map((credential) => credential.username),
    ...store.backofficeCredentials
      .filter((credential) => credential.usesDefaultPassword)
      .map((credential) => credential.username)
  ];

  if (defaultCredentials.length > 0) {
    throw new BadRequestException(
      `生产环境仍存在默认后台密码账号：${defaultCredentials.join("、")}`
    );
  }
};

// 受控网关只需要一个布尔结论；内部配置和运行数据的具体失败原因不能出现在公网响应中。
export const isProductionReady = (
  configService: ConfigService,
  store: InMemoryStoreService
) => {
  if (!isProductionRuntime()) {
    return false;
  }

  try {
    assertProductionSafety(configService, store);
    return true;
  } catch {
    return false;
  }
};
