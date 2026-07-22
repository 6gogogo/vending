import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
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
  resolveFinancialSingleWriterLeaseFile,
  resolveSystemLogFile,
  resolveUploadDir,
  writePersistedState
} from "../common/store/persistence.js";
import { createDurablePathSynchronizer } from "../common/store/durable-path-sync.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import {
  type PersistedStateValidationResult,
  validatePersistedStateFile
} from "../common/store/persisted-state-integrity.js";
import {
  analyseRuntimeDataRepair,
  applyApprovedRuntimeDataRepair,
  type RuntimeDataRepairAnalysis
} from "../common/store/runtime-data-repair.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import type { FinancialSingleWriterLease } from "../common/coordination/financial-single-writer-lease.js";

const MANIFEST_FILE_NAME = "runtime-backup-manifest.json";
const BACKUP_SCHEMA_VERSION = 1;
const PRIVATE_BACKUP_DIRECTORY_MODE = 0o700;
const PRIVATE_BACKUP_FILE_MODE = 0o600;
const backupPathSynchronizer = createDurablePathSynchronizer();

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
    systemLog: true;
    uploads: boolean;
  };
  validation: {
    summary: Record<string, number>;
    warnings: string[];
  };
  items: BackupItem[];
}

type ValidationResult = PersistedStateValidationResult;

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

const getRuntimeSources = (args: ParsedArgs): RuntimeSources => {
  const sources: RuntimeSources = {
    dataFile: resolveApiDataFile(),
    systemLogFile: resolveSystemLogFile(),
    uploadDir: resolveUploadDir(),
    backupRoot: args.values.has("backup-dir")
      ? resolveCliPath(args.values.get("backup-dir") ?? "")
      : resolveApiBackupDir()
  };
  assertRuntimePathsSafe({
    dataFile: sources.dataFile,
    systemLogFile: sources.systemLogFile,
    uploadDir: sources.uploadDir,
    backupDir: sources.backupRoot,
    financialLeaseFile: resolveFinancialSingleWriterLeaseFile()
  });

  return sources;
};

const sanitizeLabel = (label?: string) => {
  const normalized = (label ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
};

const createTimestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const validateStoreFile = (filePath: string): ValidationResult =>
  validatePersistedStateFile(filePath);

const sha256Content = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

const readRepairSource = (filePath: string) => {
  if (!existsSync(filePath)) {
    throw new Error("未找到业务数据文件。");
  }

  const raw = readFileSync(filePath);
  const serialized = raw.toString("utf8");

  try {
    return {
      serialized,
      sha256: sha256Content(raw),
      state: JSON.parse(serialized) as unknown
    };
  } catch {
    throw new Error("业务数据 JSON 解析失败。");
  }
};

const printRepairAnalysis = (sha256: string, analysis: RuntimeDataRepairAnalysis) => {
  console.log("运行数据修复计划：");
  console.log(`- sourceSha256: ${sha256}`);
  console.log(
    `- malformedGoods: detected=${analysis.malformedGoods.detected}, eligible=${analysis.malformedGoods.eligible}, blocked=${analysis.malformedGoods.blocked}`
  );
  console.log(
    `- zeroQuantityInventory: detected=${analysis.zeroQuantityInventory.detected}, eligible=${analysis.zeroQuantityInventory.eligible}, blocked=${analysis.zeroQuantityInventory.blocked}`
  );
  console.log(
    `- orphanMerchantTemplates: detected=${analysis.orphanMerchantTemplates.detected}, eligible=${analysis.orphanMerchantTemplates.eligible}, blocked=${analysis.orphanMerchantTemplates.blocked}`
  );
  console.log(
    `- manualRequiredCredentialDuplicateGroups: ${analysis.manualRequiredCredentialDuplicateGroups}`
  );
  console.log(`- initialValidationErrorCount: ${analysis.initialValidationErrorCount}`);
  console.log(`- remainingValidationErrorCount: ${analysis.remainingValidationErrorCount}`);
  console.log(`- canApply: ${analysis.canApply ? "yes" : "no"}`);
};

const runRepair = async (args: ParsedArgs) => {
  if (args.positional.length > 0) {
    throw new Error("repair 不接受位置参数。");
  }

  const apply = args.flags.has("apply");
  const expectedSha256 = args.values.get("source-sha256")?.trim().toLowerCase();

  if (!apply && expectedSha256 !== undefined) {
    throw new Error("--source-sha256 只能与 --apply 一起使用。");
  }

  if (apply && !expectedSha256) {
    throw new Error("执行修复必须同时提供 --apply 和 --source-sha256。");
  }

  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("--source-sha256 必须是 64 位十六进制摘要。");
  }

  const sources = getRuntimeSources(args);

  if (!apply) {
    const source = readRepairSource(sources.dataFile);
    printRepairAnalysis(source.sha256, analyseRuntimeDataRepair(source.state));
    return;
  }

  const financialWriter = acquireFinancialSingleWriterForMaintenance();
  try {
    const source = readRepairSource(sources.dataFile);

    if (source.sha256 !== expectedSha256) {
      throw new Error("源数据摘要与修复计划不一致，请重新执行 dry-run。");
    }

    const analysis = analyseRuntimeDataRepair(source.state);
    printRepairAnalysis(source.sha256, analysis);

    if (!analysis.canApply) {
      throw new Error("运行数据修复计划仍含需人工处理或无法证明安全的问题，已拒绝写入。");
    }

    const repaired = applyApprovedRuntimeDataRepair(source.state);

    if (!repaired.changed) {
      console.log("运行数据无需自动修复。");
      return;
    }

    writePersistedState(repaired.state);
    const verification = validateStoreFile(sources.dataFile);
    assertNoValidationErrors(verification, "修复后的运行数据");
    console.log("运行数据修复完成。");
    printValidationResult("修复后摘要：", verification);
  } finally {
    financialWriter.release();
  }
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
    result.errors.push(`未找到系统审计日志：${filePath}`);
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
    } catch {
      result.errors.push(`系统审计日志第 ${lineNumber} 行不是合法 JSON。`);

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
  required: boolean,
  assertLeaseHeld: () => void
): Promise<BackupItem> => {
  assertLeaseHeld();
  const targetPath = safeBackupPath(backupDir, backupPath);
  mkdirSync(dirname(targetPath), {
    recursive: true,
    mode: PRIVATE_BACKUP_DIRECTORY_MODE
  });
  copyFileSync(sourcePath, targetPath);
  chmodSync(targetPath, PRIVATE_BACKUP_FILE_MODE);
  backupPathSynchronizer.syncFile(targetPath);
  backupPathSynchronizer.syncDirectoryAndAncestors(dirname(targetPath), backupDir);
  assertLeaseHeld();

  const stat = statSync(targetPath);
  const sha256 = await sha256File(targetPath);
  assertLeaseHeld();

  return {
    key,
    backupPath,
    sourcePath,
    bytes: stat.size,
    sha256,
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
  mkdirSync(targetDir, {
    recursive: true,
    mode: PRIVATE_BACKUP_DIRECTORY_MODE
  });

  for (const relativePath of listFilesRecursive(sourceDir)) {
    const sourcePath = resolve(sourceDir, ...relativePath.split("/"));
    const targetPath = resolve(targetDir, ...relativePath.split("/"));
    mkdirSync(dirname(targetPath), {
      recursive: true,
      mode: PRIVATE_BACKUP_DIRECTORY_MODE
    });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, PRIVATE_BACKUP_FILE_MODE);
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

  if (parsed.included.systemLog !== true) {
    throw new Error("备份清单必须包含系统审计日志，不能用于恢复或发布校验。");
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

  if (systemLogItems.length !== 1) {
    throw new Error("备份清单必须且只能包含一份系统审计日志文件。");
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

  if (!systemLogItem) {
    throw new Error("备份缺少系统审计日志文件。");
  }

  const systemLogValidation = await validateSystemLogFile(
    assertRegularBackupFile(backupDir, systemLogItem.backupPath)
  );

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
  } = {},
  financialWriterLease: FinancialSingleWriterLease
) => {
  const assertLeaseHeld = () => financialWriterLease.assertHeld();
  assertLeaseHeld();
  const sources = getRuntimeSources(args);
  assertBackupRootIsSafe(sources);
  const liveStoreValidation = validateStoreFile(sources.dataFile);
  assertNoValidationErrors(liveStoreValidation, "当前业务数据");

  const liveSystemLogValidation = await validateSystemLogFile(sources.systemLogFile);
  assertLeaseHeld();
  const liveValidation = mergeValidationResults(liveStoreValidation, liveSystemLogValidation);
  assertNoValidationErrors(liveValidation, "当前运行数据");
  const label = sanitizeLabel(options.label ?? args.values.get("label"));
  const backupDirName = [createTimestamp(), label].filter(Boolean).join("-");
  const backupDir = join(sources.backupRoot, backupDirName);

  if (existsSync(backupDir)) {
    throw new Error(`备份目录已存在：${backupDir}`);
  }

  mkdirSync(backupDir, {
    recursive: true,
    mode: PRIVATE_BACKUP_DIRECTORY_MODE
  });
  backupPathSynchronizer.syncDirectory(dirname(sources.backupRoot));
  backupPathSynchronizer.syncDirectoryAndAncestors(backupDir, sources.backupRoot);

  try {
    const items: BackupItem[] = [];
    items.push(
      await copyFileForBackup(
        backupDir,
        sources.dataFile,
        "store.json",
        "store",
        true,
        assertLeaseHeld
      )
    );
    assertLeaseHeld();

    items.push(
      await copyFileForBackup(
        backupDir,
        sources.systemLogFile,
        "system-audit.ndjson",
        "systemLog",
        true,
        assertLeaseHeld
      )
    );
    assertLeaseHeld();

    const uploadsBackupDir = join(backupDir, "uploads");
    const hasUploads = existsSync(sources.uploadDir);

    if (hasUploads) {
      if (!lstatSync(sources.uploadDir).isDirectory()) {
        throw new Error(`UPLOAD_DIR 不是目录：${sources.uploadDir}`);
      }

      mkdirSync(uploadsBackupDir, {
        recursive: true,
        mode: PRIVATE_BACKUP_DIRECTORY_MODE
      });
      backupPathSynchronizer.syncDirectoryAndAncestors(uploadsBackupDir, backupDir);

      for (const relativePath of listFilesRecursive(sources.uploadDir)) {
        assertLeaseHeld();
        const sourcePath = resolve(sources.uploadDir, ...relativePath.split("/"));
        const backupPath = `uploads/${relativePath}`;
        items.push(
          await copyFileForBackup(
            backupDir,
            sourcePath,
            backupPath,
            "upload",
            true,
            assertLeaseHeld
          )
        );
        assertLeaseHeld();
      }
    }

    const copiedStoreValidation = validateStoreFile(join(backupDir, "store.json"));
    assertLeaseHeld();
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
        systemLog: true,
        uploads: hasUploads
      },
      validation: {
        summary: copiedStoreValidation.summary,
        warnings: [...liveValidation.warnings, ...copiedStoreValidation.warnings]
      },
      items
    };

    const manifestPath = join(backupDir, MANIFEST_FILE_NAME);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_BACKUP_FILE_MODE
    });
    backupPathSynchronizer.syncFile(manifestPath);
    backupPathSynchronizer.syncDirectoryAndAncestors(dirname(manifestPath), backupDir);
    assertLeaseHeld();

    const backupValidation = await verifyBackupDirectory(backupDir);
    assertLeaseHeld();
    assertNoValidationErrors(backupValidation, "备份文件");

    if (!options.skipPrune) {
      const keep = readPositiveIntegerOption(args, "keep");

      if (keep !== undefined) {
        assertLeaseHeld();
        pruneBackups(sources.backupRoot, keep, backupDir);
        assertLeaseHeld();
      }
    }

    assertLeaseHeld();
    console.log(`运行数据备份完成：${formatPath(backupDir)}`);
    console.log("备份包含业务数据、系统审计日志和上传文件；请按生产数据保护该目录。");
    printValidationResult("备份校验摘要：", backupValidation);
    return backupDir;
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
};

const runBackup = async (args: ParsedArgs) => {
  // 备份必须与 API 写入竞争同一租约；在线复制无法证明 store、审计和上传文件属于同一时点。
  const financialWriter = acquireFinancialSingleWriterForMaintenance();
  try {
    await createBackup(args, {}, financialWriter.lease);
  } finally {
    financialWriter.release();
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
  mkdirSync(dirname(targetPath), {
    recursive: true,
    mode: PRIVATE_BACKUP_DIRECTORY_MODE
  });
  const stagingPath = createSiblingTemporaryPath(targetPath, "staging");
  let fileDescriptor: number | undefined;

  try {
    copyFileSync(sourcePath, stagingPath);
    chmodSync(stagingPath, PRIVATE_BACKUP_FILE_MODE);
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
  mkdirSync(dirname(targetDir), {
    recursive: true,
    mode: PRIVATE_BACKUP_DIRECTORY_MODE
  });
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
    const safetyBackup = await createBackup(
      safetyArgs,
      {
        label,
        skipPrune: true
      },
      financialWriterLease
    );
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

修复计划（默认只读）：
  npm run data:repair --workspace @vm/api
  npm run data:repair --workspace @vm/api -- --apply --source-sha256 <64位摘要>

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
      await runBackup(args);
      return;
    case "verify":
      await runVerify(args);
      return;
    case "restore":
      await runRestore(args);
      return;
    case "repair":
      await runRepair(args);
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
