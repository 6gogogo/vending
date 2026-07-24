import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  createEmptyPersistedState,
  resolveApiWorkspaceRoot,
  resolveRuntimeStoragePaths,
  writePersistedState
} from "../common/store/persistence.js";
import { isProductionRuntime } from "../common/config/runtime-environment.js";
import { resolveRuntimeDataPlane } from "../common/config/runtime-data-plane.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { assertSimulationDataPlaneIsEmptyForInitialization } from "../common/store/runtime-evidence-guard.js";

const runtimePaths = resolveRuntimeStoragePaths();
const dataFileTarget = runtimePaths.dataFile;
const systemLogFile = runtimePaths.systemLogFile;
const uploadDir = runtimePaths.uploadDir;
const apiWorkspaceRoot = resolveApiWorkspaceRoot();
const dataPlane = resolveRuntimeDataPlane();

assertRuntimePathsSafe({
  dataFile: runtimePaths.dataFile,
  systemLogFile: runtimePaths.systemLogFile,
  uploadDir: runtimePaths.uploadDir,
  backupDir: runtimePaths.backupDir,
  financialLeaseFile: runtimePaths.financialLeaseFile
});

const normalizePath = (path: string) => {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isSameOrInside = (childPath: string, parentPath: string) => {
  const child = normalizePath(childPath);
  const parent = normalizePath(parentPath);

  if (child === parent) {
    return true;
  }

  const relativePath = relative(parent, child);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
};

const readOption = (name: string) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

if (!process.argv.includes("--confirm-reset")) {
  console.error("已阻止清空业务数据、系统审计日志和上传目录。确需执行时，请显式追加 --confirm-reset。");
  console.error(`目标数据文件：${dataFileTarget}`);
  console.error(`目标系统日志：${systemLogFile}`);
  console.error(`目标上传目录：${uploadDir}`);
  process.exit(2);
}

if (dataPlane === "live") {
  console.error("真实数据平面不能使用通用清空命令；请使用受控的真实初始化/恢复流程。 ");
  process.exit(2);
}

const keepUploads = process.argv.includes("--keep-uploads");

const productionConfirmation = readOption("confirm-production-data-file");

if (isProductionRuntime() && normalizePath(productionConfirmation ?? "") !== normalizePath(dataFileTarget)) {
  console.error("已阻止在生产环境清空运行数据。确需执行时，还必须逐字确认目标数据文件。");
  console.error(`请追加：--confirm-production-data-file="${dataFileTarget}"`);
  process.exit(2);
}

if (normalizePath(dataFileTarget) === normalizePath(systemLogFile)) {
  throw new Error("API_DATA_FILE 与 SYSTEM_LOG_FILE 不能指向同一文件。");
}

for (const filePath of [dataFileTarget, systemLogFile]) {
  if (isSameOrInside(filePath, uploadDir) || isSameOrInside(uploadDir, filePath)) {
    throw new Error(`UPLOAD_DIR 不能与运行数据文件重叠：${filePath}`);
  }
}

if (existsSync(uploadDir)) {
  const uploadStat = lstatSync(uploadDir);

  if (uploadStat.isSymbolicLink() || !uploadStat.isDirectory()) {
    throw new Error(`UPLOAD_DIR 必须是普通目录，不能是文件或符号链接：${uploadDir}`);
  }
}

if (!keepUploads && (dirname(resolve(uploadDir)) === resolve(uploadDir) || isSameOrInside(apiWorkspaceRoot, uploadDir))) {
  throw new Error(`拒绝清空文件系统根目录、API 工作区或其父目录：${uploadDir}`);
}

for (const filePath of [dataFileTarget, systemLogFile]) {
  if (!existsSync(filePath)) {
    continue;
  }

  const fileStat = lstatSync(filePath);

  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`运行数据目标必须是普通文件，不能是目录或符号链接：${filePath}`);
  }
}

assertSimulationDataPlaneIsEmptyForInitialization(runtimePaths);

const financialWriter = acquireFinancialSingleWriterForMaintenance();
let dataFile: string;
try {
  dataFile = writePersistedState(createEmptyPersistedState(dataPlane));
  mkdirSync(dirname(systemLogFile), { recursive: true, mode: 0o700 });
  writeFileSync(systemLogFile, "", { encoding: "utf8", mode: 0o600 });
  chmodSync(systemLogFile, 0o600);

  if (!keepUploads && existsSync(uploadDir)) {
    rmSync(uploadDir, { recursive: true, force: true });
  }

  mkdirSync(uploadDir, { recursive: true });
} finally {
  financialWriter.release();
}

console.log(`后端业务数据已完全清空并初始化为空库：${dataFile}`);
console.log("API 服务重新启动后，会自动补建默认超级管理员账号：admin / admin");
console.log(`系统审计日志已清空：${systemLogFile}`);
console.log(keepUploads ? `上传目录已保留：${uploadDir}` : `上传目录已清空并重建：${uploadDir}`);
console.log(`当前 API_DATA_FILE：${dataFileTarget}`);
