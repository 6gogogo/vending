import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertRuntimePathsSafe } from "../src/common/store/runtime-path-safety.js";

const createPaths = (root: string) => ({
  dataFile: join(root, "data", "store.json"),
  systemLogFile: join(root, "data", "system-audit.ndjson"),
  uploadDir: join(root, "uploads"),
  backupDir: join(root, "backups"),
  financialLeaseFile: join(root, "data", "financial-writer.lock")
});

test("运行路径允许互不重叠的私有数据、审计、上传、备份与租约位置", (t) => {
  const root = join(tmpdir(), `vm-runtime-path-safety-${Date.now()}-${process.pid}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.doesNotThrow(() => assertRuntimePathsSafe(createPaths(root)));
});

test("运行路径拒绝把业务数据与上传静态目录重叠", (t) => {
  const root = join(tmpdir(), `vm-runtime-path-overlap-${Date.now()}-${process.pid}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = createPaths(root);

  assert.throws(
    () => assertRuntimePathsSafe({ ...paths, uploadDir: join(root, "data") }),
    /API_DATA_FILE 不能与 UPLOAD_DIR 重叠/
  );
});

test("运行路径拒绝已有祖先目录中的符号链接", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows reparse point 需要单独的 ACL 与设备验证，当前本机只验证 POSIX 符号链接。");
    return;
  }

  const root = join(tmpdir(), `vm-runtime-path-link-${Date.now()}-${process.pid}`);
  const realDataDirectory = join(root, "real-data");
  const linkedDataDirectory = join(root, "linked-data");
  mkdirSync(realDataDirectory, { recursive: true });
  symlinkSync(realDataDirectory, linkedDataDirectory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = createPaths(root);

  assert.throws(
    () => assertRuntimePathsSafe({ ...paths, dataFile: join(linkedDataDirectory, "store.json") }),
    /API_DATA_FILE 的祖先目录不能是符号链接/
  );
});
