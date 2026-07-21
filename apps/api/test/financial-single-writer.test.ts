import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FinancialSingleWriterLease } from "../src/common/coordination/financial-single-writer-lease";

test("金融单写者租约阻止第二个进程同时进入，原持有者释放后可安全接管", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-writer-"));
  const lockFile = join(directory, "financial-writer.lock");
  const first = new FinancialSingleWriterLease({
    lockFile,
    ownerId: "instance-a",
    autoHeartbeat: false
  });
  const second = new FinancialSingleWriterLease({
    lockFile,
    ownerId: "instance-b",
    autoHeartbeat: false
  });

  try {
    const acquired = first.acquire();
    assert.equal(acquired.ownerId, "instance-a");
    assert.equal(first.isHeld(), true);

    assert.throws(
      () => second.acquire(),
      /已有其他实例持有金融单写者租约/
    );
    assert.equal(second.isHeld(), false);

    first.release();
    const takeover = second.acquire();
    assert.equal(takeover.ownerId, "instance-b");
    assert.equal(second.isHeld(), true);
  } finally {
    first.release();
    second.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("过期且原进程已消失的租约会先隔离证据再由新实例接管", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-writer-stale-"));
  const lockFile = join(directory, "financial-writer.lock");
  const now = new Date("2026-07-19T00:10:00.000Z");
  writeFileSync(
    lockFile,
    JSON.stringify({
      version: 1,
      ownerId: "crashed-instance",
      pid: 987_654,
      hostname: "test-host",
      acquiredAt: "2026-07-19T00:00:00.000Z",
      heartbeatAt: "2026-07-19T00:00:10.000Z",
      expiresAt: "2026-07-19T00:00:40.000Z"
    }),
    "utf8"
  );
  const replacement = new FinancialSingleWriterLease({
    lockFile,
    ownerId: "replacement-instance",
    hostname: "test-host",
    pid: 123,
    now: () => now,
    isProcessAlive: () => false,
    autoHeartbeat: false
  });

  try {
    assert.equal(replacement.acquire().ownerId, "replacement-instance");
    assert.equal(
      readdirSync(directory).some((entry) =>
        entry.startsWith("financial-writer.lock.stale.")
      ),
      true
    );
  } finally {
    replacement.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("每次金融操作前都会核对磁盘所有者和有效期，租约被替换后立即失败关闭", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-writer-fencing-"));
  const lockFile = join(directory, "financial-writer.lock");
  let now = new Date("2026-07-19T01:00:00.000Z");
  const lease = new FinancialSingleWriterLease({
    lockFile,
    ownerId: "instance-a",
    now: () => now,
    leaseDurationMs: 5_000,
    autoHeartbeat: false
  });

  try {
    lease.acquire();
    assert.doesNotThrow(() => lease.assertHeld());

    writeFileSync(
      lockFile,
      JSON.stringify({
        version: 1,
        ownerId: "instance-b",
        pid: 456,
        hostname: "other-host",
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5_000).toISOString()
      }),
      "utf8"
    );

    assert.throws(() => lease.assertHeld(), /所有者已变化/);
    assert.equal(lease.isHeld(), false);

    now = new Date("2026-07-19T01:00:06.000Z");
  } finally {
    lease.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("心跳在同一文件句柄内刷新磁盘租约，Windows 本地运行不保留阻塞写入的旧句柄", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-writer-heartbeat-"));
  const lockFile = join(directory, "financial-writer.lock");
  let now = new Date("2026-07-19T02:00:00.000Z");
  const lease = new FinancialSingleWriterLease({
    lockFile,
    ownerId: "instance-heartbeat",
    now: () => now,
    leaseDurationMs: 10_000,
    autoHeartbeat: false
  });

  try {
    lease.acquire();
    now = new Date("2026-07-19T02:00:03.000Z");
    const refreshed = lease.heartbeat();
    const persisted = JSON.parse(readFileSync(lockFile, "utf8")) as {
      ownerId: string;
      heartbeatAt: string;
      expiresAt: string;
    };

    assert.equal(refreshed.heartbeatAt, now.toISOString());
    assert.equal(persisted.ownerId, "instance-heartbeat");
    assert.equal(persisted.heartbeatAt, now.toISOString());
    assert.equal(persisted.expiresAt, "2026-07-19T02:00:13.000Z");
  } finally {
    lease.release();
    rmSync(directory, { recursive: true, force: true });
  }
});
