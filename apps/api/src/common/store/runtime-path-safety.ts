import { lstatSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface RuntimePaths {
  dataFile: string;
  systemLogFile: string;
  uploadDir: string;
  backupDir: string;
  financialLeaseFile: string;
}

interface RuntimePathFileSystem {
  lstatSync: (path: string) => {
    isSymbolicLink: () => boolean;
  };
}

const nodeRuntimePathFileSystem: RuntimePathFileSystem = {
  lstatSync
};

const isSameOrInside = (candidatePath: string, parentPath: string) => {
  const normalizedCandidate = resolve(candidatePath);
  const normalizedParent = resolve(parentPath);

  if (normalizedCandidate === normalizedParent) {
    return true;
  }

  const pathFromParent = relative(normalizedParent, normalizedCandidate);
  return Boolean(pathFromParent) && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
};

const assertNotOverlapping = (
  leftKey: string,
  leftPath: string,
  rightKey: string,
  rightPath: string
) => {
  if (isSameOrInside(leftPath, rightPath) || isSameOrInside(rightPath, leftPath)) {
    throw new Error(`${leftKey} 不能与 ${rightKey} 重叠。`);
  }
};

const assertNoSymbolicLinkInExistingPath = (
  targetPath: string,
  label: string,
  fileSystem: RuntimePathFileSystem
) => {
  const resolvedTarget = resolve(targetPath);
  const parsedTarget = parse(resolvedTarget);
  const segments = resolvedTarget.slice(parsedTarget.root.length).split(sep).filter(Boolean);
  let currentPath = parsedTarget.root;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = join(currentPath, segments[index]!);
    let stat: ReturnType<RuntimePathFileSystem["lstatSync"]>;

    try {
      stat = fileSystem.lstatSync(currentPath);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") {
        return;
      }

      throw new Error(`${label} 路径无法完成安全检查。`);
    }

    if (stat.isSymbolicLink()) {
      const isTarget = index === segments.length - 1;
      throw new Error(
        isTarget
          ? `${label} 目标不能是符号链接。`
          : `${label} 的祖先目录不能是符号链接。`
      );
    }
  }
};

/**
 * 生产运行态的路径必须互不重叠，并且现有路径链不可穿过符号链接。
 * 所有权、ACL 与文件系统类型仍由部署门禁负责，因为 Node 无法跨平台可靠验证。
 */
export const assertRuntimePathsSafe = (
  paths: RuntimePaths,
  fileSystem: RuntimePathFileSystem = nodeRuntimePathFileSystem
) => {
  assertNotOverlapping("API_DATA_FILE", paths.dataFile, "SYSTEM_LOG_FILE", paths.systemLogFile);
  assertNotOverlapping("API_DATA_FILE", paths.dataFile, "UPLOAD_DIR", paths.uploadDir);
  assertNotOverlapping("API_DATA_FILE", paths.dataFile, "API_BACKUP_DIR", paths.backupDir);
  assertNotOverlapping("SYSTEM_LOG_FILE", paths.systemLogFile, "UPLOAD_DIR", paths.uploadDir);
  assertNotOverlapping("SYSTEM_LOG_FILE", paths.systemLogFile, "API_BACKUP_DIR", paths.backupDir);
  assertNotOverlapping("UPLOAD_DIR", paths.uploadDir, "API_BACKUP_DIR", paths.backupDir);
  assertNotOverlapping(
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
    paths.financialLeaseFile,
    "API_DATA_FILE",
    paths.dataFile
  );
  assertNotOverlapping(
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
    paths.financialLeaseFile,
    "SYSTEM_LOG_FILE",
    paths.systemLogFile
  );
  assertNotOverlapping(
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
    paths.financialLeaseFile,
    "UPLOAD_DIR",
    paths.uploadDir
  );
  assertNotOverlapping(
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
    paths.financialLeaseFile,
    "API_BACKUP_DIR",
    paths.backupDir
  );

  assertNoSymbolicLinkInExistingPath(paths.dataFile, "API_DATA_FILE", fileSystem);
  assertNoSymbolicLinkInExistingPath(paths.systemLogFile, "SYSTEM_LOG_FILE", fileSystem);
  assertNoSymbolicLinkInExistingPath(paths.uploadDir, "UPLOAD_DIR", fileSystem);
  assertNoSymbolicLinkInExistingPath(paths.backupDir, "API_BACKUP_DIR", fileSystem);
  assertNoSymbolicLinkInExistingPath(
    paths.financialLeaseFile,
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
    fileSystem
  );
};
