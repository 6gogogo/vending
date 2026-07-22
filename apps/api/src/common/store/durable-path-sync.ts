import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface DurablePathFileSystem {
  openSync: (path: string, flags: string) => number;
  fsyncSync: (fileDescriptor: number) => void;
  closeSync: (fileDescriptor: number) => void;
}

const nodeDurablePathFileSystem: DurablePathFileSystem = {
  openSync,
  fsyncSync,
  closeSync
};

/**
 * 将文件内容和 POSIX 父目录项持久化到本地文件系统。
 * Windows 没有可移植的目录 fsync；调用方不得将该分支等同为 POSIX 断电耐久性保证。
 */
export const createDurablePathSynchronizer = (
  fileSystem: DurablePathFileSystem = nodeDurablePathFileSystem,
  platform: NodeJS.Platform = process.platform
) => {
  const synchronize = (path: string, flags: string) => {
    let fileDescriptor: number | undefined;

    try {
      fileDescriptor = fileSystem.openSync(path, flags);
      fileSystem.fsyncSync(fileDescriptor);
    } finally {
      if (fileDescriptor !== undefined) {
        fileSystem.closeSync(fileDescriptor);
      }
    }
  };

  return {
    syncFile(filePath: string) {
      synchronize(filePath, "r+");
    },
    syncDirectory(directoryPath: string) {
      if (platform !== "win32") {
        synchronize(directoryPath, "r");
      }
    },
    syncFileAndParentDirectory(filePath: string) {
      synchronize(filePath, "r+");

      if (platform !== "win32") {
        synchronize(dirname(filePath), "r");
      }
    },
    syncDirectoryAndAncestors(directoryPath: string, rootDirectory: string) {
      if (platform === "win32") {
        return;
      }

      const resolvedRoot = resolve(rootDirectory);
      let currentDirectory = resolve(directoryPath);
      const rootRelativePath = relative(resolvedRoot, currentDirectory);

      if (rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
        throw new Error("目录同步路径超出受控根目录。");
      }

      while (true) {
        synchronize(currentDirectory, "r");

        if (currentDirectory === resolvedRoot) {
          return;
        }

        const parentDirectory = dirname(currentDirectory);

        if (parentDirectory === currentDirectory) {
          throw new Error("目录同步无法到达受控根目录。");
        }

        currentDirectory = parentDirectory;
      }
    }
  };
};
