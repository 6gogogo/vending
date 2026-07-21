import { existsSync, writeFileSync } from "node:fs";

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
    leaseDurationMs: 10_000,
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
    if (mode === "hold") {
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
