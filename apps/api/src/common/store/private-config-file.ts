import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface PrivateConfigFileSystem {
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => string | undefined;
  existsSync: (path: string) => boolean;
  lstatSync: (path: string) => {
    isSymbolicLink: () => boolean;
    isFile: () => boolean;
  };
  openSync: (path: string, flags: string, mode?: number) => number;
  fchmodSync: (fileDescriptor: number, mode: number) => void;
  writeSync: (
    fileDescriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number
  ) => number;
  fsyncSync: (fileDescriptor: number) => void;
  closeSync: (fileDescriptor: number) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
}

export class PrivateConfigWriteError extends Error {
  constructor(
    message: string,
    public readonly committed: boolean
  ) {
    super(message);
    this.name = "PrivateConfigWriteError";
  }
}

const nodePrivateConfigFileSystem: PrivateConfigFileSystem = {
  mkdirSync,
  existsSync,
  lstatSync,
  openSync,
  fchmodSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync
};

const defaultTemporaryPath = (filePath: string) =>
  `${filePath}.${process.pid}.${randomUUID()}.tmp`;

/**
 * 以私有权限和同目录原子替换写入配置。目录同步失败意味着新内容可能已替换，
 * 调用方必须将该情况作为状态不确定，而不能宣称零副作用。
 */
export const createPrivateConfigFileWriter = (
  fileSystem: PrivateConfigFileSystem = nodePrivateConfigFileSystem,
  platform = process.platform,
  createTemporaryPath: (filePath: string) => string = defaultTemporaryPath
) => {
  return (filePath: string, content: string) => {
    const directory = dirname(filePath);
    const temporaryPath = createTemporaryPath(filePath);
    let fileDescriptor: number | undefined;
    let committed = false;

    try {
      fileSystem.mkdirSync(directory, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE
      });

      if (fileSystem.existsSync(filePath)) {
        const fileStat = fileSystem.lstatSync(filePath);

        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          throw new PrivateConfigWriteError("配置文件必须是普通文件，不能是符号链接。", false);
        }
      }

      const payload = Buffer.from(content, "utf8");
      fileDescriptor = fileSystem.openSync(temporaryPath, "wx", PRIVATE_FILE_MODE);
      fileSystem.fchmodSync(fileDescriptor, PRIVATE_FILE_MODE);

      for (let offset = 0; offset < payload.length;) {
        const written = fileSystem.writeSync(fileDescriptor, payload, offset, payload.length - offset);

        if (written <= 0) {
          throw new Error("配置临时文件写入未取得进展。");
        }
        offset += written;
      }

      fileSystem.fsyncSync(fileDescriptor);
      const descriptorToClose = fileDescriptor;
      fileDescriptor = undefined;
      fileSystem.closeSync(descriptorToClose);

      fileSystem.renameSync(temporaryPath, filePath);
      committed = true;

      if (platform !== "win32") {
        let directoryDescriptor: number | undefined;

        try {
          directoryDescriptor = fileSystem.openSync(directory, "r");
          fileSystem.fsyncSync(directoryDescriptor);
        } finally {
          if (directoryDescriptor !== undefined) {
            fileSystem.closeSync(directoryDescriptor);
          }
        }
      }
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          fileSystem.closeSync(fileDescriptor);
        } catch {
          // 原始写入失败优先；关闭失败同样会使调用方保持失败关闭。
        }
      }

      if (!committed && fileSystem.existsSync(temporaryPath)) {
        try {
          fileSystem.unlinkSync(temporaryPath);
        } catch {
          // 暂存文件残留是现场证据，不能覆盖原始失败。
        }
      }

      if (error instanceof PrivateConfigWriteError) {
        throw error;
      }

      throw new PrivateConfigWriteError(
        committed ? "配置已替换但目录耐久性未确认。" : "配置文件写入失败。",
        committed
      );
    }
  };
};

export const writePrivateConfigFileAtomically = createPrivateConfigFileWriter();
