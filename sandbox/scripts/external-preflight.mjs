import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sandboxRoot = resolve(scriptDir, "..");
const repoRoot = resolve(sandboxRoot, "..");

const statusRank = {
  pass: 0,
  skip: 1,
  warn: 2,
  fail: 3
};

const statusLabels = {
  pass: "通过",
  warn: "警告",
  fail: "失败",
  skip: "跳过"
};

const truthyValues = new Set(["1", "true", "yes", "on"]);
const falseyValues = new Set(["0", "false", "no", "off"]);

const wechatRequiredPaymentKeys = [
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_MERCHANT_PRIVATE_KEY",
  "WECHAT_PAY_MERCHANT_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_PUBLIC_KEY"
];

const alipayRequiredPaymentKeys = [
  "ALIPAY_APP_ID",
  "ALIPAY_APP_PRIVATE_KEY",
  "ALIPAY_PUBLIC_KEY"
];

const aliyunPnvsRequiredVerificationKeys = [
  "ALIYUN_PNVS_ACCESS_KEY_ID",
  "ALIYUN_PNVS_ACCESS_KEY_SECRET",
  "ALIYUN_PNVS_SIGN_NAME",
  "ALIYUN_PNVS_TEMPLATE_CODE"
];

const paymentProviders = [
  {
    provider: "wechat",
    label: "微信支付",
    requiredKeys: wechatRequiredPaymentKeys,
    notifyKey: "WECHAT_PAY_NOTIFY_URL",
    fallbackPath: "/api/payments/callbacks/wechat"
  },
  {
    provider: "alipay",
    label: "支付宝",
    requiredKeys: alipayRequiredPaymentKeys,
    notifyKey: "ALIPAY_NOTIFY_URL",
    fallbackPath: "/api/payments/callbacks/alipay"
  }
];

const stripQuotes = (value) => {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const parseEnvFile = (filePath) => {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, "utf8");
  const entries = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalizedLine.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const value = stripQuotes(normalizedLine.slice(separatorIndex + 1));

    if (!key || value === "") {
      continue;
    }

    entries[key] = value;
  }

  return entries;
};

const parseArgs = (argv) => {
  const options = {
    profile: "preprod",
    envFiles: [],
    outputDir: resolve(sandboxRoot, "reports"),
    smartVmProbe: true,
    sendSms: false,
    failOnBlocker: true,
    printJson: false
  };

  const readValue = (index, key) => {
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      throw new Error(`参数 ${key} 需要提供值。`);
    }

    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (!rawArg.startsWith("--")) {
      throw new Error(`无法识别的参数：${rawArg}`);
    }

    const [rawKey, inlineValue] = rawArg.slice(2).split("=", 2);
    const key = rawKey.trim();
    const value = inlineValue ?? undefined;

    if (key === "send-sms") {
      options.sendSms = true;
      continue;
    }

    if (key === "skip-smartvm-probe") {
      options.smartVmProbe = false;
      continue;
    }

    if (key === "no-fail") {
      options.failOnBlocker = false;
      continue;
    }

    if (key === "json") {
      options.printJson = true;
      continue;
    }

    const resolvedValue = value ?? readValue(index, key);

    if (value === undefined) {
      index += 1;
    }

    if (key === "profile") {
      options.profile = resolvedValue;
    } else if (key === "env-file") {
      options.envFiles.push(resolve(process.cwd(), resolvedValue));
    } else if (key === "api-base-url" || key === "target-url") {
      options.apiBaseUrl = resolvedValue;
    } else if (key === "device-code") {
      options.deviceCode = resolvedValue;
    } else if (key === "door-num") {
      options.doorNum = resolvedValue;
    } else if (key === "sms-phone") {
      options.smsPhone = resolvedValue;
    } else if (key === "output-dir") {
      options.outputDir = resolve(process.cwd(), resolvedValue);
    } else {
      throw new Error(`无法识别的参数：--${key}`);
    }
  }

  if (!["preprod", "production"].includes(options.profile)) {
    throw new Error("--profile 只能设置为 preprod 或 production。");
  }

  return options;
};

const buildConfig = (options) => {
  const envFileCandidates = [
    resolve(repoRoot, "apps/api/.env.example"),
    resolve(sandboxRoot, ".env.example"),
    resolve(repoRoot, "apps/api/.env"),
    resolve(repoRoot, "apps/api/.env.local"),
    resolve(sandboxRoot, ".env"),
    resolve(sandboxRoot, ".env.local"),
    ...options.envFiles
  ];
  const loadedFiles = [];
  const fileConfig = {};

  for (const filePath of envFileCandidates) {
    if (!existsSync(filePath)) {
      continue;
    }

    Object.assign(fileConfig, parseEnvFile(filePath));
    loadedFiles.push(filePath);
  }

  const config = {
    ...fileConfig,
    ...process.env
  };

  for (const [key, value] of Object.entries(fileConfig)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    config,
    loadedFiles
  };
};

const readConfig = (config, key) => {
  const value = config[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const isTruthy = (value) => truthyValues.has(value?.trim().toLowerCase() ?? "");
const normalizePem = (value) => value?.replace(/\\n/g, "\n");

const isLocalHostname = (hostname) => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(normalized)) {
    return true;
  }

  if (normalized.startsWith("127.") || normalized.startsWith("10.") || normalized.startsWith("192.168.")) {
    return true;
  }

  const match172 = normalized.match(/^172\.(\d+)\./);
  return Boolean(match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31);
};

const parseUrl = (value, key) => {
  try {
    return {
      ok: true,
      url: new URL(value)
    };
  } catch {
    return {
      ok: false,
      message: `${key} 不是有效 URL。`
    };
  }
};

const validatePublicHttpsUrl = (value, key) => {
  if (!value) {
    return {
      ok: false,
      message: `缺少 ${key}。`
    };
  }

  const parsed = parseUrl(value, key);

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.url.protocol !== "https:") {
    return {
      ok: false,
      message: `${key} 必须使用 HTTPS。`
    };
  }

  if (isLocalHostname(parsed.url.hostname)) {
    return {
      ok: false,
      message: `${key} 不能指向本机或内网地址。`
    };
  }

  return {
    ok: true,
    url: parsed.url
  };
};

const validateExternalUrl = (value, key) => {
  if (!value) {
    return {
      ok: false,
      message: `缺少 ${key}。`
    };
  }

  const parsed = parseUrl(value, key);

  if (!parsed.ok) {
    return parsed;
  }

  if (isLocalHostname(parsed.url.hostname)) {
    return {
      ok: false,
      message: `${key} 不能指向本机或内网地址。`
    };
  }

  return {
    ok: true,
    url: parsed.url
  };
};

const makeCheck = (status, name, summary, details = [], metadata = undefined) => ({
  status,
  name,
  summary,
  details,
  metadata
});

const pass = (name, summary, details = [], metadata = undefined) =>
  makeCheck("pass", name, summary, details, metadata);
const warn = (name, summary, details = [], metadata = undefined) =>
  makeCheck("warn", name, summary, details, metadata);
const fail = (name, summary, details = [], metadata = undefined) =>
  makeCheck("fail", name, summary, details, metadata);
const skip = (name, summary, details = [], metadata = undefined) =>
  makeCheck("skip", name, summary, details, metadata);

const createSection = (name, description, checks) => ({
  name,
  description,
  status: checks.reduce(
    (current, check) => (statusRank[check.status] > statusRank[current] ? check.status : current),
    "pass"
  ),
  checks
});

const resolvePaymentModeSetting = (config) => {
  const paymentModeRaw = readConfig(config, "PAYMENT_MODE")?.toLowerCase();

  if (paymentModeRaw) {
    if (["auto", "mock", "real", "disabled"].includes(paymentModeRaw)) {
      return {
        ok: true,
        mode: paymentModeRaw,
        source: "PAYMENT_MODE",
        paymentModeRaw
      };
    }

    return {
      ok: false,
      message: "PAYMENT_MODE 只能设置为 auto、mock、real 或 disabled。"
    };
  }

  const legacyPaymentMockEnabled = readConfig(config, "PAYMENT_MOCK_ENABLED")?.toLowerCase();

  if (legacyPaymentMockEnabled && truthyValues.has(legacyPaymentMockEnabled)) {
    return {
      ok: true,
      mode: "mock",
      source: "PAYMENT_MOCK_ENABLED",
      legacyPaymentMockEnabled
    };
  }

  if (legacyPaymentMockEnabled && falseyValues.has(legacyPaymentMockEnabled)) {
    return {
      ok: true,
      mode: "real",
      source: "PAYMENT_MOCK_ENABLED",
      legacyPaymentMockEnabled
    };
  }

  if (legacyPaymentMockEnabled) {
    return {
      ok: false,
      message: "PAYMENT_MOCK_ENABLED 只能设置为 true、false 或留空。"
    };
  }

  return {
    ok: true,
    mode: "auto",
    source: "default"
  };
};

const resolveNotifyUrl = (config, settingKey, fallbackPath) => {
  const configured = readConfig(config, settingKey);

  if (configured) {
    return configured;
  }

  const publicBaseUrl = readConfig(config, "PUBLIC_BASE_URL");

  if (!publicBaseUrl) {
    return undefined;
  }

  return new URL(fallbackPath, publicBaseUrl).toString();
};

const normalizeApiBaseUrl = (rawValue) => {
  if (!rawValue) {
    return undefined;
  }

  const parsed = new URL(rawValue);
  const pathname = parsed.pathname.replace(/\/+$/, "");

  if (!pathname.endsWith("/api")) {
    parsed.pathname = `${pathname}/api`;
  }

  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

const joinUrl = (baseUrl, path) => `${baseUrl.replace(/\/+$/, "")}${path}`;

const fetchWithTimeout = async (url, options = {}) => {
  const { timeoutMs = 10000, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...requestOptions,
      signal: controller.signal
    });
    const raw = await response.text();
    let json;

    try {
      json = raw ? JSON.parse(raw) : undefined;
    } catch {
      json = undefined;
    }

    return {
      ok: response.ok,
      status: response.status,
      raw,
      json
    };
  } finally {
    clearTimeout(timer);
  }
};

const unwrapEnvelope = (payload) => {
  if (payload && typeof payload === "object" && "data" in payload) {
    return payload.data;
  }

  return payload;
};

const extractErrorMessage = (error) => {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "请求超时。" : error.message;
  }

  return String(error);
};

const summarizeJsonPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const data = payload.data;

  return {
    code: payload.code,
    message: payload.message,
    dataCount: Array.isArray(data) ? data.length : undefined,
    dataPreview: Array.isArray(data) ? data.slice(0, 3) : undefined
  };
};

const maskSignedSmartVmPayload = (payload) => ({
  ...payload,
  clientId: typeof payload.clientId === "string"
    ? `${payload.clientId.slice(0, 4)}***${payload.clientId.slice(-2)}`
    : payload.clientId,
  sign: payload.sign ? "***" : undefined
});

const validateKeyPresence = (config, keys) => keys.filter((key) => !readConfig(config, key));

const validatePrivateKey = (config, key, label) => {
  const value = readConfig(config, key);

  if (!value) {
    return fail(label, `缺少 ${key}。`);
  }

  try {
    createPrivateKey(normalizePem(value));
    return pass(label, `${key} 格式可被 Node 解析。`);
  } catch (error) {
    return fail(label, `${key} 不是可用私钥格式。`, [extractErrorMessage(error)]);
  }
};

const validatePublicKey = (config, key, label) => {
  const value = readConfig(config, key);

  if (!value) {
    return fail(label, `缺少 ${key}。`);
  }

  try {
    createPublicKey(normalizePem(value));
    return pass(label, `${key} 格式可被 Node 解析。`);
  } catch (error) {
    return fail(label, `${key} 不是可用公钥格式。`, [extractErrorMessage(error)]);
  }
};

const buildOfflinePaymentDiagnostics = (config) => {
  const setting = resolvePaymentModeSetting(config);

  if (!setting.ok) {
    return {
      ok: false,
      message: setting.message
    };
  }

  const providers = paymentProviders.map((providerConfig) => {
    const missingRequiredKeys =
      setting.mode === "disabled"
        ? []
        : validateKeyPresence(config, providerConfig.requiredKeys);

    if (
      setting.mode !== "disabled" &&
      providerConfig.provider === "wechat" &&
      !readConfig(config, "WECHAT_MINI_APP_SECRET")
    ) {
      missingRequiredKeys.push("WECHAT_MINI_APP_SECRET");
    }

    if (
      setting.mode !== "disabled" &&
      !readConfig(config, providerConfig.notifyKey) &&
      !readConfig(config, "PUBLIC_BASE_URL")
    ) {
      missingRequiredKeys.push(`${providerConfig.notifyKey} 或 PUBLIC_BASE_URL`);
    }

    const readyForRealPayment =
      setting.mode !== "disabled" && missingRequiredKeys.length === 0;
    let effectiveMode = "real";
    const warnings = [];
    const blockers = [];
    let simulatedReason;

    if (setting.mode === "disabled") {
      effectiveMode = "disabled";
    } else if (setting.mode === "mock") {
      effectiveMode = "mock";
      simulatedReason = "支付运行模式为强制模拟，本渠道不会发起真实扣款。";
    } else if (setting.mode === "auto" && !readyForRealPayment) {
      effectiveMode = "mock";
      simulatedReason = `${providerConfig.label}真实支付自检未通过，自动模式下会使用本地模拟支付。`;
    } else if (setting.mode === "real" && !readyForRealPayment) {
      blockers.push(`严格真实支付缺少配置：${missingRequiredKeys.join("、")}。`);
    }

    if (setting.mode === "auto" && readyForRealPayment) {
      warnings.push("配置自检通过；但前端未拿到付款人身份时，自动模式仍会回落到模拟支付。");
    }

    return {
      provider: providerConfig.provider,
      label: providerConfig.label,
      requestedMode: setting.mode,
      effectiveMode,
      readyForRealPayment,
      forcedReal: setting.mode === "real",
      mockPaymentEnabled: effectiveMode === "mock",
      missingRequiredKeys,
      blockers,
      warnings,
      simulatedReason
    };
  });
  const effectiveModes = new Set(providers.map((provider) => provider.effectiveMode));
  const warnings = [];

  if (setting.mode === "auto") {
    warnings.push("当前为自动模式：商户配置或付款人身份不完整时，订单会进入本地模拟支付。");
  }

  if (providers.some((provider) => provider.effectiveMode === "mock")) {
    warnings.push("存在模拟支付通道：模拟订单不会调用微信或支付宝真实扣款。");
  }

  if (setting.source === "PAYMENT_MOCK_ENABLED") {
    warnings.push("当前使用旧版 PAYMENT_MOCK_ENABLED 推导支付模式；建议改用 PAYMENT_MODE=auto、mock 或 real。");
  }

  return {
    ok: true,
    diagnostics: {
      generatedAt: new Date().toISOString(),
      requestedMode: setting.mode,
      requestedModeSource: setting.source,
      paymentModeRaw: setting.paymentModeRaw,
      legacyPaymentMockEnabled: setting.legacyPaymentMockEnabled,
      summary: {
        effectiveMode: effectiveModes.size === 1 ? [...effectiveModes][0] : "mixed",
        allProvidersReadyForReal: providers.every((provider) => provider.readyForRealPayment),
        strictRealEnabled: setting.mode === "real",
        mockPaymentEndpointEnabled: providers.some((provider) => provider.mockPaymentEnabled)
      },
      providers,
      warnings
    }
  };
};

const checkProductionSafety = (config, options) => {
  const checks = [];
  const publicBaseUrl = readConfig(config, "PUBLIC_BASE_URL");
  const publicBaseValidation = validatePublicHttpsUrl(publicBaseUrl, "PUBLIC_BASE_URL");

  checks.push(
    publicBaseValidation.ok
      ? pass("公网基础地址", "PUBLIC_BASE_URL 是公网 HTTPS 地址。", [], { publicBaseUrl })
      : fail("公网基础地址", publicBaseValidation.message)
  );

  const corsOrigins = readConfig(config, "CORS_ORIGINS");
  if (!corsOrigins) {
    checks.push(fail("CORS 来源", "缺少 CORS_ORIGINS。"));
  } else {
    const origins = corsOrigins.split(",").map((entry) => entry.trim()).filter(Boolean);
    const invalidOrigins = [];

    for (const origin of origins) {
      if (origin === "*") {
        invalidOrigins.push("不能使用 *");
        continue;
      }

      const validation = validatePublicHttpsUrl(origin, "CORS_ORIGINS");
      if (!validation.ok) {
        invalidOrigins.push(`${origin}: ${validation.message}`);
      }
    }

    checks.push(
      invalidOrigins.length
        ? fail("CORS 来源", "存在不符合公网发布要求的 CORS_ORIGINS。", invalidOrigins)
        : pass("CORS 来源", "CORS_ORIGINS 均为公网 HTTPS 来源。", origins)
    );
  }

  const nodeEnv = readConfig(config, "NODE_ENV");
  const appEnv = readConfig(config, "APP_ENV");
  const productionRuntime = [nodeEnv, appEnv].some((value) => value?.toLowerCase() === "production");
  if (options.profile === "production") {
    checks.push(
      productionRuntime
        ? pass("生产运行模式", "NODE_ENV 或 APP_ENV 已声明为 production。", [`NODE_ENV=${nodeEnv ?? ""}`, `APP_ENV=${appEnv ?? ""}`])
        : fail("生产运行模式", "正式公网发布必须设置 NODE_ENV=production 或 APP_ENV=production。")
    );
  } else {
    checks.push(
      productionRuntime
        ? warn("预发布运行模式", "当前配置已声明 production；请确认这不是预发布误连生产环境。")
        : pass("预发布运行模式", "当前未声明 production，符合预发布默认模式。")
    );
  }

  const verificationProvider = readConfig(config, "VERIFICATION_CODE_PROVIDER");
  checks.push(
    verificationProvider === "aliyun_pnvs"
      ? pass("验证码供应商", "VERIFICATION_CODE_PROVIDER=aliyun_pnvs。")
      : verificationProvider === "manual"
        ? pass("验证码供应商", "仅接受后台签发的一次性人工验证码。")
        : fail("验证码供应商", "公网或预发布必须使用 PNVS 或后台签发的一次性人工验证码。", [
            `当前 VERIFICATION_CODE_PROVIDER=${verificationProvider ?? "(未设置)"}`
          ])
  );

  const previewEnabled = isTruthy(readConfig(config, "VERIFICATION_CODE_PREVIEW_ENABLED"));
  checks.push(
    previewEnabled
      ? fail("验证码预览", "公网或预发布不能开启验证码预览。")
      : pass("验证码预览", "验证码预览已关闭。")
  );

  const smartVmMissing = validateKeyPresence(config, ["SMARTVM_BASE_URL", "SMARTVM_CLIENT_ID", "SMARTVM_KEY"]);
  checks.push(
    smartVmMissing.length
      ? fail("SmartVM 必填配置", "缺少 SmartVM 接入配置。", smartVmMissing)
      : pass("SmartVM 必填配置", "SmartVM 基础接入配置已填写。")
  );

  const unsignedCallbacksEnabled =
    isTruthy(readConfig(config, "SMARTVM_ALLOW_UNSIGNED_CALLBACKS")) ||
    isTruthy(readConfig(config, "ALLOW_UNSIGNED_SMARTVM_CALLBACKS"));
  checks.push(
    unsignedCallbacksEnabled
      ? fail("SmartVM 回调签名", "公网或预发布不能允许未签名 SmartVM 回调。")
      : pass("SmartVM 回调签名", "未签名 SmartVM 回调已关闭。")
  );

  const paymentMode = resolvePaymentModeSetting(config);
  const reservationOnly = isTruthy(
    readConfig(config, "VM_RESERVATION_ONLY_PICKUP")
  );
  if (!paymentMode.ok) {
    checks.push(fail("支付运行模式", paymentMode.message));
  } else {
    checks.push(
      paymentMode.mode === "real"
        ? pass("支付运行模式", `支付运行模式为严格真实（来源 ${paymentMode.source}）。`)
        : paymentMode.mode === "disabled" && reservationOnly
          ? pass("支付运行模式", "预约取货已关闭新支付链路。")
          : fail("支付运行模式", "即时领取要求真实支付；关闭支付只允许用于预约取货。", [
              `当前模式=${paymentMode.mode}`,
              `来源=${paymentMode.source}`
            ])
    );
  }

  const defaultLoginAllowed = isTruthy(readConfig(config, "ALLOW_DEFAULT_BACKOFFICE_LOGIN"));
  checks.push(
    defaultLoginAllowed
      ? fail("默认后台密码登录", "公网或预发布不能允许默认后台密码登录。")
      : pass("默认后台密码登录", "默认后台密码登录已关闭。")
  );

  return createSection("生产环境安全门禁", "复用现有生产安全检查的公网配置约束。", checks);
};

const checkApiSurface = async (config, options) => {
  const checks = [];
  const rawApiBaseUrl = options.apiBaseUrl ?? readConfig(config, "PUBLIC_BASE_URL");
  let apiBaseUrl;

  try {
    apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl);
  } catch (error) {
    return createSection("公网 API", "确认公网 API 地址可达且受保护接口没有裸露。", [
      fail("API 地址", "无法解析 API 地址。", [extractErrorMessage(error)])
    ]);
  }

  if (!apiBaseUrl) {
    return createSection("公网 API", "确认公网 API 地址可达且受保护接口没有裸露。", [
      skip("API 地址", "未提供 --api-base-url，且 PUBLIC_BASE_URL 为空。")
    ]);
  }

  const apiUrlValidation = validatePublicHttpsUrl(apiBaseUrl, "API_BASE_URL");
  checks.push(
    apiUrlValidation.ok
      ? pass("API 地址", "API 地址是公网 HTTPS 地址。", [], { apiBaseUrl })
      : fail("API 地址", apiUrlValidation.message, [], { apiBaseUrl })
  );

  try {
    const health = await fetchWithTimeout(joinUrl(apiBaseUrl, "/health"));
    const healthPayload = unwrapEnvelope(health.json);

    checks.push(
      health.status === 200
        ? pass("健康检查", "公网 /api/health 可访问。", [], {
            status: health.status,
            payload: healthPayload
          })
        : fail("健康检查", `公网 /api/health 返回 HTTP ${health.status}。`, [
            health.raw.slice(0, 300)
          ])
    );
  } catch (error) {
    checks.push(fail("健康检查", "公网 /api/health 请求失败。", [extractErrorMessage(error)]));
  }

  try {
    const unauthenticatedDiagnostics = await fetchWithTimeout(joinUrl(apiBaseUrl, "/payments/diagnostics"));

    checks.push(
      unauthenticatedDiagnostics.status === 401 || unauthenticatedDiagnostics.status === 403
        ? pass("支付自检权限", "未登录访问 /payments/diagnostics 会被拒绝。", [
            `HTTP ${unauthenticatedDiagnostics.status}`
          ])
        : fail("支付自检权限", "未登录不应直接读取支付自检。", [
            `HTTP ${unauthenticatedDiagnostics.status}`,
            unauthenticatedDiagnostics.raw.slice(0, 300)
          ])
    );
  } catch (error) {
    checks.push(warn("支付自检权限", "无法确认未登录访问保护。", [extractErrorMessage(error)]));
  }

  const token = readConfig(config, "SANDBOX_ADMIN_TOKEN");

  if (token) {

    try {
      const diagnostics = await fetchWithTimeout(joinUrl(apiBaseUrl, "/payments/diagnostics"), {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const payload = unwrapEnvelope(diagnostics.json);

      checks.push(
        diagnostics.status === 200 && payload?.summary
          ? pass("线上支付自检接口", "已从公网 API 读取支付自检。", [], {
              diagnostics: payload
            })
          : fail("线上支付自检接口", `读取公网支付自检失败：HTTP ${diagnostics.status}。`, [
              diagnostics.raw.slice(0, 300)
            ])
      );
    } catch (error) {
      checks.push(fail("线上支付自检接口", "读取公网支付自检失败。", [extractErrorMessage(error)]));
    }
  } else {
    checks.push(skip("线上支付自检接口", "未通过环境配置提供 SANDBOX_ADMIN_TOKEN，跳过公网支付自检接口读取。"));
  }

  return createSection("公网 API", "确认公网 API 地址可达且受保护接口没有裸露。", checks);
};

const checkSmartVm = async (config, options) => {
  const checks = [];
  const baseUrl = readConfig(config, "SMARTVM_BASE_URL");
  const clientId = readConfig(config, "SMARTVM_CLIENT_ID");
  const key = readConfig(config, "SMARTVM_KEY");
  const baseUrlValidation = validateExternalUrl(baseUrl, "SMARTVM_BASE_URL");

  checks.push(
    baseUrlValidation.ok
      ? pass("SmartVM 地址", "SMARTVM_BASE_URL 是外部地址。", [
          baseUrlValidation.url.protocol === "https:" ? "上游使用 HTTPS。" : "上游未使用 HTTPS；测试平台如只提供 HTTP，可保留。"
        ], { baseUrl })
      : fail("SmartVM 地址", baseUrlValidation.message)
  );

  const missing = validateKeyPresence(config, ["SMARTVM_CLIENT_ID", "SMARTVM_KEY"]);
  const usingDemoCredentials = clientId === "sandbox-demo-client" && key === "sandbox-demo-key";
  checks.push(
    missing.length
      ? fail("SmartVM 签名凭据", "缺少 SmartVM 签名凭据。", missing)
      : usingDemoCredentials
        ? fail("SmartVM 签名凭据", "当前仍在使用 sandbox 演示签名参数，不能请求外部 SmartVM。")
        : pass("SmartVM 签名凭据", "SmartVM 签名凭据已配置，报告不会输出密钥。")
  );

  const unsignedCallbacksEnabled =
    isTruthy(readConfig(config, "SMARTVM_ALLOW_UNSIGNED_CALLBACKS")) ||
    isTruthy(readConfig(config, "ALLOW_UNSIGNED_SMARTVM_CALLBACKS"));
  checks.push(
    unsignedCallbacksEnabled
      ? fail("SmartVM 回调安全", "未签名 SmartVM 回调开关仍开启。")
      : pass("SmartVM 回调安全", "未签名 SmartVM 回调开关已关闭。")
  );

  if (!options.smartVmProbe) {
    checks.push(skip("SmartVM 只读探测", "已通过 --skip-smartvm-probe 跳过真实平台探测。"));
    return createSection("SmartVM", "检查柜机平台外部连接、签名参数和只读接口。", checks);
  }

  const deviceCode =
    options.deviceCode ??
    readConfig(config, "SMARTVM_DEVICE_CODE") ??
    readConfig(config, "SMARTVM_TEST_DEVICE_CODE");
  const doorNum = options.doorNum ?? readConfig(config, "SMARTVM_DOOR_NUM") ?? readConfig(config, "SMARTVM_TEST_DOOR_NUM");

  if (!baseUrlValidation.ok || missing.length || usingDemoCredentials) {
    checks.push(skip("SmartVM 只读探测", "SmartVM 基础配置未通过，跳过平台请求。"));
  } else if (!deviceCode) {
    checks.push(fail("SmartVM 只读探测", "缺少测试柜机编号，无法覆盖 SmartVM 真实只读链路。", [
      "请传入 --device-code，或设置 SMARTVM_DEVICE_CODE / SMARTVM_TEST_DEVICE_CODE。"
    ]));
  } else {
    try {
      const { withSignature } = await import("./helpers.mjs");
      const requestBody = {
        deviceCode,
        ...(doorNum ? { doorNum } : {})
      };
      const signedPayload = withSignature(requestBody);
      const response = await fetchWithTimeout(
        joinUrl(baseUrl, "/api/pay/container/getCabinetGoodsInfo"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(signedPayload),
          timeoutMs: 12000
        }
      );
      const bodyCode = response.json?.code;
      const smartVmOk = response.status === 200 && (bodyCode === 200 || bodyCode === "200");

      checks.push(
        smartVmOk
          ? pass("SmartVM 商品只读接口", "SmartVM 商品查询成功，签名和柜机编号可用。", [], {
              request: maskSignedSmartVmPayload(signedPayload),
              response: summarizeJsonPayload(response.json)
            })
          : fail("SmartVM 商品只读接口", `SmartVM 商品查询失败：HTTP ${response.status}。`, [
              response.raw.slice(0, 500)
            ], {
              request: maskSignedSmartVmPayload(signedPayload),
              response: summarizeJsonPayload(response.json)
            })
      );
    } catch (error) {
      checks.push(fail("SmartVM 商品只读接口", "SmartVM 商品查询请求失败。", [extractErrorMessage(error)]));
    }
  }

  return createSection("SmartVM", "检查柜机平台外部连接、签名参数和只读接口。", checks);
};

const checkSms = async (config, options) => {
  const checks = [];
  const provider = readConfig(config, "VERIFICATION_CODE_PROVIDER");
  const previewEnabled = isTruthy(readConfig(config, "VERIFICATION_CODE_PREVIEW_ENABLED"));
  const regionId = readConfig(config, "ALIYUN_PNVS_REGION_ID") ?? "cn-hangzhou";
  const endpoint = readConfig(config, "ALIYUN_PNVS_ENDPOINT") ?? "dypnsapi.aliyuncs.com";

  checks.push(
    previewEnabled
      ? fail("短信验证码预览", "验证码预览仍开启，公网响应可能泄露验证码。")
      : pass("短信验证码预览", "验证码预览已关闭。")
  );

  if (provider === "manual") {
    checks.unshift(
      pass(
        "人工验证码供应商",
        "当前仅接受后台签发、短期有效且单次消费的人工验证码。"
      )
    );
    checks.push(
      options.sendSms
        ? fail("真实短信发送", "人工验证码模式不发送短信，不能使用 --send-sms。")
        : skip("真实短信发送", "人工验证码模式无需配置或发送短信。")
    );
    return createSection(
      "登录验证",
      "检查后台签发的一次性人工验证码模式。",
      checks
    );
  }

  checks.unshift(
    provider === "aliyun_pnvs"
      ? pass("短信验证码供应商", "验证码供应商已切到阿里云 PNVS。")
      : fail("短信验证码供应商", "外部服务预检要求 VERIFICATION_CODE_PROVIDER=aliyun_pnvs 或 manual。", [
          `当前=${provider ?? "(未设置)"}`
        ])
  );

  const missing = validateKeyPresence(config, aliyunPnvsRequiredVerificationKeys);

  checks.push(
    missing.length
      ? fail("阿里云 PNVS 配置", "缺少阿里云 PNVS 验证码配置。", missing)
      : pass("阿里云 PNVS 配置", "阿里云 PNVS 验证码配置已填写，报告不会输出密钥。", [
          `region=${regionId}`,
          `endpoint=${endpoint}`
        ])
  );

  if (!options.sendSms) {
    checks.push(
      skip(
        "真实短信发送",
        "默认不发送真实短信；需要端到端验证时追加 --send-sms --sms-phone <手机号>。"
      )
    );
    return createSection("短信验证码", "检查阿里云 PNVS 配置，可选执行一次真实发送。", checks);
  }

  if (!options.smsPhone) {
    checks.push(fail("真实短信发送", "已启用 --send-sms，但缺少 --sms-phone。"));
  } else if (missing.length || provider !== "aliyun_pnvs") {
    checks.push(skip("真实短信发送", "短信基础配置未通过，跳过真实发送。"));
  } else {
    const sandboxSchemeName = readConfig(config, "SANDBOX_PNVS_SCHEME_NAME");

    if (!sandboxSchemeName) {
      checks.push(
        fail(
          "真实短信发送",
          "缺少 SANDBOX_PNVS_SCHEME_NAME；sandbox 真实发送必须显式指定独立 PNVS Scheme。"
        )
      );
      return createSection("短信验证码", "检查阿里云 PNVS 配置，可选执行一次真实发送。", checks);
    }

    try {
      const { requestPhoneCode } = await import("./aliyun-phone-code.mjs");
      const result = await requestPhoneCode(options.smsPhone);

      checks.push(
        result.success
          ? pass("真实短信发送", "阿里云 PNVS 短信验证码发送成功。", [], result)
          : fail("真实短信发送", "阿里云 PNVS 短信验证码发送返回失败。", [], result)
      );
    } catch (error) {
      checks.push(fail("真实短信发送", "阿里云 PNVS 短信验证码发送失败。", [extractErrorMessage(error)]));
    }
  }

  return createSection("短信验证码", "检查阿里云 PNVS 配置，可选执行一次真实发送。", checks);
};

const checkPayment = async (config) => {
  const checks = [];
  const offlineDiagnostics = buildOfflinePaymentDiagnostics(config);

  if (!offlineDiagnostics.ok) {
    checks.push(fail("支付自检规则", offlineDiagnostics.message));
    return createSection("真实支付配置", "按现有支付自检规则校验微信和支付宝真实支付配置。", checks);
  }

  const diagnostics = offlineDiagnostics.diagnostics;
  const reservationOnly = isTruthy(
    readConfig(config, "VM_RESERVATION_ONLY_PICKUP")
  );

  if (diagnostics.requestedMode === "disabled") {
    checks.push(
      reservationOnly
        ? pass(
            "支付运行模式",
            "预约取货已显式关闭新支付链路，无需填写微信或支付宝商户配置。"
          )
        : fail(
            "支付运行模式",
            "PAYMENT_MODE=disabled 只允许用于预约取货模式。"
          )
    );
    checks.push(
      skip(
        "支付渠道外部预检",
        "当前不创建支付单，跳过微信与支付宝密钥、回调和连通性检查。"
      )
    );
    return createSection(
      "支付配置",
      "预约取货关闭支付时，仅验证关闭条件。",
      checks
    );
  }

  checks.push(
    diagnostics.summary.strictRealEnabled
      ? pass("支付运行模式", "PAYMENT_MODE=real，严格真实支付已开启。")
      : fail("支付运行模式", "真实支付配置预检要求 PAYMENT_MODE=real。", [
          `当前模式=${diagnostics.requestedMode}`,
          `来源=${diagnostics.requestedModeSource}`
        ])
  );

  for (const provider of diagnostics.providers) {
    checks.push(
      provider.readyForRealPayment
        ? pass(`${provider.label}必填项`, `${provider.label}真实支付必填配置完整。`)
        : fail(`${provider.label}必填项`, `${provider.label}真实支付配置不完整。`, provider.missingRequiredKeys)
    );

    for (const blocker of provider.blockers) {
      checks.push(fail(`${provider.label}阻断项`, blocker));
    }

    for (const warningMessage of provider.warnings) {
      checks.push(warn(`${provider.label}提醒`, warningMessage));
    }
  }

  for (const providerConfig of paymentProviders) {
    const notifyUrl = resolveNotifyUrl(config, providerConfig.notifyKey, providerConfig.fallbackPath);
    const validation = validatePublicHttpsUrl(notifyUrl, providerConfig.notifyKey);

    checks.push(
      validation.ok
        ? pass(`${providerConfig.label}回调地址`, `${providerConfig.label}支付回调地址是公网 HTTPS。`, [], {
            notifyUrl
          })
        : fail(`${providerConfig.label}回调地址`, validation.message)
    );
  }

  const refundNotifyUrl = readConfig(config, "WECHAT_PAY_REFUND_NOTIFY_URL")
    ? resolveNotifyUrl(config, "WECHAT_PAY_REFUND_NOTIFY_URL", "/api/payments/callbacks/wechat-refund")
    : undefined;
  if (refundNotifyUrl) {
    const validation = validatePublicHttpsUrl(refundNotifyUrl, "WECHAT_PAY_REFUND_NOTIFY_URL");
    checks.push(
      validation.ok
        ? pass("微信退款回调地址", "微信退款回调地址是公网 HTTPS。", [], { refundNotifyUrl })
        : fail("微信退款回调地址", validation.message)
    );
  } else {
    checks.push(warn("微信退款回调地址", "未单独配置 WECHAT_PAY_REFUND_NOTIFY_URL；退款时会回退使用 PUBLIC_BASE_URL 拼接。"));
  }

  const wechatApiV3Key = readConfig(config, "WECHAT_PAY_API_V3_KEY");
  if (wechatApiV3Key) {
    checks.push(
      Buffer.byteLength(wechatApiV3Key, "utf8") === 32
        ? pass("微信 API v3 Key", "WECHAT_PAY_API_V3_KEY 长度符合 32 字节要求。")
        : fail("微信 API v3 Key", "WECHAT_PAY_API_V3_KEY 必须是 32 字节。")
    );
  }

  checks.push(validatePrivateKey(config, "WECHAT_PAY_MERCHANT_PRIVATE_KEY", "微信商户私钥"));
  checks.push(validatePublicKey(config, "WECHAT_PAY_PLATFORM_PUBLIC_KEY", "微信平台公钥"));
  checks.push(validatePrivateKey(config, "ALIPAY_APP_PRIVATE_KEY", "支付宝应用私钥"));
  checks.push(validatePublicKey(config, "ALIPAY_PUBLIC_KEY", "支付宝公钥"));

  const optionalExternalUrls = [
    ["WECHAT_PAY_API_BASE_URL", readConfig(config, "WECHAT_PAY_API_BASE_URL")],
    ["ALIPAY_GATEWAY_URL", readConfig(config, "ALIPAY_GATEWAY_URL")]
  ];

  for (const [key, value] of optionalExternalUrls) {
    if (!value) {
      checks.push(pass(key, `${key} 未配置，业务代码会使用默认官方地址。`));
      continue;
    }

    const validation = validatePublicHttpsUrl(value, key);
    checks.push(
      validation.ok
        ? pass(key, `${key} 是公网 HTTPS 地址。`)
        : fail(key, validation.message)
    );
  }

  for (const warningMessage of diagnostics.warnings) {
    checks.push(warn("支付自检提醒", warningMessage));
  }

  return createSection("真实支付配置", "按现有支付自检规则校验微信和支付宝真实支付配置。", checks);
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const renderMetadata = (metadata) => {
  if (metadata === undefined) {
    return "";
  }

  return `<pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>`;
};

const renderHtmlReport = (report) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #172033;
      --muted: #667085;
      --line: #d8dde8;
      --pass: #197447;
      --pass-bg: #eaf7ef;
      --warn: #915b00;
      --warn-bg: #fff5d7;
      --fail: #b42318;
      --fail-bg: #fff0ee;
      --skip: #475467;
      --skip-bg: #eef2f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    header { display: grid; gap: 12px; margin-bottom: 18px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 1.7rem; }
    h2 { font-size: 1.1rem; }
    h3 { font-size: 0.98rem; }
    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .metric, .section, .check {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .metric { padding: 12px; min-width: 0; }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 0.82rem;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 1.05rem;
      word-break: break-word;
    }
    .sections { display: grid; gap: 14px; }
    .section { display: grid; gap: 10px; padding: 14px; }
    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .section-desc { color: var(--muted); font-size: 0.9rem; }
    .checks { display: grid; gap: 8px; }
    .check { display: grid; gap: 6px; padding: 12px; }
    .check-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .badge {
      flex: 0 0 auto;
      min-width: 54px;
      padding: 2px 8px;
      border-radius: 999px;
      text-align: center;
      font-weight: 800;
      font-size: 0.78rem;
    }
    .status-pass { color: var(--pass); background: var(--pass-bg); }
    .status-warn { color: var(--warn); background: var(--warn-bg); }
    .status-fail { color: var(--fail); background: var(--fail-bg); }
    .status-skip { color: var(--skip); background: var(--skip-bg); }
    ul { margin: 0; padding-left: 18px; color: var(--muted); }
    pre {
      max-height: 340px;
      overflow: auto;
      margin: 0;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #101828;
      color: #f8fafc;
      font-size: 0.78rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    code { font-family: "SFMono-Regular", Consolas, monospace; }
    @media (max-width: 820px) {
      .summary { grid-template-columns: 1fr; }
      .section-head, .check-title { display: grid; }
      .badge { justify-self: start; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(report.title)}</h1>
      <p class="section-desc">生成时间：${escapeHtml(report.generatedAt)}；配置档位：${escapeHtml(report.profile)}；整体结果：${escapeHtml(statusLabels[report.status])}</p>
      <div class="summary">
        <div class="metric"><span>整体</span><strong>${escapeHtml(statusLabels[report.status])}</strong></div>
        <div class="metric"><span>失败</span><strong>${report.summary.fail}</strong></div>
        <div class="metric"><span>警告</span><strong>${report.summary.warn}</strong></div>
        <div class="metric"><span>跳过</span><strong>${report.summary.skip}</strong></div>
        <div class="metric"><span>通过</span><strong>${report.summary.pass}</strong></div>
      </div>
    </header>
    <section class="sections">
      ${report.sections.map((section) => `
        <article class="section">
          <div class="section-head">
            <div>
              <h2>${escapeHtml(section.name)}</h2>
              <p class="section-desc">${escapeHtml(section.description)}</p>
            </div>
            <span class="badge status-${section.status}">${escapeHtml(statusLabels[section.status])}</span>
          </div>
          <div class="checks">
            ${section.checks.map((check) => `
              <section class="check">
                <div class="check-title">
                  <h3>${escapeHtml(check.name)}</h3>
                  <span class="badge status-${check.status}">${escapeHtml(statusLabels[check.status])}</span>
                </div>
                <p>${escapeHtml(check.summary)}</p>
                ${check.details?.length ? `<ul>${check.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : ""}
                ${renderMetadata(check.metadata)}
              </section>
            `).join("")}
          </div>
        </article>
      `).join("")}
    </section>
  </main>
</body>
</html>
`;

const summarizeReport = (sections) => {
  const summary = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0
  };

  for (const section of sections) {
    for (const check of section.checks) {
      summary[check.status] += 1;
    }
  }

  const status = sections.reduce(
    (current, section) => (statusRank[section.status] > statusRank[current] ? section.status : current),
    "pass"
  );

  return {
    status,
    summary
  };
};

const writeReports = (report, outputDir) => {
  mkdirSync(outputDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const baseName = `external-service-preflight-${timestamp}`;
  const jsonPath = resolve(outputDir, `${baseName}.json`);
  const htmlPath = resolve(outputDir, `${baseName}.html`);

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(htmlPath, renderHtmlReport(report), "utf8");

  return {
    jsonPath,
    htmlPath
  };
};

const printReportSummary = (report, paths) => {
  console.log(`公网/预发布外部服务预检：${statusLabels[report.status]}`);
  console.log(`报告 HTML：${paths.htmlPath}`);
  console.log(`报告 JSON：${paths.jsonPath}`);

  for (const section of report.sections) {
    console.log(`[${statusLabels[section.status]}] ${section.name}`);

    for (const check of section.checks) {
      if (check.status === "pass") {
        continue;
      }

      console.log(`  - [${statusLabels[check.status]}] ${check.name}: ${check.summary}`);
    }
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const { config, loadedFiles } = buildConfig(options);
  const generatedAt = new Date().toISOString();
  const sections = [
    checkProductionSafety(config, options),
    await checkApiSurface(config, options),
    await checkSmartVm(config, options),
    await checkSms(config, options),
    await checkPayment(config, options)
  ];
  const { status, summary } = summarizeReport(sections);
  const report = {
    title: "公网/预发布外部服务预检",
    generatedAt,
    profile: options.profile,
    status,
    summary,
    environment: {
      loadedEnvFiles: loadedFiles,
      apiBaseUrl: options.apiBaseUrl ?? readConfig(config, "PUBLIC_BASE_URL") ?? "",
      smartVmProbeEnabled: options.smartVmProbe,
      smsSendEnabled: options.sendSms
    },
    sections
  };
  const paths = writeReports(report, options.outputDir);

  if (options.printJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReportSummary(report, paths);
  }

  if (options.failOnBlocker && report.status === "fail") {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(`外部服务预检脚本执行失败：${extractErrorMessage(error)}`);
  process.exitCode = 1;
});
