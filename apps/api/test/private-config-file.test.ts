import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrivateConfigFileWriter,
  PrivateConfigWriteError,
  type PrivateConfigFileSystem
} from "../src/common/store/private-config-file.js";

const createFakeFileSystem = (options?: {
  targetExists?: boolean;
  targetSymbolicLink?: boolean;
  writeChunkSize?: number;
  failFileFsync?: boolean;
  failDirectoryFsync?: boolean;
  failRename?: boolean;
}) => {
  const calls: string[] = [];
  let nextDescriptor = 10;
  const descriptorKinds = new Map<number, "file" | "directory">();
  const fileSystem: PrivateConfigFileSystem = {
    mkdirSync: () => {
      calls.push("mkdir");
      return undefined;
    },
    existsSync: (path) => {
      if (path.endsWith(".tmp")) {
        return true;
      }
      return Boolean(options?.targetExists);
    },
    lstatSync: () => ({
      isFile: () => !options?.targetSymbolicLink,
      isSymbolicLink: () => Boolean(options?.targetSymbolicLink)
    }),
    openSync: (_path, flags) => {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      const kind = flags === "r" ? "directory" : "file";
      descriptorKinds.set(descriptor, kind);
      calls.push(`open:${kind}:${flags}`);
      return descriptor;
    },
    fchmodSync: (descriptor) => {
      calls.push(`fchmod:${descriptor}`);
    },
    writeSync: (descriptor, _buffer, offset, length) => {
      calls.push(`write:${descriptor}:${offset}:${length}`);
      return Math.min(length, options?.writeChunkSize ?? length);
    },
    fsyncSync: (descriptor) => {
      const kind = descriptorKinds.get(descriptor);
      calls.push(`fsync:${kind}:${descriptor}`);
      if ((kind === "file" && options?.failFileFsync) || (kind === "directory" && options?.failDirectoryFsync)) {
        throw new Error(`fsync-${kind}-failed`);
      }
    },
    closeSync: (descriptor) => {
      calls.push(`close:${descriptor}`);
    },
    renameSync: () => {
      calls.push("rename");
      if (options?.failRename) {
        throw new Error("rename-failed");
      }
    },
    unlinkSync: () => {
      calls.push("unlink");
    }
  };

  return { calls, fileSystem };
};

test("私有配置文件以临时文件、fsync 和原子替换写入", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const write = createPrivateConfigFileWriter(fileSystem, "linux", () => "/tmp/config.tmp");

  write("/tmp/config.env", "KEY=value\n");

  assert.deepEqual(calls.slice(0, 3), ["mkdir", "open:file:wx", "fchmod:10"]);
  assert.match(calls[3]!, /^write:10:0:\d+$/);
  assert.deepEqual(calls.slice(4), [
    "fsync:file:10",
    "close:10",
    "rename",
    "open:directory:r",
    "fsync:directory:11",
    "close:11"
  ]);
});

test("私有配置文件处理短写，失败时清理暂存文件且不删除旧目标", () => {
  const shortWrite = createFakeFileSystem({ writeChunkSize: 2, targetExists: true });
  const writeShort = createPrivateConfigFileWriter(shortWrite.fileSystem, "linux", () => "/tmp/config.tmp");

  writeShort("/tmp/config.env", "KEY=value\n");
  assert.ok(shortWrite.calls.filter((call) => call.startsWith("write:")).length > 1);

  const failedRename = createFakeFileSystem({ targetExists: true, failRename: true });
  const writeFailedRename = createPrivateConfigFileWriter(
    failedRename.fileSystem,
    "linux",
    () => "/tmp/config.tmp"
  );

  assert.throws(() => writeFailedRename("/tmp/config.env", "KEY=value\n"), PrivateConfigWriteError);
  assert.equal(failedRename.calls.includes("unlink"), true);
  assert.equal(failedRename.calls.includes("rename"), true);
});

test("目录同步失败会报告已提交但耐久性未确认，符号链接目标在写入前拒绝", () => {
  const directoryFailure = createFakeFileSystem({ failDirectoryFsync: true });
  const writeDirectoryFailure = createPrivateConfigFileWriter(
    directoryFailure.fileSystem,
    "linux",
    () => "/tmp/config.tmp"
  );

  assert.throws(
    () => writeDirectoryFailure("/tmp/config.env", "KEY=value\n"),
    (error: unknown) => error instanceof PrivateConfigWriteError && error.committed === true
  );
  assert.equal(directoryFailure.calls.includes("unlink"), false);

  const symbolicLink = createFakeFileSystem({ targetExists: true, targetSymbolicLink: true });
  const writeSymbolicLink = createPrivateConfigFileWriter(
    symbolicLink.fileSystem,
    "linux",
    () => "/tmp/config.tmp"
  );

  assert.throws(() => writeSymbolicLink("/tmp/config.env", "KEY=value\n"), /普通文件/);
  assert.equal(symbolicLink.calls.some((call) => call.startsWith("open:file")), false);
});

test("Windows 同步临时文件但不尝试同步目录", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const write = createPrivateConfigFileWriter(fileSystem, "win32", () => "C:/temp/config.tmp");

  write("C:/temp/config.env", "KEY=value\n");

  assert.equal(calls.some((call) => call.startsWith("fsync:file:")), true);
  assert.equal(calls.some((call) => call.startsWith("open:directory")), false);
});
