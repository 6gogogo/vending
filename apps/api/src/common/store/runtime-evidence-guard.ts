import { existsSync, lstatSync, readdirSync } from "node:fs";

import type { RuntimeStoragePaths } from "./persistence.js";

const assertRegularFile = (filePath: string, label: string) => {
  const stat = lstatSync(filePath);

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} 必须是普通文件，不能是目录或符号链接。`);
  }

  return stat;
};

const assertRegularDirectory = (directoryPath: string, label: string) => {
  const stat = lstatSync(directoryPath);

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} 必须是普通目录，不能是文件或符号链接。`);
  }

  return stat;
};

/**
 * 测试数据的重置命令只能初始化全新目标，绝不以“有效”或“可解析”为由覆盖已有证据。
 * 历史数据如需继续使用，应走同一平面的备份/恢复或新建 VM_DATA_PLANE_ID，而不是原地重置。
 */
export const assertSimulationDataPlaneIsEmptyForInitialization = (
  paths: RuntimeStoragePaths
) => {
  const evidence: string[] = [];

  if (existsSync(paths.dataFile)) {
    assertRegularFile(paths.dataFile, "API_DATA_FILE");
    evidence.push("业务数据文件");
  }

  if (existsSync(paths.systemLogFile)) {
    const systemLog = assertRegularFile(paths.systemLogFile, "SYSTEM_LOG_FILE");

    if (systemLog.size > 0) {
      evidence.push("系统审计日志");
    }
  }

  for (const [directoryPath, label] of [
    [paths.uploadDir, "UPLOAD_DIR"],
    [paths.backupDir, "API_BACKUP_DIR"]
  ] as const) {
    if (!existsSync(directoryPath)) {
      continue;
    }

    assertRegularDirectory(directoryPath, label);

    if (readdirSync(directoryPath).length > 0) {
      evidence.push(label === "UPLOAD_DIR" ? "上传目录" : "备份目录");
    }
  }

  if (existsSync(paths.financialLeaseFile)) {
    assertRegularFile(paths.financialLeaseFile, "FINANCIAL_SINGLE_WRITER_LEASE_FILE");
    evidence.push("金融单写租约文件");
  }

  if (evidence.length > 0) {
    throw new Error(
      `目标模拟数据平面已包含${evidence.join("、")}，已拒绝覆盖审计证据。请新建 VM_DATA_PLANE_ID/数据根，或使用受控备份恢复。`
    );
  }
};
