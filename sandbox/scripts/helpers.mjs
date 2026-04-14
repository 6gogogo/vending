import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sandboxRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sandboxRoot, "..");
const demoSmartVmCredentials = {
  clientId: "sandbox-demo-client",
  key: "sandbox-demo-key"
};

const defaultSandboxConfig = {
  SMARTVM_BASE_URL: "http://pre.smartvm.cn",
  SMARTVM_CLIENT_ID: demoSmartVmCredentials.clientId,
  SMARTVM_KEY: demoSmartVmCredentials.key,
  SMARTVM_DEVICE_CODE: "",
  SMARTVM_DOOR_NUM: "",
  LOCAL_API_BASE_URL: "http://127.0.0.1:4000/api",
  SANDBOX_ADMIN_PHONE: "13800000001",
  SANDBOX_ADMIN_CODE: "123456",
  TEST_PLATFORM_ACCOUNT: "0320@jinsaitest.com",
  TEST_PLATFORM_PASSWORD: "jinsaitest"
};

const envFileCandidates = [
  resolve(repoRoot, "apps/api/.env.example"),
  resolve(repoRoot, "apps/api/.env"),
  resolve(repoRoot, "apps/api/.env.local"),
  resolve(sandboxRoot, ".env.example"),
  resolve(sandboxRoot, ".env"),
  resolve(sandboxRoot, ".env.local")
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

    const separatorIndex = line.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1));

    if (!key) {
      continue;
    }

    if (value === "") {
      continue;
    }

    entries[key] = value;
  }

  return entries;
};

const mergedSandboxConfig = envFileCandidates.reduce(
  (accumulator, filePath) => ({
    ...accumulator,
    ...parseEnvFile(filePath)
  }),
  { ...defaultSandboxConfig }
);

for (const [key, value] of Object.entries(mergedSandboxConfig)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

export const readFixture = async (fixturePath) => {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw);
};

export const createNonce = () => randomUUID().replace(/-/g, "").slice(0, 16);

const normalizeValue = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
};

export const signPayload = (payload, key) => {
  const sorted = Object.entries(payload)
    .map(([entryKey, value]) => [entryKey, normalizeValue(value)])
    .filter((entry) => entry[1] !== undefined)
    .sort((left, right) => left[0].localeCompare(right[0]));

  const stringToSign = sorted.map(([entryKey, value]) => `${entryKey}=${value}`).join("&");
  return createHash("md5")
    .update(`${stringToSign}&key=${key}`)
    .digest("hex")
    .toUpperCase();
};

const getSmartVmCredentials = ({ allowDemoCredentials = false } = {}) => {
  const clientId = process.env.SMARTVM_CLIENT_ID;
  const key = process.env.SMARTVM_KEY;
  const isDemoCredentials =
    clientId === demoSmartVmCredentials.clientId && key === demoSmartVmCredentials.key;

  if (!clientId || !key) {
    throw new Error("必须提供 SMARTVM_CLIENT_ID 和 SMARTVM_KEY。");
  }

  if (!allowDemoCredentials && isDemoCredentials) {
    throw new Error(
      [
        "当前命令正在使用 sandbox 默认演示签名参数。",
        "它只用于让 `npm run sandbox:sign` 这类本地脚本直接可跑，不可直接请求测试平台。",
        "测试平台登录账号密码与 SMARTVM 的 clientId/key 不是同一组信息。",
        "如果你要请求 http://pre.smartvm.cn，请把真实 SMARTVM_CLIENT_ID 和 SMARTVM_KEY 写入 sandbox/.env、sandbox/.env.local 或系统环境变量。"
      ].join("")
    );
  }

  return {
    clientId,
    key,
    isDemoCredentials
  };
};

export const hasRealSmartVmCredentials = () =>
  !getSmartVmCredentials({ allowDemoCredentials: true }).isDemoCredentials;

export const getSandboxConfig = () => ({
  smartVmBaseUrl: process.env.SMARTVM_BASE_URL ?? defaultSandboxConfig.SMARTVM_BASE_URL,
  smartVmDeviceCode: process.env.SMARTVM_DEVICE_CODE ?? defaultSandboxConfig.SMARTVM_DEVICE_CODE,
  smartVmDoorNum: process.env.SMARTVM_DOOR_NUM ?? defaultSandboxConfig.SMARTVM_DOOR_NUM,
  localApiBaseUrl: process.env.LOCAL_API_BASE_URL ?? defaultSandboxConfig.LOCAL_API_BASE_URL,
  sandboxAdminPhone: process.env.SANDBOX_ADMIN_PHONE ?? defaultSandboxConfig.SANDBOX_ADMIN_PHONE,
  sandboxAdminCode: process.env.SANDBOX_ADMIN_CODE ?? defaultSandboxConfig.SANDBOX_ADMIN_CODE,
  testPlatformAccount: process.env.TEST_PLATFORM_ACCOUNT ?? defaultSandboxConfig.TEST_PLATFORM_ACCOUNT,
  testPlatformPassword:
    process.env.TEST_PLATFORM_PASSWORD ?? defaultSandboxConfig.TEST_PLATFORM_PASSWORD
});

export const withSignature = (payload, options = {}) => {
  const { clientId, key } = getSmartVmCredentials(options);
  const nonceStr = createNonce();
  const signedPayload = {
    ...payload,
    clientId,
    nonceStr
  };

  return {
    ...signedPayload,
    sign: signPayload(signedPayload, key)
  };
};

export const getJson = async (baseUrl, path) => {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`);
  return response.json();
};

export const unwrapEnvelope = (response) => {
  if (response && typeof response === "object" && "data" in response) {
    return response.data;
  }

  return response;
};

export const postJson = async (baseUrl, path, payload, headers = {}) => {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json();
  return {
    status: response.status,
    json
  };
};

export const authPostJson = async (baseUrl, path, payload, token) => {
  if (!token) {
    throw new Error("调用受保护的本地后端接口时必须提供管理员 token。");
  }

  return postJson(baseUrl, path, payload, {
    Authorization: `Bearer ${token}`
  });
};

export const ensureAdminToken = async (baseUrl) => {
  const explicitToken = process.env.SANDBOX_ADMIN_TOKEN?.trim();

  if (explicitToken) {
    return explicitToken;
  }

  const sandboxConfig = getSandboxConfig();
  const phone = sandboxConfig.sandboxAdminPhone?.trim();
  const code = sandboxConfig.sandboxAdminCode?.trim();

  if (!phone || !code) {
    throw new Error("缺少 SANDBOX_ADMIN_TOKEN，且 SANDBOX_ADMIN_PHONE / SANDBOX_ADMIN_CODE 也未配置。");
  }

  const response = await postJson(baseUrl, "/auth/admin-login", {
    phone,
    code
  });
  const parsed = unwrapEnvelope(response.json);
  const token = parsed?.token;

  if (response.status !== 200 || !token) {
    throw new Error(
      [
        `管理员登录失败：${typeof response.json?.message === "string" ? response.json.message : "未返回 token"}`,
        "如果当前后端已经切到真实短信验证码，不要继续使用默认的 SANDBOX_ADMIN_CODE=123456。",
        "请改为以下任一方式：",
        "1. 在 sandbox/.env.local 里设置 SANDBOX_ADMIN_TOKEN=你的管理员 Bearer Token",
        "2. 或者设置真实的 SANDBOX_ADMIN_PHONE / SANDBOX_ADMIN_CODE",
        "3. 先运行不需要管理员权限的事件查询脚本，确认最新 orderNo / eventId，再决定是否需要退款或转发测试"
      ].join("")
    );
  }

  return token;
};

export const getCabinetEvents = async (baseUrl) => {
  const response = await getJson(baseUrl, "/cabinet-events");
  const events = unwrapEnvelope(response);

  if (!Array.isArray(events)) {
    throw new Error("本地后端未返回可用的开柜事件列表。");
  }

  return events;
};

export const findEvent = async (baseUrl, orderNo) => {
  const events = await getCabinetEvents(baseUrl);

  if (orderNo) {
    const matched = events.find((entry) => entry.orderNo === orderNo);

    if (!matched) {
      throw new Error(`本地后端中未找到订单 ${orderNo}。`);
    }

    return matched;
  }

  if (!events.length) {
    throw new Error("当前没有可用的开柜事件，请先发起一次开柜。");
  }

  return events[0];
};
