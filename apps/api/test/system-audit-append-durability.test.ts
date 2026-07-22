import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  createSystemAuditLogAppender,
  type SystemAuditLogFileSystem
} from "../src/common/store/persistence.js";

const withSystemLogFile = (action: () => void) => {
  const previous = process.env.SYSTEM_LOG_FILE;
  process.env.SYSTEM_LOG_FILE = join("audit-durability-test", "system-audit.ndjson");

  try {
    action();
  } finally {
    if (previous === undefined) {
      delete process.env.SYSTEM_LOG_FILE;
    } else {
      process.env.SYSTEM_LOG_FILE = previous;
    }
  }
};

const createFakeFileSystem = (options?: {
  writeChunkSize?: number;
  failFileFsync?: boolean;
  failDirectoryFsync?: boolean;
  failDirectoryFsyncAttempts?: number;
}) => {
  const calls: string[] = [];
  let nextDescriptor = 10;
  const descriptorKinds = new Map<number, "file" | "directory">();
  let auditFileExists = false;
  let remainingDirectoryFsyncFailures = options?.failDirectoryFsyncAttempts ?? 0;
  const fileSystem: SystemAuditLogFileSystem = {
    mkdirSync: () => {
      calls.push("mkdir");
      return undefined;
    },
    existsSync: (path) => path.endsWith("system-audit.ndjson") && auditFileExists,
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false
    }),
    openSync: (_path, flags) => {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      const kind = flags === "r" ? "directory" : "file";
      if (kind === "file") {
        auditFileExists = true;
      }
      descriptorKinds.set(descriptor, kind);
      calls.push(`open:${kind}:${flags}`);
      return descriptor;
    },
    fstatSync: (descriptor) => {
      calls.push(`fstat:${descriptor}`);
      return {
        isFile: () => descriptorKinds.get(descriptor) === "file"
      };
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
      const shouldFailDirectoryFsync =
        kind === "directory" &&
        (options?.failDirectoryFsync || remainingDirectoryFsyncFailures > 0);

      if (kind === "directory" && remainingDirectoryFsyncFailures > 0) {
        remainingDirectoryFsyncFailures -= 1;
      }

      if ((kind === "file" && options?.failFileFsync) || shouldFailDirectoryFsync) {
        throw new Error(`fsync-${kind}-failed`);
      }
    },
    closeSync: (descriptor) => {
      calls.push(`close:${descriptor}`);
    }
  };

  return {
    calls,
    fileSystem,
    setAuditFileExists: (value: boolean) => {
      auditFileExists = value;
    }
  };
};

const entry = {
  occurredAt: "2026-07-22T00:00:00.000Z",
  method: "POST",
  path: "/api/example",
  statusCode: 200,
  durationMs: 1
};

test("耐久审计追加在首次写入时同步文件和目录", () => {
  withSystemLogFile(() => {
    const { calls, fileSystem } = createFakeFileSystem();
    const append = createSystemAuditLogAppender(fileSystem, "linux");

    append(entry);

    assert.equal(calls[0], "mkdir");
    assert.match(calls[1]!, /^open:file:/);
    assert.equal(calls[2], "fchmod:10");
    assert.equal(calls[3], "fstat:10");
    assert.match(calls[4]!, /^write:10:0:\d+$/);
    assert.deepEqual(calls.slice(5), [
      "fsync:file:10",
      "close:10",
      "open:directory:r",
      "fsync:directory:11",
      "close:11"
    ]);
  });
});

test("耐久审计追加处理短写，后续写入仍同步文件和目录", () => {
  withSystemLogFile(() => {
    const { calls, fileSystem } = createFakeFileSystem({ writeChunkSize: 3 });
    const append = createSystemAuditLogAppender(fileSystem, "linux");

    append(entry);
    const firstWriteCount = calls.filter((call) => call.startsWith("write:")).length;
    append(entry);
    const secondWriteCount = calls.filter((call) => call.startsWith("write:")).length;

    assert.ok(firstWriteCount > 1);
    assert.ok(secondWriteCount > firstWriteCount);
    assert.equal(calls.filter((call) => call.startsWith("fsync:file:")).length, 2);
    assert.equal(calls.filter((call) => call.startsWith("fsync:directory:")).length, 2);
  });
});

test("文件或目录同步失败会关闭描述符并使下次写入重新尝试目录同步", () => {
  withSystemLogFile(() => {
    const fileFailure = createFakeFileSystem({ failFileFsync: true });
    const appendFileFailure = createSystemAuditLogAppender(fileFailure.fileSystem, "linux");

    assert.throws(() => appendFileFailure(entry), /fsync-file-failed/);
    assert.ok(fileFailure.calls.includes("close:10"));
    assert.equal(fileFailure.calls.some((call) => call.startsWith("open:directory")), false);

    const directoryFailure = createFakeFileSystem({ failDirectoryFsync: true });
    const appendDirectoryFailure = createSystemAuditLogAppender(directoryFailure.fileSystem, "linux");

    assert.throws(() => appendDirectoryFailure(entry), /fsync-directory-failed/);
    assert.ok(directoryFailure.calls.includes("close:11"));
  });
});

test("首次目录同步失败后，文件已存在时的下一次追加仍重新同步目录", () => {
  withSystemLogFile(() => {
    const { calls, fileSystem } = createFakeFileSystem({
      failDirectoryFsyncAttempts: 1
    });
    const append = createSystemAuditLogAppender(fileSystem, "linux");

    assert.throws(() => append(entry), /fsync-directory-failed/);
    assert.doesNotThrow(() => append(entry));

    assert.equal(calls.filter((call) => call.startsWith("fsync:file:")).length, 2);
    assert.equal(calls.filter((call) => call.startsWith("fsync:directory:")).length, 2);
  });
});

test("Windows 保留文件同步，但不尝试目录描述符同步", () => {
  withSystemLogFile(() => {
    const { calls, fileSystem } = createFakeFileSystem();
    const append = createSystemAuditLogAppender(fileSystem, "win32");

    append(entry);

    assert.equal(calls.some((call) => call.startsWith("fsync:file:")), true);
    assert.equal(calls.some((call) => call.startsWith("open:directory")), false);
  });
});

test("审计日志删除后重新创建时，会再次同步新目录项", () => {
  withSystemLogFile(() => {
    const { calls, fileSystem, setAuditFileExists } = createFakeFileSystem();
    const append = createSystemAuditLogAppender(fileSystem, "linux");

    append(entry);
    setAuditFileExists(false);
    append(entry);

    assert.equal(calls.filter((call) => call.startsWith("fsync:directory:")).length, 2);
  });
});
