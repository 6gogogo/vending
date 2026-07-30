import assert from "node:assert/strict";
import test from "node:test";

import {
  createPersistedStateWriter,
  createSeededPersistedState,
  PersistedStateWriteError,
  type PersistedStateFileSystem
} from "../src/common/store/persistence.js";

const createFakeFileSystem = (options?: {
  failDirectorySync?: boolean;
  failFileSync?: boolean;
}) => {
  const calls: string[] = [];
  let temporaryExists = true;
  let nextDescriptor = 10;
  const descriptorKinds = new Map<number, "file" | "directory">();

  const fileSystem: PersistedStateFileSystem = {
    mkdirSync: () => {
      calls.push("mkdir");
      return undefined;
    },
    openSync: (_path, flags) => {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      const kind = flags === "r" ? "directory" : "file";
      descriptorKinds.set(descriptor, kind);
      calls.push(`open:${kind}:${flags}`);
      return descriptor;
    },
    writeFileSync: (descriptor) => {
      calls.push(`write:${descriptor}`);
    },
    fsyncSync: (descriptor) => {
      const kind = descriptorKinds.get(descriptor);
      calls.push(`fsync:${kind}:${descriptor}`);
      if (kind === "file" && options?.failFileSync) {
        throw new Error("file-sync-failed");
      }
      if (kind === "directory" && options?.failDirectorySync) {
        throw new Error("directory-sync-failed");
      }
    },
    closeSync: (descriptor) => {
      calls.push(`close:${descriptorKinds.get(descriptor)}:${descriptor}`);
    },
    renameSync: () => {
      temporaryExists = false;
      calls.push("rename");
    },
    existsSync: () => temporaryExists,
    unlinkSync: () => {
      temporaryExists = false;
      calls.push("unlink");
    }
  };

  return { calls, fileSystem };
};

test("POSIX 持久化快照替换后同步父目录，才报告写入成功", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const write = createPersistedStateWriter(fileSystem, "linux", () => "/runtime/store.json", () => "test");

  assert.equal(write(createSeededPersistedState()), "/runtime/store.json");
  assert.deepEqual(calls, [
    "mkdir",
    "open:file:wx",
    "write:10",
    "fsync:file:10",
    "close:file:10",
    "rename",
    "open:directory:r",
    "fsync:directory:11",
    "close:directory:11"
  ]);
});

test("POSIX 父目录同步失败时，持久化快照写入报告失败而不是误报成功", () => {
  const { calls, fileSystem } = createFakeFileSystem({ failDirectorySync: true });
  const write = createPersistedStateWriter(fileSystem, "linux", () => "/runtime/store.json", () => "test");

  assert.throws(
    () => write(createSeededPersistedState()),
    (error: unknown) =>
      error instanceof PersistedStateWriteError && error.committed
  );
  assert.deepEqual(calls, [
    "mkdir",
    "open:file:wx",
    "write:10",
    "fsync:file:10",
    "close:file:10",
    "rename",
    "open:directory:r",
    "fsync:directory:11",
    "close:directory:11"
  ]);
});

test("正式文件替换前同步失败会清理暂存文件并标记为未提交", () => {
  const { calls, fileSystem } = createFakeFileSystem({ failFileSync: true });
  const write = createPersistedStateWriter(
    fileSystem,
    "linux",
    () => "/runtime/store.json",
    () => "test"
  );

  assert.throws(
    () => write(createSeededPersistedState()),
    (error: unknown) =>
      error instanceof PersistedStateWriteError && !error.committed
  );
  assert.deepEqual(calls, [
    "mkdir",
    "open:file:wx",
    "write:10",
    "fsync:file:10",
    "close:file:10",
    "unlink"
  ]);
});

test("Windows 保留文件同步但不假装支持 POSIX 目录同步", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const write = createPersistedStateWriter(fileSystem, "win32", () => "C:\\runtime\\store.json", () => "test");

  write(createSeededPersistedState());
  assert.equal(calls.some((call) => call.startsWith("open:directory")), false);
  assert.equal(calls.some((call) => call.startsWith("fsync:file")), true);
});
