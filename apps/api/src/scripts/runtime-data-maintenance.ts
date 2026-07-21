import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  resolveApiBackupDir,
  resolveApiDataFile,
  resolveApiWorkspaceRoot,
  resolveSystemLogFile,
  resolveUploadDir
} from "../common/store/persistence.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import type { FinancialSingleWriterLease } from "../common/coordination/financial-single-writer-lease.js";

const MANIFEST_FILE_NAME = "runtime-backup-manifest.json";
const BACKUP_SCHEMA_VERSION = 1;

const REQUIRED_ARRAY_KEYS = [
  "users",
  "rules",
  "devices",
  "goodsCatalog",
  "goodsCategories",
  "regions",
  "warehouses",
  "specialAccessPolicies",
  "goodsAlertPolicies",
  "registrationApplications",
  "merchantGoodsTemplates",
  "deviceGoodsSettings",
  "goodsBatches",
  "batchConsumptionTraces",
  "inventoryTransfers",
  "stocktakes",
  "events",
  "inventory",
  "paymentOrders",
  "paymentRefunds",
  "reservations",
  "alerts",
  "logs",
  "adminCredentials",
  "backofficeCredentials",
  "callbackLog"
] as const;

const REQUIRED_PAIR_ARRAY_KEYS = ["verificationCodes", "sessions", "draftSessions", "deviceRuntime"] as const;

interface RuntimeSources {
  dataFile: string;
  systemLogFile: string;
  uploadDir: string;
  backupRoot: string;
}

interface BackupItem {
  key: "store" | "systemLog" | "upload";
  backupPath: string;
  sourcePath: string;
  bytes: number;
  sha256: string;
  modifiedAt: string;
  required: boolean;
}

interface RuntimeBackupManifest {
  schemaVersion: 1;
  createdAt: string;
  label?: string;
  source: {
    apiDataFile: string;
    systemLogFile: string;
    uploadDir: string;
  };
  included: {
    store: true;
    systemLog: boolean;
    uploads: boolean;
  };
  validation: {
    summary: Record<string, number>;
    warnings: string[];
  };
  items: BackupItem[];
}

interface ValidationResult {
  summary: Record<string, number>;
  warnings: string[];
  errors: string[];
}

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatPath = (path: string) => path.replace(/\\/g, "/");

const normalizeForCompare = (path: string) => {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isSameOrInside = (childPath: string, parentPath: string) => {
  const child = normalizeForCompare(childPath);
  const parent = normalizeForCompare(parentPath);

  if (child === parent) {
    return true;
  }

  const relativePath = relative(parent, child);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
};

const normalizeRelativePath = (path: string) => path.split(sep).join("/");

const safeBackupPath = (backupDir: string, backupPath: string) => {
  if (!backupPath || isAbsolute(backupPath)) {
    throw new Error(`备份清单包含非法路径：${backupPath}`);
  }

  const target = resolve(backupDir, ...backupPath.split("/"));

  if (!isSameOrInside(target, backupDir)) {
    throw new Error(`备份清单包含越界路径：${backupPath}`);
  }

  return target;
};

const assertRegularBackupFile = (backupDir: string, backupPath: string) => {
  const targetPath = safeBackupPath(backupDir, backupPath);
  const targetStat = lstatSync(targetPath);

  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`备份项必须是普通文件：${backupPath}`);
  }

  const realBackupDir = realpathSync(backupDir);
  const realTargetPath = realpathSync(targetPath);

  if (!isSameOrInside(realTargetPath, realBackupDir)) {
    throw new Error(`备份项通过链接越界：${backupPath}`);
  }

  return targetPath;
};

const parseArgs = (args: string[]): ParsedArgs => {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");

    if (equalsIndex >= 0) {
      values.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    const next = args[index + 1];

    if (next && !next.startsWith("--")) {
      values.set(withoutPrefix, next);
      index += 1;
      continue;
    }

    flags.add(withoutPrefix);
  }

  return {
    flags,
    values,
    positional
  };
};

const readPositiveIntegerOption = (args: ParsedArgs, name: string) => {
  const raw = args.values.get(name);

  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} 必须是正整数。`);
  }

  return value;
};

const resolveCliPath = (path: string) => {
  if (isAbsolute(path)) {
    return path;
  }

  const normalizedPath = path.replace(/\\/g, "/");

  if (normalizedPath.startsWith("apps/api/")) {
    return resolve(resolveApiWorkspaceRoot(), normalizedPath.slice("apps/api/".length));
  }

  return resolve(process.cwd(), path);
};

const getRuntimeSources = (args: ParsedArgs): RuntimeSources => ({
  dataFile: resolveApiDataFile(),
  systemLogFile: resolveSystemLogFile(),
  uploadDir: resolveUploadDir(),
  backupRoot: args.values.has("backup-dir")
    ? resolveCliPath(args.values.get("backup-dir") ?? "")
    : resolveApiBackupDir()
});

const sanitizeLabel = (label?: string) => {
  const normalized = (label ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
};

const createTimestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const countArray = (state: Record<string, unknown>, key: string) => {
  const value = state[key];
  return Array.isArray(value) ? value.length : 0;
};

const validateUniqueField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  result: ValidationResult,
  severity: "error" | "warning" = "error"
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  const seen = new Set<string>();
  const findings: string[] = [];

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      findings.push(`${key}[${index}] 必须是对象。`);
      continue;
    }

    const id = item[field];

    if (typeof id !== "string" || !id.trim()) {
      findings.push(`${key}[${index}].${field} 缺失或不是字符串。`);
      continue;
    }

    if (seen.has(id)) {
      findings.push(`${key} 存在重复 ${field}：${id}`);
    }

    seen.add(id);
  }

  if (severity === "warning") {
    result.warnings.push(...findings);
  } else {
    result.errors.push(...findings);
  }
};

const validateRequiredStringFields = (
  state: Record<string, unknown>,
  key: string,
  fields: string[],
  result: ValidationResult
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      result.errors.push(`${key}[${index}] 必须是对象。`);
      continue;
    }

    for (const field of fields) {
      if (typeof item[field] !== "string" || !item[field].trim()) {
        result.errors.push(`${key}[${index}].${field} 缺失或为空字符串。`);
      }
    }
  }
};

const validatePairArray = (state: Record<string, unknown>, key: string, result: ValidationResult) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    result.errors.push(`${key} 必须是数组。`);
    return;
  }

  const seenKeys = new Set<string>();

  for (const [index, item] of value.entries()) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !isRecord(item[1])) {
      result.errors.push(`${key}[${index}] 必须是 [string, object] 形式。`);
      continue;
    }

    if (!item[0].trim()) {
      result.errors.push(`${key}[${index}] 的键不能为空。`);
    } else if (seenKeys.has(item[0])) {
      result.errors.push(`${key} 存在重复键：${item[0]}`);
    }

    seenKeys.add(item[0]);
  }
};

const validateNumericField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  result: ValidationResult,
  options: {
    integer?: boolean;
    min?: number;
    max?: number;
  } = {}
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }

    const numericValue = item[field];

    if (
      typeof numericValue !== "number" ||
      !Number.isFinite(numericValue) ||
      (options.integer && !Number.isInteger(numericValue)) ||
      (options.min !== undefined && numericValue < options.min) ||
      (options.max !== undefined && numericValue > options.max)
    ) {
      const range = [
        options.integer ? "整数" : "有限数字",
        options.min !== undefined ? `不小于 ${options.min}` : undefined,
        options.max !== undefined ? `不大于 ${options.max}` : undefined
      ].filter(Boolean).join("且");
      result.errors.push(`${key}[${index}].${field} 必须是${range}。`);
    }
  }
};

const validateReferenceField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  targetIds: ReadonlySet<string>,
  targetLabel: string,
  result: ValidationResult,
  optional = false
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }

    const reference = item[field];

    if (optional && (reference === undefined || reference === null || reference === "")) {
      continue;
    }

    if (typeof reference !== "string" || !reference.trim() || !targetIds.has(reference)) {
      result.errors.push(`${key}[${index}].${field} 引用了不存在的${targetLabel}：${String(reference)}`);
    }
  }
};

const validateStoreFile = (filePath: string): ValidationResult => {
  const result: ValidationResult = {
    summary: {},
    warnings: [],
    errors: []
  };

  if (!existsSync(filePath)) {
    result.errors.push(`未找到业务数据文件：${filePath}`);
    return result;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    result.errors.push(`业务数据 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  if (!isRecord(parsed)) {
    result.errors.push("业务数据根节点必须是对象。");
    return result;
  }

  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!Array.isArray(parsed[key])) {
      result.errors.push(`${key} 必须是数组。`);
    }
  }

  for (const key of REQUIRED_PAIR_ARRAY_KEYS) {
    validatePairArray(parsed, key, result);
  }

  if (!isRecord(parsed.reservationSettings)) {
    result.errors.push("reservationSettings 必须是对象。");
  } else {
    const { enabled, holdMinutes, maxTimeouts } = parsed.reservationSettings;

    if (typeof enabled !== "boolean") {
      result.errors.push("reservationSettings.enabled 必须是布尔值。");
    }

    if (
      typeof holdMinutes !== "number" ||
      !Number.isInteger(holdMinutes) ||
      holdMinutes < 5 ||
      holdMinutes > 24 * 60
    ) {
      result.errors.push("reservationSettings.holdMinutes 必须是 5 至 1440 的整数。");
    }

    if (
      typeof maxTimeouts !== "number" ||
      !Number.isInteger(maxTimeouts) ||
      maxTimeouts < 1 ||
      maxTimeouts > 20
    ) {
      result.errors.push("reservationSettings.maxTimeouts 必须是 1 至 20 的整数。");
    }
  }

  validateUniqueField(parsed, "users", "id", result);
  validateUniqueField(parsed, "users", "phone", result);
  validateUniqueField(parsed, "devices", "deviceCode", result);
  validateUniqueField(parsed, "goodsCatalog", "goodsId", result);
  validateUniqueField(parsed, "goodsCategories", "id", result);
  validateUniqueField(parsed, "warehouses", "code", result);
  validateUniqueField(parsed, "goodsBatches", "batchId", result);
  validateUniqueField(parsed, "registrationApplications", "id", result);
  validateUniqueField(parsed, "merchantGoodsTemplates", "id", result);
  validateUniqueField(parsed, "batchConsumptionTraces", "id", result);
  validateUniqueField(parsed, "inventoryTransfers", "id", result);
  validateUniqueField(parsed, "stocktakes", "id", result);
  validateUniqueField(parsed, "events", "eventId", result);
  validateUniqueField(parsed, "events", "orderNo", result);
  validateUniqueField(parsed, "inventory", "id", result);
  validateUniqueField(parsed, "paymentOrders", "id", result);
  validateUniqueField(parsed, "paymentOrders", "paymentNo", result);
  validateUniqueField(parsed, "paymentRefunds", "id", result);
  validateUniqueField(parsed, "paymentRefunds", "refundNo", result);
  validateUniqueField(parsed, "reservations", "id", result);
  validateUniqueField(parsed, "alerts", "id", result);
  validateUniqueField(parsed, "logs", "id", result);
  validateUniqueField(parsed, "callbackLog", "id", result);
  validateUniqueField(parsed, "adminCredentials", "username", result);
  validateUniqueField(parsed, "backofficeCredentials", "username", result);
  validateRequiredStringFields(parsed, "users", ["id", "phone", "name", "role", "status"], result);
  validateRequiredStringFields(parsed, "devices", ["deviceCode", "name", "status"], result);
  validateRequiredStringFields(parsed, "goodsCatalog", ["goodsId", "goodsCode", "name", "category"], result);
  validateRequiredStringFields(parsed, "goodsBatches", ["batchId", "goodsId", "deviceCode", "sourceType"], result);
  validateRequiredStringFields(parsed, "events", ["eventId", "orderNo", "userId", "deviceCode", "status"], result);
  validateRequiredStringFields(parsed, "inventory", ["id", "userId", "deviceCode", "goodsId", "type"], result);
  validateRequiredStringFields(parsed, "paymentOrders", ["id", "paymentNo", "provider", "phase", "status"], result);
  validateRequiredStringFields(parsed, "paymentRefunds", ["id", "paymentOrderId", "paymentNo", "refundNo", "provider", "status"], result);
  validateRequiredStringFields(parsed, "reservations", ["id", "userId", "deviceCode", "status"], result);
  validateNumericField(parsed, "goodsBatches", "quantity", result, { integer: true, min: 0 });
  validateNumericField(parsed, "goodsBatches", "remainingQuantity", result, { integer: true });
  validateNumericField(parsed, "inventory", "quantity", result, { integer: true, min: 1 });
  validateNumericField(parsed, "inventory", "unitPrice", result, { min: 0 });
  validateNumericField(parsed, "events", "amount", result, { min: 0 });
  validateNumericField(parsed, "paymentOrders", "amount", result, { min: 0 });
  validateNumericField(parsed, "paymentRefunds", "amount", result, { min: 0 });

  const catalogGoodsIds = new Set(
    Array.isArray(parsed.goodsCatalog)
      ? parsed.goodsCatalog
          .filter(isRecord)
          .map((entry) => entry.goodsId)
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      : []
  );
  const userIds = new Set(
    Array.isArray(parsed.users)
      ? parsed.users
          .filter(isRecord)
          .map((entry) => entry.id)
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      : []
  );
  const paymentOrderIds = new Set(
    Array.isArray(parsed.paymentOrders)
      ? parsed.paymentOrders
          .filter(isRecord)
          .map((entry) => entry.id)
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      : []
  );
  const eventIds = new Set(
    Array.isArray(parsed.events)
      ? parsed.events
          .filter(isRecord)
          .map((entry) => entry.eventId)
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      : []
  );

  validateReferenceField(parsed, "inventory", "goodsId", catalogGoodsIds, "货品", result);
  validateReferenceField(parsed, "merchantGoodsTemplates", "goodsId", catalogGoodsIds, "货品", result, true);
  validateReferenceField(parsed, "registrationApplications", "linkedUserId", userIds, "用户", result, true);
  validateReferenceField(parsed, "adminCredentials", "userId", userIds, "用户", result);
  validateReferenceField(parsed, "backofficeCredentials", "userId", userIds, "用户", result);
  validateReferenceField(parsed, "paymentRefunds", "paymentOrderId", paymentOrderIds, "支付单", result);
  validateReferenceField(parsed, "paymentOrders", "eventId", eventIds, "开柜事件", result, true);

  for (const key of ["goodsBatches"] as const) {
    const entries = parsed[key];

    if (!Array.isArray(entries)) {
      continue;
    }

    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry) || typeof entry.goodsId !== "string" || !entry.goodsId.trim()) {
        continue;
      }

      if (!catalogGoodsIds.has(entry.goodsId)) {
        result.errors.push(`${key}[${index}].goodsId 引用了不存在的货品：${entry.goodsId}`);
      }
    }
  }

  const batches = parsed.goodsBatches;

  if (Array.isArray(batches)) {
    let negativeBalanceBatchCount = 0;

    for (const [index, batch] of batches.entries()) {
      if (!isRecord(batch)) {
        continue;
      }

      const remainingQuantity = batch.remainingQuantity;

      if (typeof remainingQuantity === "number" && remainingQuantity < 0) {
        negativeBalanceBatchCount += 1;
      }
    }

    if (negativeBalanceBatchCount > 0) {
      result.warnings.push(`存在 ${negativeBalanceBatchCount} 条负库存平衡批次，校验允许但恢复后需继续关注库存修正。`);
    }
  }

  const defaultCredentialCount = ["adminCredentials", "backofficeCredentials"].reduce((count, key) => {
    const credentials = parsed[key];

    if (!Array.isArray(credentials)) {
      return count;
    }

    return (
      count +
      credentials.filter((entry) => isRecord(entry) && entry.usesDefaultPassword === true).length
    );
  }, 0);

  if (defaultCredentialCount > 0) {
    result.warnings.push(`仍有 ${defaultCredentialCount} 个默认密码凭据，公网投放前应改密或移除。`);
  }

  result.summary = {
    users: countArray(parsed, "users"),
    devices: countArray(parsed, "devices"),
    goodsCatalog: countArray(parsed, "goodsCatalog"),
    goodsBatches: countArray(parsed, "goodsBatches"),
    inventory: countArray(parsed, "inventory"),
    events: countArray(parsed, "events"),
    alerts: countArray(parsed, "alerts"),
    logs: countArray(parsed, "logs"),
    paymentOrders: countArray(parsed, "paymentOrders"),
    paymentRefunds: countArray(parsed, "paymentRefunds"),
    reservations: countArray(parsed, "reservations"),
    sessions: countArray(parsed, "sessions"),
    callbackLog: countArray(parsed, "callbackLog")
  };

  return result;
};

const validateSystemLogFile = async (filePath: string): Promise<ValidationResult> => {
  const result: ValidationResult = {
    summary: {
      auditLogLines: 0
    },
    warnings: [],
    errors: []
  };

  if (!existsSync(filePath)) {
    result.warnings.push(`未找到系统审计日志：${filePath}`);
    return result;
  }

  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let lineNumber = 0;
  let parsedLines = 0;

  for await (const line of reader) {
    lineNumber += 1;

    if (!line.trim()) {
      continue;
    }

    try {
      JSON.parse(line);
      parsedLines += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`系统审计日志第 ${lineNumber} 行不是合法 JSON：${message}`);

      if (result.errors.length >= 5) {
        result.errors.push("系统审计日志存在更多解析问题，已停止逐行校验。");
        break;
      }
    }
  }

  result.summary.auditLogLines = parsedLines;
  return result;
};

const mergeValidationResults = (...results: ValidationResult[]): ValidationResult => ({
  summary: Object.assign({}, ...results.map((entry) => entry.summary)),
  warnings: results.flatMap((entry) => entry.warnings),
  errors: results.flatMap((entry) => entry.errors)
});

const assertNoValidationErrors = (result: ValidationResult, subject: string) => {
  if (result.errors.length === 0) {
    return;
  }

  throw new Error(`${subject} 校验失败：\n${result.errors.map((entry) => `- ${entry}`).join("\n")}`);
};

const sha256File = (filePath: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolveHash(hash.digest("hex"));
    });
  });

const copyFileForBackup = async (
  backupDir: string,
  sourcePath: string,
  backupPath: string,
  key: BackupItem["key"],
  required: boolean
): Promise<BackupItem> => {
  const targetPath = safeBackupPath(backupDir, backupPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);

  const stat = statSync(targetPath);

  return {
    key,
    backupPath,
    sourcePath,
    bytes: stat.size,
    sha256: await sha256File(targetPath),
    modifiedAt: stat.mtime.toISOString(),
    required
  };
};

const listFilesRecursive = (rootDir: string) => {
  const files: string[] = [];

  if (!existsSync(rootDir)) {
    return files;
  }

  const walk = (currentDir: string) => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relativePath = normalizeRelativePath(relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        throw new Error(`上传目录中包含符号链接，脚本不会跟随备份：${fullPath}`);
      }

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };

  walk(rootDir);
  return files;
};

const copyDirectoryContents = (sourceDir: string, targetDir: string) => {
  mkdirSync(targetDir, { recursive: true });

  for (const relativePath of listFilesRecursive(sourceDir)) {
    const sourcePath = resolve(sourceDir, ...relativePath.split("/"));
    const targetPath = resolve(targetDir, ...relativePath.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
};

const assertBackupRootIsSafe = (sources: RuntimeSources) => {
  if (isSameOrInside(sources.dataFile, sources.backupRoot)) {
    throw new Error("API_DATA_FILE 不能位于 API_BACKUP_DIR 内。");
  }

  if (isSameOrInside(sources.systemLogFile, sources.backupRoot)) {
    throw new Error("SYSTEM_LOG_FILE 不能位于 API_BACKUP_DIR 内。");
  }

  if (isSameOrInside(sources.uploadDir, sources.backupRoot)) {
    throw new Error("UPLOAD_DIR 不能位于 API_BACKUP_DIR 内。");
  }

  if (isSameOrInside(sources.backupRoot, sources.uploadDir)) {
    throw new Error("API_BACKUP_DIR 不能放在 UPLOAD_DIR 内，否则会递归备份自身。");
  }
};

const readManifest = (backupDir: string): RuntimeBackupManifest => {
  if (!existsSync(backupDir)) {
    throw new Error(`备份目录不存在：${backupDir}`);
  }

  const backupDirStat = lstatSync(backupDir);

  if (backupDirStat.isSymbolicLink() || !backupDirStat.isDirectory()) {
    throw new Error(`备份路径必须是普通目录，不能是符号链接：${backupDir}`);
  }

  const manifestPath = join(backupDir, MANIFEST_FILE_NAME);

  if (!existsSync(manifestPath)) {
    throw new Error(`未找到备份清单：${manifestPath}`);
  }

  const manifestStat = lstatSync(manifestPath);

  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`备份清单必须是普通文件：${manifestPath}`);
  }

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;

  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !isRecord(parsed.included) ||
    parsed.included.store !== true ||
    typeof parsed.included.systemLog !== "boolean" ||
    typeof parsed.included.uploads !== "boolean" ||
    !Array.isArray(parsed.items)
  ) {
    throw new Error(`备份清单格式不受支持：${manifestPath}`);
  }

  const allowedKeys = new Set<BackupItem["key"]>(["store", "systemLog", "upload"]);
  const backupPaths = new Set<string>();

  for (const [index, item] of parsed.items.entries()) {
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      !allowedKeys.has(item.key as BackupItem["key"]) ||
      typeof item.backupPath !== "string" ||
      !item.backupPath ||
      typeof item.sourcePath !== "string" ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) < 0 ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(item.sha256) ||
      typeof item.modifiedAt !== "string" ||
      typeof item.required !== "boolean"
    ) {
      throw new Error(`备份清单 items[${index}] 格式无效。`);
    }

    safeBackupPath(backupDir, item.backupPath);

    if (backupPaths.has(item.backupPath)) {
      throw new Error(`备份清单包含重复路径：${item.backupPath}`);
    }

    backupPaths.add(item.backupPath);
  }

  const storeItems = parsed.items.filter((item) => isRecord(item) && item.key === "store");
  const systemLogItems = parsed.items.filter((item) => isRecord(item) && item.key === "systemLog");
  const uploadItems = parsed.items.filter((item) => isRecord(item) && item.key === "upload");

  if (storeItems.length !== 1) {
    throw new Error("备份清单必须且只能包含一份业务数据文件。");
  }

  if (systemLogItems.length !== (parsed.included.systemLog ? 1 : 0)) {
    throw new Error("备份清单的系统审计日志声明与文件项不一致。");
  }

  if (!parsed.included.uploads && uploadItems.length > 0) {
    throw new Error("备份清单声明不含上传目录，但仍包含上传文件项。");
  }

  return parsed as unknown as RuntimeBackupManifest;
};

const verifyBackupDirectory = async (backupDir: string): Promise<ValidationResult> => {
  const manifest = readManifest(backupDir);
  const warnings: string[] = [];
  const errors: string[] = [];
  const declaredBackupPaths = new Set(
    manifest.items.map((item) => normalizeRelativePath(item.backupPath))
  );

  for (const actualPath of listFilesRecursive(backupDir)) {
    if (
      actualPath !== MANIFEST_FILE_NAME &&
      !declaredBackupPaths.has(actualPath)
    ) {
      errors.push(`备份包含清单未声明的文件：${actualPath}`);
    }
  }

  for (const item of manifest.items) {
    const targetPath = safeBackupPath(backupDir, item.backupPath);

    if (!existsSync(targetPath)) {
      errors.push(`备份文件缺失：${item.backupPath}`);
      continue;
    }

    let regularFilePath: string;

    try {
      regularFilePath = assertRegularBackupFile(backupDir, item.backupPath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const stat = statSync(regularFilePath);

    if (stat.size !== item.bytes) {
      errors.push(`备份文件大小不匹配：${item.backupPath}`);
    }

    const actualHash = await sha256File(regularFilePath);

    if (actualHash !== item.sha256) {
      errors.push(`备份文件 SHA256 不匹配：${item.backupPath}`);
    }
  }

  const storeItem = manifest.items.find((item) => item.key === "store");

  if (!storeItem) {
    errors.push("备份清单缺少 store.json。");
  }

  const storeValidation = storeItem && existsSync(safeBackupPath(backupDir, storeItem.backupPath))
    ? validateStoreFile(assertRegularBackupFile(backupDir, storeItem.backupPath))
    : {
        summary: {},
        warnings: [],
        errors: []
      };
  const systemLogItem = manifest.items.find((item) => item.key === "systemLog");
  const systemLogValidation = systemLogItem && existsSync(safeBackupPath(backupDir, systemLogItem.backupPath))
    ? await validateSystemLogFile(assertRegularBackupFile(backupDir, systemLogItem.backupPath))
    : {
        summary: {},
        warnings: [],
        errors: []
      };

  if (manifest.included.uploads) {
    const uploadsPath = join(backupDir, "uploads");

    if (!existsSync(uploadsPath)) {
      errors.push("备份清单声明包含上传目录，但 uploads 目录缺失。");
    } else {
      const uploadsStat = lstatSync(uploadsPath);

      if (uploadsStat.isSymbolicLink() || !uploadsStat.isDirectory()) {
        errors.push("备份 uploads 必须是普通目录，不能是符号链接。");
      }
    }
  }

  return mergeValidationResults(
    {
      summary: storeValidation.summary,
      warnings,
      errors
    },
    storeValidation,
    systemLogValidation
  );
};

const findLatestBackupDir = (backupRoot: string) => {
  if (!existsSync(backupRoot)) {
    throw new Error(`备份目录不存在：${backupRoot}`);
  }

  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(backupRoot, entry.name))
    .filter((dir) => existsSync(join(dir, MANIFEST_FILE_NAME)))
    .sort((left, right) => right.localeCompare(left));

  const latest = candidates[0];

  if (!latest) {
    throw new Error(`备份目录中没有可用备份：${backupRoot}`);
  }

  return latest;
};

const resolveBackupSelection = (args: ParsedArgs, sources: RuntimeSources) => {
  const explicitBackup = args.values.get("backup") ?? args.positional[0];

  if (explicitBackup) {
    return resolveCliPath(explicitBackup);
  }

  if (args.flags.has("latest")) {
    return findLatestBackupDir(sources.backupRoot);
  }

  throw new Error("请通过 --backup <目录> 指定备份，或使用 --latest 选择最新备份。");
};

const printValidationResult = (title: string, result: ValidationResult) => {
  console.log(title);

  for (const [key, value] of Object.entries(result.summary)) {
    console.log(`- ${key}: ${value}`);
  }

  if (result.warnings.length > 0) {
    console.warn("警告：");

    for (const warning of result.warnings) {
      console.warn(`- ${warning}`);
    }
  }
};

const pruneBackups = (backupRoot: string, keep: number, protectedDir: string) => {
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(backupRoot, entry.name))
    .filter((dir) => existsSync(join(dir, MANIFEST_FILE_NAME)))
    .sort((left, right) => right.localeCompare(left));

  const protectedPath = normalizeForCompare(protectedDir);
  const retained = new Set(
    [
      protectedDir,
      ...candidates.filter((dir) => normalizeForCompare(dir) !== protectedPath)
    ]
      .slice(0, keep)
      .map(normalizeForCompare)
  );
  const removable = candidates.filter((dir) => !retained.has(normalizeForCompare(dir)));

  for (const dir of removable) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`已清理旧备份：${formatPath(dir)}`);
  }
};

const createBackup = async (
  args: ParsedArgs,
  options: {
    label?: string;
    skipPrune?: boolean;
  } = {}
) => {
  const sources = getRuntimeSources(args);
  assertBackupRootIsSafe(sources);
  const liveStoreValidation = validateStoreFile(sources.dataFile);
  assertNoValidationErrors(liveStoreValidation, "当前业务数据");

  const liveSystemLogValidation = await validateSystemLogFile(sources.systemLogFile);
  const liveValidation = mergeValidationResults(liveStoreValidation, liveSystemLogValidation);
  const label = sanitizeLabel(options.label ?? args.values.get("label"));
  const backupDirName = [createTimestamp(), label].filter(Boolean).join("-");
  const backupDir = join(sources.backupRoot, backupDirName);

  if (existsSync(backupDir)) {
    throw new Error(`备份目录已存在：${backupDir}`);
  }

  mkdirSync(backupDir, { recursive: true });

  try {
    const items: BackupItem[] = [];
    items.push(await copyFileForBackup(backupDir, sources.dataFile, "store.json", "store", true));

    const hasSystemLog = existsSync(sources.systemLogFile);

    if (hasSystemLog) {
      items.push(
        await copyFileForBackup(backupDir, sources.systemLogFile, "system-audit.ndjson", "systemLog", true)
      );
    }

    const uploadsBackupDir = join(backupDir, "uploads");
    const hasUploads = existsSync(sources.uploadDir);

    if (hasUploads) {
      if (!lstatSync(sources.uploadDir).isDirectory()) {
        throw new Error(`UPLOAD_DIR 不是目录：${sources.uploadDir}`);
      }

      mkdirSync(uploadsBackupDir, { recursive: true });

      for (const relativePath of listFilesRecursive(sources.uploadDir)) {
        const sourcePath = resolve(sources.uploadDir, ...relativePath.split("/"));
        const backupPath = `uploads/${relativePath}`;
        items.push(await copyFileForBackup(backupDir, sourcePath, backupPath, "upload", true));
      }
    }

    const copiedStoreValidation = validateStoreFile(join(backupDir, "store.json"));
    assertNoValidationErrors(copiedStoreValidation, "备份业务数据");

    const manifest: RuntimeBackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      label,
      source: {
        apiDataFile: sources.dataFile,
        systemLogFile: sources.systemLogFile,
        uploadDir: sources.uploadDir
      },
      included: {
        store: true,
        systemLog: hasSystemLog,
        uploads: hasUploads
      },
      validation: {
        summary: copiedStoreValidation.summary,
        warnings: [...liveValidation.warnings, ...copiedStoreValidation.warnings]
      },
      items
    };

    writeFileSync(join(backupDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const backupValidation = await verifyBackupDirectory(backupDir);
    assertNoValidationErrors(backupValidation, "备份文件");

    if (!options.skipPrune) {
      const keep = readPositiveIntegerOption(args, "keep");

      if (keep !== undefined) {
        pruneBackups(sources.backupRoot, keep, backupDir);
      }
    }

    console.log(`运行数据备份完成：${formatPath(backupDir)}`);
    console.log("备份包含业务数据、系统审计日志和上传文件；请按生产数据保护该目录。");
    printValidationResult("备份校验摘要：", backupValidation);
    return backupDir;
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
};

const runVerify = async (args: ParsedArgs) => {
  const sources = getRuntimeSources(args);

  if (args.values.has("backup") || args.flags.has("latest") || args.positional[0]) {
    const backupDir = resolveBackupSelection(args, sources);
    const result = await verifyBackupDirectory(backupDir);
    assertNoValidationErrors(result, "备份文件");
    console.log(`备份校验通过：${formatPath(backupDir)}`);
    printValidationResult("备份摘要：", result);
    return;
  }

  const storeValidation = validateStoreFile(sources.dataFile);
  const systemLogValidation = await validateSystemLogFile(sources.systemLogFile);
  const result = mergeValidationResults(storeValidation, systemLogValidation);
  assertNoValidationErrors(result, "当前运行数据");
  console.log(`运行数据校验通过：${formatPath(sources.dataFile)}`);
  printValidationResult("当前数据摘要：", result);
};

interface StagedReplacement {
  targetPath: string;
  stagingPath: string;
}

const createSiblingTemporaryPath = (targetPath: string, purpose: "staging" | "rollback") =>
  join(
    dirname(targetPath),
    `.${basename(targetPath)}.${purpose}-${process.pid}-${randomUUID()}.tmp`
  );

const assertRestoreTargetType = (targetPath: string, expectedType: "file" | "directory") => {
  if (!existsSync(targetPath)) {
    return;
  }

  const targetStat = lstatSync(targetPath);

  if (targetStat.isSymbolicLink()) {
    throw new Error(`恢复目标不能是符号链接：${targetPath}`);
  }

  const matches = expectedType === "file" ? targetStat.isFile() : targetStat.isDirectory();

  if (!matches) {
    throw new Error(`恢复目标类型不正确：${targetPath}`);
  }
};

const assertStagedFileMatchesManifest = async (
  stagedPath: string,
  item: BackupItem
) => {
  const stagedStat = lstatSync(stagedPath);
  const stagedHash = stagedStat.isFile()
    ? await sha256File(stagedPath)
    : "";

  if (
    !stagedStat.isFile() ||
    stagedStat.isSymbolicLink() ||
    stagedStat.size !== item.bytes ||
    stagedHash !== item.sha256
  ) {
    throw new Error(
      `恢复暂存文件与备份清单不一致：${normalizeRelativePath(item.backupPath)}`
    );
  }
};

const stageRestoreFile = async (
  backupDir: string,
  item: BackupItem,
  targetPath: string
): Promise<StagedReplacement> => {
  const sourcePath = assertRegularBackupFile(backupDir, item.backupPath);
  assertRestoreTargetType(targetPath, "file");
  mkdirSync(dirname(targetPath), { recursive: true });
  const stagingPath = createSiblingTemporaryPath(targetPath, "staging");
  let fileDescriptor: number | undefined;

  try {
    copyFileSync(sourcePath, stagingPath);
    fileDescriptor = openSync(stagingPath, "r+");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    await assertStagedFileMatchesManifest(stagingPath, item);
    return {
      targetPath,
      stagingPath
    };
  } catch (error) {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }

    if (existsSync(stagingPath)) {
      unlinkSync(stagingPath);
    }

    throw error;
  }
};

const stageRestoreDirectory = async (
  sourceDir: string,
  targetDir: string,
  uploadItems: BackupItem[]
): Promise<StagedReplacement> => {
  assertRestoreTargetType(targetDir, "directory");
  mkdirSync(dirname(targetDir), { recursive: true });
  const stagingPath = createSiblingTemporaryPath(targetDir, "staging");

  try {
    copyDirectoryContents(sourceDir, stagingPath);
    const expectedItems = new Map<string, BackupItem>();

    for (const item of uploadItems) {
      const normalizedPath = normalizeRelativePath(item.backupPath);
      const relativeUploadPath = normalizedPath.startsWith("uploads/")
        ? normalizedPath.slice("uploads/".length)
        : "";

      if (!relativeUploadPath) {
        throw new Error(`备份清单包含非法上传路径：${normalizedPath}`);
      }
      expectedItems.set(relativeUploadPath, item);
    }

    const actualPaths = listFilesRecursive(stagingPath);
    const unexpectedPath = actualPaths.find(
      (relativePath) => !expectedItems.has(relativePath)
    );
    const missingPath = [...expectedItems.keys()].find(
      (relativePath) => !actualPaths.includes(relativePath)
    );

    if (unexpectedPath || missingPath) {
      throw new Error(
        `恢复暂存上传目录与备份清单不一致：${
          unexpectedPath ?? missingPath
        }`
      );
    }

    for (const [relativePath, item] of expectedItems) {
      await assertStagedFileMatchesManifest(
        safeBackupPath(stagingPath, relativePath),
        item
      );
    }
    return {
      targetPath: targetDir,
      stagingPath
    };
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
};

const commitStagedReplacements = (replacements: StagedReplacement[]) => {
  const committed: Array<StagedReplacement & { rollbackPath?: string }> = [];

  try {
    for (const replacement of replacements) {
      const rollbackPath = existsSync(replacement.targetPath)
        ? createSiblingTemporaryPath(replacement.targetPath, "rollback")
        : undefined;

      if (rollbackPath) {
        renameSync(replacement.targetPath, rollbackPath);
      }

      try {
        renameSync(replacement.stagingPath, replacement.targetPath);
      } catch (error) {
        if (rollbackPath && existsSync(rollbackPath)) {
          renameSync(rollbackPath, replacement.targetPath);
        }

        throw error;
      }

      committed.push({
        ...replacement,
        rollbackPath
      });
    }
  } catch (error) {
    for (const replacement of [...committed].reverse()) {
      rmSync(replacement.targetPath, { recursive: true, force: true });

      if (replacement.rollbackPath && existsSync(replacement.rollbackPath)) {
        renameSync(replacement.rollbackPath, replacement.targetPath);
      }
    }

    throw error;
  } finally {
    for (const replacement of replacements) {
      rmSync(replacement.stagingPath, { recursive: true, force: true });
    }
  }

  for (const replacement of committed) {
    if (replacement.rollbackPath) {
      rmSync(replacement.rollbackPath, { recursive: true, force: true });
    }
  }
};

const assertRestoreSelectionIsSafe = (sources: RuntimeSources, backupDir: string) => {
  const targets = [sources.dataFile, sources.systemLogFile, sources.uploadDir];

  for (const target of targets) {
    if (isSameOrInside(target, backupDir) || isSameOrInside(backupDir, target)) {
      throw new Error(`恢复目标与备份目录不能重叠：${target}`);
    }
  }

  if (normalizeForCompare(sources.dataFile) === normalizeForCompare(sources.systemLogFile)) {
    throw new Error("API_DATA_FILE 与 SYSTEM_LOG_FILE 不能指向同一文件。");
  }

  for (const filePath of [sources.dataFile, sources.systemLogFile]) {
    if (isSameOrInside(filePath, sources.uploadDir) || isSameOrInside(sources.uploadDir, filePath)) {
      throw new Error(`运行数据文件不能与 UPLOAD_DIR 重叠：${filePath}`);
    }
  }
};

const runRestoreWithLease = async (
  args: ParsedArgs,
  financialWriterLease: FinancialSingleWriterLease
) => {
  if (!args.flags.has("yes")) {
    throw new Error("恢复会覆盖当前运行数据。确认已停止 API 后，请追加 --yes。");
  }

  const sources = getRuntimeSources(args);
  const backupDir = resolveBackupSelection(args, sources);
  assertRestoreSelectionIsSafe(sources, backupDir);
  const backupValidation = await verifyBackupDirectory(backupDir);
  assertNoValidationErrors(backupValidation, "待恢复备份");

  if (!args.flags.has("no-safety-backup") && existsSync(sources.dataFile)) {
    const safetyArgs = parseArgs(
      args.values.has("backup-dir") ? ["--backup-dir", args.values.get("backup-dir") ?? ""] : []
    );
    const label = `pre-restore-${createTimestamp()}`;
    const safetyBackup = await createBackup(safetyArgs, {
      label,
      skipPrune: true
    });
    console.log(`恢复前安全备份已创建：${formatPath(safetyBackup)}`);
  }

  const manifest = readManifest(backupDir);
  const storeItem = manifest.items.find((item) => item.key === "store");

  if (!storeItem) {
    throw new Error("备份缺少业务数据文件，无法恢复。");
  }

  const replacements: StagedReplacement[] = [
    await stageRestoreFile(backupDir, storeItem, sources.dataFile)
  ];

  if (!args.flags.has("skip-system-log")) {
    const systemLogItem = manifest.items.find((item) => item.key === "systemLog");

    if (systemLogItem) {
      replacements.push(
        await stageRestoreFile(
          backupDir,
          systemLogItem,
          sources.systemLogFile
        )
      );
    } else {
      console.warn("备份中没有系统审计日志，已跳过 SYSTEM_LOG_FILE。");
    }
  }

  if (!args.flags.has("skip-uploads") && manifest.included.uploads) {
    const backupUploadsDir = join(backupDir, "uploads");
    replacements.push(
      await stageRestoreDirectory(
        backupUploadsDir,
        sources.uploadDir,
        manifest.items.filter((item) => item.key === "upload")
      )
    );
  }

  financialWriterLease.runWithFence(() => {
    commitStagedReplacements(replacements);
  });

  const restoredValidation = mergeValidationResults(
    validateStoreFile(sources.dataFile),
    await validateSystemLogFile(sources.systemLogFile)
  );
  assertNoValidationErrors(restoredValidation, "恢复后的运行数据");

  console.log(`运行数据已恢复自：${formatPath(backupDir)}`);
  console.log("请重新启动 API 服务，让内存仓储重新加载恢复后的文件。");
  printValidationResult("恢复后摘要：", restoredValidation);
};

const runRestore = async (args: ParsedArgs) => {
  if (!args.flags.has("yes")) {
    throw new Error("恢复会覆盖当前运行数据。确认后请追加 --yes。");
  }

  const financialWriter = acquireFinancialSingleWriterForMaintenance();
  try {
    await runRestoreWithLease(args, financialWriter.lease);
  } finally {
    financialWriter.release();
  }
};

const printHelp = () => {
  console.log(`运行数据维护命令：

备份：
  npm run data:backup --workspace @vm/api -- --label daily --keep 30

校验当前数据：
  npm run data:verify --workspace @vm/api

校验最新备份：
  npm run data:verify --workspace @vm/api -- --latest

恢复：
  npm run data:restore --workspace @vm/api -- --backup <备份目录> --yes
  npm run data:restore --workspace @vm/api -- --latest --yes

常用选项：
  --backup-dir <目录>       覆盖 API_BACKUP_DIR
  --label <标签>            备份目录名后缀
  --keep <数量>             备份后只保留最近 N 份
  --latest                  使用 API_BACKUP_DIR 中最新备份
  --skip-system-log         恢复时不覆盖系统审计日志
  --skip-uploads            恢复时不覆盖上传目录
  --no-safety-backup        恢复前不创建当前数据安全备份
  --yes                     确认执行恢复
`);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "backup":
      await createBackup(args);
      return;
    case "verify":
      await runVerify(args);
      return;
    case "restore":
      await runRestore(args);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`未知命令：${command}`);
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
