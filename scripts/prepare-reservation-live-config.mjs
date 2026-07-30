import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const allowedArgumentNames = new Set([
  "source-env",
  "target-env",
  "data-root",
  "data-plane-id",
  "tenant-name",
  "public-base-url"
]);
const dataPlaneIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const assignmentPattern = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u;

const parseArguments = () => {
  const values = new Map();

  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      throw new Error("参数格式无效；每项都必须使用 --名称=值。");
    }

    const separatorIndex = argument.indexOf("=");
    const name = argument.slice(2, separatorIndex);
    const value = argument.slice(separatorIndex + 1);

    if (!allowedArgumentNames.has(name) || values.has(name)) {
      throw new Error("存在不支持或重复的参数。");
    }

    values.set(name, value);
  }

  for (const name of allowedArgumentNames) {
    if (!values.get(name)?.trim()) {
      throw new Error(`缺少必填参数：--${name}。`);
    }
  }

  return values;
};

const parseEnvAssignments = (content) => {
  const values = new Map();

  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(assignmentPattern);
    if (match) {
      values.set(match[1], match[2]);
    }
  }

  return values;
};

const decodeEnvValue = (rawValue) => {
  const value = String(rawValue ?? "").trim();

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error("来源配置包含无法解析的双引号值。");
      }
    }

    return value.slice(1, -1);
  }

  return value;
};

const encodeEnvValue = (value) => {
  const normalized = String(value);
  return /^[^\s#"'\\]+$/u.test(normalized)
    ? normalized
    : JSON.stringify(normalized);
};

const isInheritedKey = (key) =>
  [
    "PORT",
    "API_HOST",
    "TRUST_PROXY_HOPS",
    "PUBLIC_BASE_URL",
    "CORS_ORIGINS",
    "BUSINESS_TIMEZONE_OFFSET_HOURS",
    "BUSINESS_DAY_START_HOUR",
    "AMAP_WEB_KEY",
    "AMAP_SECURITY_JS_CODE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_BASE_URL_EXACT_HOST_ALLOWLIST",
    "OPENAI_MODEL",
    "OPENAI_TIMEOUT_MS"
  ].includes(key) ||
  (key.startsWith("SMARTVM_") &&
    !key.startsWith("SMARTVM_TEST_") &&
    key !== "SMARTVM_DEFAULT_PAY_STYLE" &&
    key !== "SMARTVM_ALLOW_UNSIGNED_CALLBACKS" &&
    key !== "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS");

const assertPrivateRegularSource = (filePath) => {
  if (!isAbsolute(filePath) || !existsSync(filePath)) {
    throw new Error("来源配置必须是存在的绝对路径。");
  }

  const sourceStat = lstatSync(filePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error("来源配置必须是普通文件，不能是目录或符号链接。");
  }

  if (process.platform !== "win32") {
    if (
      typeof process.getuid === "function" &&
      sourceStat.uid !== process.getuid()
    ) {
      throw new Error("来源配置必须归当前服务用户所有。");
    }

    if ((sourceStat.mode & 0o077) !== 0) {
      throw new Error("来源配置不能被组或其他用户读取、写入或执行。");
    }
  }
};

const assertRequiredInheritedConfiguration = (values) => {
  const requiredKeys = ["AMAP_WEB_KEY", "AMAP_SECURITY_JS_CODE"];

  for (const key of requiredKeys) {
    if (!decodeEnvValue(values.get(key))) {
      throw new Error(`来源配置缺少正式实例必需项：${key}。`);
    }
  }
};

const normalizePublicBaseUrl = (rawValue) => {
  let publicBaseUrl;
  try {
    publicBaseUrl = new URL(String(rawValue).trim());
  } catch {
    throw new Error("公网入口不是有效 URL。");
  }

  if (
    publicBaseUrl.protocol !== "https:" ||
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    publicBaseUrl.search ||
    publicBaseUrl.hash ||
    publicBaseUrl.pathname !== "/"
  ) {
    throw new Error("正式实例公网入口必须是无凭据、路径、查询或片段的 HTTPS 根地址。");
  }

  return publicBaseUrl.origin;
};

const writePrivateFileAtomically = (targetPath, content) => {
  const targetDirectory = dirname(targetPath);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    targetDirectory,
    `.${basename(targetPath)}.${process.pid}.tmp`
  );
  let fileDescriptor;
  let directoryDescriptor;

  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fileDescriptor, content, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, targetPath);
    chmodSync(targetPath, 0o600);

    if (process.platform !== "win32") {
      directoryDescriptor = openSync(targetDirectory, "r");
      fsyncSync(directoryDescriptor);
      closeSync(directoryDescriptor);
      directoryDescriptor = undefined;
    }
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // 保留原始失败。
      }
    }

    if (directoryDescriptor !== undefined) {
      try {
        closeSync(directoryDescriptor);
      } catch {
        // 保留原始失败。
      }
    }

    rmSync(temporaryPath, { force: true });
    throw error;
  }
};

const main = () => {
  const argumentsByName = parseArguments();
  const sourceEnv = resolve(argumentsByName.get("source-env"));
  const targetEnv = resolve(argumentsByName.get("target-env"));
  const dataRoot = resolve(argumentsByName.get("data-root")).replaceAll("\\", "/");
  const dataPlaneId = argumentsByName.get("data-plane-id").trim();
  const tenantName = argumentsByName.get("tenant-name").trim();
  const publicBaseUrl = normalizePublicBaseUrl(
    argumentsByName.get("public-base-url")
  );

  if (sourceEnv === targetEnv) {
    throw new Error("来源配置与目标配置不能是同一个文件。");
  }

  if (existsSync(targetEnv)) {
    throw new Error("目标配置已存在，已拒绝覆盖。");
  }

  if (!dataPlaneIdPattern.test(dataPlaneId)) {
    throw new Error("数据平面 ID 必须是 8 至 128 位字母、数字、点、下划线或连字符。");
  }

  if (!tenantName || [...tenantName].length > 100 || /[\r\n]/u.test(tenantName)) {
    throw new Error("实例名称必须是 1 至 100 个字符的单行文本。");
  }

  assertPrivateRegularSource(sourceEnv);
  const sourceValues = parseEnvAssignments(readFileSync(sourceEnv, "utf8"));
  assertRequiredInheritedConfiguration(sourceValues);

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(
    scriptDirectory,
    "../apps/api/.env.production.example"
  );
  const templateContent = readFileSync(templatePath, "utf8");
  const targetValues = parseEnvAssignments(templateContent);

  for (const [key, rawValue] of sourceValues) {
    if (isInheritedKey(key) && targetValues.has(key)) {
      targetValues.set(key, rawValue);
    }
  }

  const fixedValues = {
    NODE_ENV: "production",
    APP_ENV: "production",
    VM_DATA_PLANE: "live",
    VM_DATA_ROOT: dataRoot,
    VM_DATA_PLANE_ID: dataPlaneId,
    VM_PLATFORM_TENANT_NAME: tenantName,
    PUBLIC_BASE_URL: publicBaseUrl,
    CORS_ORIGINS: publicBaseUrl,
    VM_RESERVATION_ONLY_PICKUP: "true",
    WEB_CONCURRENCY: "1",
    API_INSTANCE_COUNT: "1",
    NODE_APP_INSTANCE: "0",
    PAYMENT_MODE: "disabled",
    PAYMENT_MOCK_ENABLED: "false",
    FINANCIAL_SINGLE_WRITER_ENABLED: "true",
    FINANCIAL_INSTANCE_ID: dataPlaneId,
    PAYMENT_RECONCILIATION_ENABLED: "false",
    VERIFICATION_CODE_PROVIDER: "manual",
    VERIFICATION_CODE_PREVIEW_ENABLED: "false",
    SMARTVM_MODE: "disabled",
    SMARTVM_ALLOW_UNSIGNED_CALLBACKS: "false",
    SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: "false",
    ALLOW_DEFAULT_BACKOFFICE_LOGIN: "false",
    PUBLIC_ADMIN_REGISTRATION_ENABLED: "false",
    ENABLE_LOCAL_MOCK_DEVICE_API: "false",
    ENABLE_TEST_DEVICE_BOOTSTRAP: "false"
  };

  for (const [key, value] of Object.entries(fixedValues)) {
    if (!targetValues.has(key)) {
      throw new Error(`生产模板缺少受控配置项：${key}。`);
    }
    targetValues.set(key, encodeEnvValue(value));
  }

  for (const key of [
    "SMARTVM_BASE_URL",
    "SMARTVM_ALLOWED_NOTIFY_ORIGINS",
    "SMARTVM_CLIENT_ID",
    "SMARTVM_KEY"
  ]) {
    targetValues.set(key, "");
  }

  const renderedLines = templateContent.split(/\r?\n/u).map((line) => {
    const match = line.match(assignmentPattern);
    return match && targetValues.has(match[1])
      ? `${match[1]}=${targetValues.get(match[1])}`
      : line;
  });
  const content = `${renderedLines.join("\n").replace(/\s*$/u, "")}\n`;
  writePrivateFileAtomically(targetEnv, content);

  const digest = createHash("sha256").update(content).digest("hex");
  console.log(
    `预约制正式实例配置已生成：键数 ${targetValues.size}，SHA256 ${digest}。`
  );
};

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "生成预约制正式实例配置失败。"
  );
  process.exitCode = 1;
}
