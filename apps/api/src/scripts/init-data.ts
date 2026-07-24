import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import {
  createSeededPersistedState,
  resolveRuntimeStoragePaths,
  writePersistedState
} from "../common/store/persistence.js";
import { isProductionRuntime } from "../common/config/runtime-environment.js";
import {
  resolveRuntimeDataPlane,
  resolveRuntimeDataPlaneInstanceId
} from "../common/config/runtime-data-plane.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { assertSimulationDataPlaneIsEmptyForInitialization } from "../common/store/runtime-evidence-guard.js";

const runtimePaths = resolveRuntimeStoragePaths();
const dataFile = runtimePaths.dataFile;
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
  console.error("已阻止覆盖业务数据。确需重置为测试种子时，请显式追加 --confirm-reset。");
  console.error(`目标数据文件：${dataFile}`);
  process.exit(2);
}

if (dataPlane === "live") {
  console.error("真实数据平面禁止写入测试种子。请使用受控的真实初始化命令创建纯净库。");
  process.exit(2);
}

const productionConfirmation = readOption("confirm-production-data-file");

if (isProductionRuntime() && normalizePath(productionConfirmation ?? "") !== normalizePath(dataFile)) {
  console.error("已阻止在生产环境重置业务数据。确需执行时，还必须逐字确认目标数据文件。");
  console.error(`请追加：--confirm-production-data-file="${dataFile}"`);
  process.exit(2);
}

if (existsSync(dataFile)) {
  const targetStat = lstatSync(dataFile);

  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`目标数据文件必须是普通文件，不能是目录或符号链接：${dataFile}`);
  }
}

assertSimulationDataPlaneIsEmptyForInitialization(runtimePaths);

const financialWriter = acquireFinancialSingleWriterForMaintenance();
try {
  writePersistedState(createSeededPersistedState(resolveRuntimeDataPlaneInstanceId()));
} finally {
  financialWriter.release();
}

console.log(`后端测试数据已初始化：${dataFile}`);
