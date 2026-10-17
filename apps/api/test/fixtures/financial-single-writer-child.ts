import { existsSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { FinancialSingleWriterLease } from "../../src/common/coordination/financial-single-writer-lease";

const [
  lockFile,
  ownerId,
  mode,
  readyFile,
  releaseFile,
  acquiredFile,
  finishFile
] = process.argv.slice(2);

if (!lockFile || !ownerId || !mode) {
  process.exitCode = 64;
} else {
  const lease = new FinancialSingleWriterLease({
    lockFile,
    ownerId,
    leaseDurationMs: mode.startsWith("crash-") ? 1_000 : 10_000,
    heartbeatIntervalMs: 1_000
  });

  try {
    if (mode === "contend") {
      if (!readyFile || !releaseFile || !acquiredFile || !finishFile) {
        throw new Error("contend 模式缺少就绪、起跑、获取或结束文件路径。");
      }
      writeFileSync(readyFile, ownerId, "utf8");
      while (!existsSync(releaseFile)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    lease.acquire();
    if (mode === "crash-before-heartbeat-publish") {
      const original = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (target === lockFile) {
          writeFileSync(readyFile!, ownerId, "utf8");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
        }
        return original(source, target);
      };
      syncBuiltinESMExports();
      lease.heartbeat();
    } else if (mode === "crash-in-fence") {
      lease.runWithFence(() => {
        writeFileSync(readyFile!, ownerId, "utf8");
        // 测试在持有互斥区时 SIGKILL，不能通过 finally 帮忙释放。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      });
    } else if (mode === "hold") {
      if (!readyFile || !releaseFile) {
        throw new Error("hold 模式缺少就绪或释放文件路径。");
      }
      writeFileSync(readyFile, ownerId, "utf8");
      while (!existsSync(releaseFile)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } else if (mode === "contend") {
      writeFileSync(acquiredFile!, ownerId, "utf8");
      while (!existsSync(finishFile!)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    lease.release();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    lease.release();
    process.exitCode = 2;
  }
}
