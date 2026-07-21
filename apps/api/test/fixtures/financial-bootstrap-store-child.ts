import { existsSync, writeFileSync } from "node:fs";

import { acquireFinancialSingleWriterForApiBootstrap } from "../../src/common/coordination/financial-single-writer-runtime";
import { InMemoryStoreService } from "../../src/common/store/in-memory-store.service";

const [
  mode,
  dataFile,
  lockFile,
  firstFile,
  secondFile,
  thirdFile,
  fourthFile
] = process.argv.slice(2);

if (!mode || !dataFile || !lockFile || !firstFile || !secondFile) {
  process.exitCode = 64;
} else {
  process.env.API_DATA_FILE = dataFile;
  process.env.FINANCIAL_SINGLE_WRITER_LEASE_FILE = lockFile;
  process.env.FINANCIAL_SINGLE_WRITER_ENABLED = "true";
  process.env.NODE_ENV = "test";
  delete process.env.APP_ENV;

  try {
    if (mode === "writer") {
      if (!thirdFile || !fourthFile) {
        throw new Error("writer 模式缺少写入完成或释放信号文件。");
      }
      process.env.FINANCIAL_INSTANCE_ID = "writer-a";
      const runtime = acquireFinancialSingleWriterForApiBootstrap();
      try {
        const store = new InMemoryStoreService();
        store.flushBootstrapPersistence();
        writeFileSync(firstFile, "ready", "utf8");

        while (!existsSync(secondFile)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const now = new Date().toISOString();
        store.paymentOrders.push({
          id: "newer-order",
          paymentNo: "wx-newer-order",
          provider: "wechat",
          phase: "post_settlement",
          status: "pending",
          amount: 1,
          currency: "CNY",
          subject: "租约内写入的新订单",
          createdAt: now,
          updatedAt: now
        });
        store.persist();
        writeFileSync(thirdFile, "written", "utf8");

        while (!existsSync(fourthFile)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        runtime.release();
      }
    } else if (mode === "bootstrap") {
      process.env.FINANCIAL_INSTANCE_ID = "api-bootstrap";
      const runtime = acquireFinancialSingleWriterForApiBootstrap();
      try {
        // 该标记只能在取得租约后出现，用来证明 Store 没有在竞争失败前读取旧快照。
        writeFileSync(firstFile, "lease-acquired-before-store", "utf8");
        const store = new InMemoryStoreService();
        store.persist();
        writeFileSync(
          secondFile,
          JSON.stringify(store.paymentOrders.map((order) => order.id)),
          "utf8"
        );
      } finally {
        runtime.release();
      }
    } else {
      throw new Error(`未知模式：${mode}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
