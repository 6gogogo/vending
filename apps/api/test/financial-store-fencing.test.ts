import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigService } from "@nestjs/config";

import { FinancialSingleWriterLease } from "../src/common/coordination/financial-single-writer-lease";
import { FinancialSingleWriterService } from "../src/common/coordination/financial-single-writer.service";
import { acquireFinancialSingleWriterForApiBootstrap } from "../src/common/coordination/financial-single-writer-runtime";
import { installFinancialWriterFence } from "../src/common/coordination/financial-writer-fence";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";

const withEnvironment = (
  values: Record<string, string | undefined>,
  action: () => void
) => {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("仓储构造阶段保持只读，只有安装 fencing token 后才能落初始化快照", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-store-bootstrap-fence-"));
  const dataFile = join(directory, "store.json");
  const lockFile = join(directory, "financial-writer.lock");

  try {
    withEnvironment(
      {
        API_DATA_FILE: dataFile,
        FINANCIAL_SINGLE_WRITER_ENABLED: "true",
        NODE_ENV: "test",
        APP_ENV: undefined
      },
      () => {
        const store = new InMemoryStoreService();
        assert.equal(existsSync(dataFile), false);
        assert.throws(
          () => store.flushBootstrapPersistence(),
          /未持有金融单写者 fencing token/
        );
        assert.equal(existsSync(dataFile), false);

        const lease = new FinancialSingleWriterLease({
          lockFile,
          ownerId: "bootstrap-owner",
          autoHeartbeat: false
        });
        lease.acquire();
        const uninstall = installFinancialWriterFence(lease);
        try {
          assert.equal(store.flushBootstrapPersistence(), true);
          assert.equal(existsSync(dataFile), true);
          assert.doesNotThrow(() => JSON.parse(readFileSync(dataFile, "utf8")));
        } finally {
          lease.release();
          uninstall();
        }
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("完整性失败时不替换已验证账本，并把运行状态降为不可就绪", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-store-integrity-fence-"));
  const dataFile = join(directory, "store.json");
  const lockFile = join(directory, "financial-writer.lock");

  try {
    withEnvironment(
      {
        API_DATA_FILE: dataFile,
        FINANCIAL_SINGLE_WRITER_ENABLED: "true",
        NODE_ENV: "test",
        APP_ENV: undefined
      },
      () => {
        const lease = new FinancialSingleWriterLease({
          lockFile,
          ownerId: "integrity-owner",
          autoHeartbeat: false
        });
        lease.acquire();
        const uninstall = installFinancialWriterFence(lease);

        try {
          const store = new InMemoryStoreService();
          assert.equal(store.flushBootstrapPersistence(), true);
          const before = readFileSync(dataFile, "utf8");
          store.goodsCatalog[0]!.name = "";

          assert.throws(() => store.persist(), /运行数据完整性检查未通过/);
          assert.equal(readFileSync(dataFile, "utf8"), before);
          assert.equal(store.isPersistedStateIntegrityReady(), false);
        } finally {
          uninstall();
          lease.release();
        }
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("旧代进程在新 token 接管后不能覆盖账本，旧进程 release 也不会删除继任租约", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-store-stale-fence-"));
  const dataFile = join(directory, "store.json");
  const lockFile = join(directory, "financial-writer.lock");
  let now = new Date("2026-07-19T08:00:00.000Z");

  try {
    withEnvironment(
      {
        API_DATA_FILE: dataFile,
        FINANCIAL_SINGLE_WRITER_ENABLED: "true",
        NODE_ENV: "test",
        APP_ENV: undefined
      },
      () => {
        const first = new FinancialSingleWriterLease({
          lockFile,
          ownerId: "old-owner",
          hostname: "old-host",
          pid: 111,
          now: () => now,
          leaseDurationMs: 1_000,
          autoHeartbeat: false,
          isProcessAlive: () => false
        });
        first.acquire();
        const uninstall = installFinancialWriterFence(first);
        const store = new InMemoryStoreService();
        store.flushBootstrapPersistence();
        const before = readFileSync(dataFile, "utf8");

        now = new Date("2026-07-19T08:00:02.000Z");
        const successor = new FinancialSingleWriterLease({
          lockFile,
          ownerId: "new-owner",
          hostname: "new-host",
          pid: 222,
          now: () => now,
          leaseDurationMs: 5_000,
          autoHeartbeat: false,
          isProcessAlive: () => false
        });

        try {
          successor.acquire();
          store.paymentOrders.push({
            id: "stale-write",
            paymentNo: "wx-stale-write",
            provider: "wechat",
            phase: "post_settlement",
            status: "pending",
            amount: 1,
            currency: "CNY",
            subject: "旧实例不应落盘",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString()
          });
          assert.throws(
            () => store.persist(),
            /所有者已变化或 fencing token 不匹配/
          );
          assert.equal(readFileSync(dataFile, "utf8"), before);

          first.release();
          assert.doesNotThrow(() => successor.assertHeld());
        } finally {
          uninstall();
          first.release();
          successor.release();
        }
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Nest 金融服务接管预启动的同一 token，重复 acquire/release 不创建第二份租约", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-store-bootstrap-handoff-"));
  const lockFile = join(directory, "financial-writer.lock");

  try {
    withEnvironment(
      {
        FINANCIAL_SINGLE_WRITER_LEASE_FILE: lockFile,
        FINANCIAL_SINGLE_WRITER_ENABLED: "true",
        FINANCIAL_INSTANCE_ID: "pre-bootstrap-owner",
        NODE_ENV: "test",
        APP_ENV: undefined
      },
      () => {
        const runtime = acquireFinancialSingleWriterForApiBootstrap();
        const service = new FinancialSingleWriterService(
          new ConfigService<Record<string, string>>({})
        );
        const adopted = service.adoptPreAcquiredRuntime(runtime);
        const reacquired = service.acquire();

        assert.equal(adopted.fencingToken, runtime.acquired.fencingToken);
        assert.equal(reacquired.fencingToken, runtime.acquired.fencingToken);
        assert.equal(service.getStatus().held, true);

        service.release();
        assert.equal(existsSync(lockFile), false);
        assert.doesNotThrow(() => service.release());
        assert.doesNotThrow(() => runtime.release());
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
