import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createDurablePathSynchronizer,
  type DurablePathFileSystem
} from "../src/common/store/durable-path-sync.js";

const createFakeFileSystem = (options?: { failOnDescriptor?: number }) => {
  const calls: string[] = [];
  let nextDescriptor = 10;
  const fileSystem: DurablePathFileSystem = {
    openSync: (path, flags) => {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      calls.push(`open:${path}:${flags}`);
      return descriptor;
    },
    fsyncSync: (descriptor) => {
      calls.push(`fsync:${descriptor}`);
      if (descriptor === options?.failOnDescriptor) {
        throw new Error("sync-failed");
      }
    },
    closeSync: (descriptor) => {
      calls.push(`close:${descriptor}`);
    }
  };

  return { calls, fileSystem };
};

test("POSIX 先同步文件再同步其父目录", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const synchronizer = createDurablePathSynchronizer(fileSystem, "linux");

  synchronizer.syncFileAndParentDirectory("/runtime/backups/store.json");

  assert.deepEqual(calls, [
    "open:/runtime/backups/store.json:r+",
    "fsync:10",
    "close:10",
    "open:/runtime/backups:r",
    "fsync:11",
    "close:11"
  ]);
});

test("同步失败仍关闭描述符并向调用方报告失败", () => {
  const { calls, fileSystem } = createFakeFileSystem({ failOnDescriptor: 10 });
  const synchronizer = createDurablePathSynchronizer(fileSystem, "linux");

  assert.throws(
    () => synchronizer.syncFileAndParentDirectory("/runtime/backups/store.json"),
    /sync-failed/
  );
  assert.deepEqual(calls, [
    "open:/runtime/backups/store.json:r+",
    "fsync:10",
    "close:10"
  ]);
});

test("Windows 保留文件同步但不伪造 POSIX 目录同步", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const synchronizer = createDurablePathSynchronizer(fileSystem, "win32");

  synchronizer.syncFileAndParentDirectory("C:\\runtime\\backups\\store.json");

  assert.deepEqual(calls, [
    "open:C:\\runtime\\backups\\store.json:r+",
    "fsync:10",
    "close:10"
  ]);
});

test("POSIX 同步嵌套备份目录直到受控根目录", () => {
  const { calls, fileSystem } = createFakeFileSystem();
  const synchronizer = createDurablePathSynchronizer(fileSystem, "linux");
  const backupRoot = resolve("runtime", "backups", "backup");
  const nestedDirectory = join(backupRoot, "uploads", "nested");
  const uploadsDirectory = join(backupRoot, "uploads");

  synchronizer.syncDirectoryAndAncestors(nestedDirectory, backupRoot);

  assert.deepEqual(calls, [
    `open:${nestedDirectory}:r`,
    "fsync:10",
    "close:10",
    `open:${uploadsDirectory}:r`,
    "fsync:11",
    "close:11",
    `open:${backupRoot}:r`,
    "fsync:12",
    "close:12"
  ]);
});
