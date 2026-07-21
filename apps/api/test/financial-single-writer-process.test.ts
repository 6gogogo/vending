import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const waitForFile = async (file: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待子进程就绪超时：${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("两个真实 Node 进程竞争同一金融租约时只有一个可写，释放后另一进程才能进入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-process-"));
  const lockFile = join(directory, "financial-writer.lock");
  const readyFile = join(directory, "first.ready");
  const releaseFile = join(directory, "first.release");
  const childScript = join(
    import.meta.dirname,
    "fixtures",
    "financial-single-writer-child.ts"
  );
  const first = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childScript,
      lockFile,
      "process-a",
      "hold",
      readyFile,
      releaseFile
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  try {
    await waitForFile(readyFile);

    const blocked = spawnSync(
      process.execPath,
      ["--import", "tsx", childScript, lockFile, "process-b", "once"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000
      }
    );
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /已有其他实例持有金融单写者租约/);

    writeFileSync(releaseFile, "release", "utf8");
    const [exitCode] = (await once(first, "exit")) as [number | null];
    assert.equal(exitCode, 0);

    const afterRelease = spawnSync(
      process.execPath,
      ["--import", "tsx", childScript, lockFile, "process-b", "once"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000
      }
    );
    assert.equal(afterRelease.status, 0, afterRelease.stderr);
  } finally {
    if (first.exitCode === null) {
      first.kill();
      await once(first, "exit").catch(() => undefined);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("两个真实进程同时接管过期租约时只有一个 fencing token 能进入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-stale-race-"));
  const lockFile = join(directory, "financial-writer.lock");
  const startFile = join(directory, "contenders.start");
  const finishFile = join(directory, "winner.finish");
  const readyA = join(directory, "a.ready");
  const readyB = join(directory, "b.ready");
  const acquiredA = join(directory, "a.acquired");
  const acquiredB = join(directory, "b.acquired");
  const childScript = join(
    import.meta.dirname,
    "fixtures",
    "financial-single-writer-child.ts"
  );
  writeFileSync(
    lockFile,
    JSON.stringify({
      version: 1,
      ownerId: "expired-owner",
      pid: 987_654,
      hostname: "dead-host",
      acquiredAt: "2026-07-18T00:00:00.000Z",
      heartbeatAt: "2026-07-18T00:00:01.000Z",
      expiresAt: "2026-07-18T00:00:02.000Z"
    }),
    "utf8"
  );

  const spawnContender = (
    ownerId: string,
    readyFile: string,
    acquiredFile: string
  ) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        childScript,
        lockFile,
        ownerId,
        "contend",
        readyFile,
        startFile,
        acquiredFile,
        finishFile
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  const first = spawnContender("contender-a", readyA, acquiredA);
  const second = spawnContender("contender-b", readyB, acquiredB);
  const firstExitPromise = once(first, "exit");
  const secondExitPromise = once(second, "exit");

  try {
    await Promise.all([waitForFile(readyA), waitForFile(readyB)]);
    writeFileSync(startFile, "start", "utf8");

    const deadline = Date.now() + 5_000;
    while (!existsSync(acquiredA) && !existsSync(acquiredB)) {
      if (Date.now() >= deadline) {
        throw new Error("没有进程成功取得过期租约。");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(finishFile, "finish", "utf8");

    const [[firstExit], [secondExit]] = (await Promise.all([
      firstExitPromise,
      secondExitPromise
    ])) as [[number | null], [number | null]];
    assert.deepEqual([firstExit, secondExit].sort(), [0, 2]);
    assert.equal(Number(existsSync(acquiredA)) + Number(existsSync(acquiredB)), 1);
  } finally {
    for (const child of [first, second]) {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit").catch(() => undefined);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("API 预启动租约阻止 Store 提前读取，继任进程不会覆盖先行写者的新订单", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-financial-bootstrap-"));
  const dataFile = join(directory, "store.json");
  const lockFile = join(directory, "financial-writer.lock");
  const writerReady = join(directory, "writer.ready");
  const writerWrite = join(directory, "writer.write");
  const writerWritten = join(directory, "writer.written");
  const writerRelease = join(directory, "writer.release");
  const blockedStoreRead = join(directory, "blocked.store-read");
  const blockedResult = join(directory, "blocked.result");
  const successorStoreRead = join(directory, "successor.store-read");
  const successorResult = join(directory, "successor.result");
  const childScript = join(
    import.meta.dirname,
    "fixtures",
    "financial-bootstrap-store-child.ts"
  );
  const writer = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childScript,
      "writer",
      dataFile,
      lockFile,
      writerReady,
      writerWrite,
      writerWritten,
      writerRelease
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  try {
    await waitForFile(writerReady);

    const blocked = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        childScript,
        "bootstrap",
        dataFile,
        lockFile,
        blockedStoreRead,
        blockedResult
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000
      }
    );
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /已有其他实例持有金融单写者租约/);
    assert.equal(
      existsSync(blockedStoreRead),
      false,
      "租约竞争失败时不得进入 Store 构造和账本读取"
    );

    writeFileSync(writerWrite, "write", "utf8");
    await waitForFile(writerWritten);
    writeFileSync(writerRelease, "release", "utf8");
    const [writerExit] = (await once(writer, "exit")) as [number | null];
    assert.equal(writerExit, 0);

    const successor = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        childScript,
        "bootstrap",
        dataFile,
        lockFile,
        successorStoreRead,
        successorResult
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000
      }
    );
    assert.equal(successor.status, 0, successor.stderr);
    assert.equal(existsSync(successorStoreRead), true);
    const loadedOrderIds = JSON.parse(
      readFileSync(successorResult, "utf8")
    ) as string[];
    assert.equal(loadedOrderIds.includes("newer-order"), true);
    const persisted = JSON.parse(readFileSync(dataFile, "utf8")) as {
      paymentOrders?: Array<{ id?: string }>;
    };
    assert.equal(
      persisted.paymentOrders?.some((order) => order.id === "newer-order"),
      true,
      "继任进程强制持久化后仍必须保留先行写者的新订单"
    );
  } finally {
    if (writer.exitCode === null) {
      writer.kill();
      await once(writer, "exit").catch(() => undefined);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
