import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSeededPersistedState,
  readPersistedStateWithMetadata
} from "../src/common/store/persistence.js";

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

test("生产环境拒绝缺失核心集合的持久化状态，而测试环境保留兼容性规范化", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-integrity-"));
  const dataFile = join(directory, "store.json");
  const state = createSeededPersistedState() as unknown as Record<string, unknown>;
  delete state.expiredBatchDispositions;
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /运行数据完整性检查未通过/
      );
    }
  );

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      NODE_ENV: "test",
      APP_ENV: undefined
    },
    () => {
      const loaded = readPersistedStateWithMetadata();
      assert.ok(loaded);
      assert.deepEqual(loaded.state.expiredBatchDispositions, []);
    }
  );
});

test("生产环境拒绝与支付单错绑的退款快照", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-payment-integrity-"));
  const dataFile = join(directory, "store.json");
  const state = createSeededPersistedState() as unknown as Record<string, unknown>;
  state.paymentOrders = [
    {
      id: "payment-order-production-integrity",
      paymentNo: "payment-no-production-integrity",
      provider: "wechat",
      phase: "pre_open",
      status: "paid",
      amount: 1000
    }
  ];
  state.paymentRefunds = [
    {
      id: "payment-refund-production-integrity",
      paymentOrderId: "payment-order-production-integrity",
      paymentNo: "wrong-payment-no-production-integrity",
      refundNo: "refund-no-production-integrity",
      provider: "wechat",
      status: "success",
      amount: 1000
    }
  ];
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /运行数据完整性检查未通过/
      );
    }
  );
});

test("生产环境拒绝未知退款状态的快照", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-refund-status-"));
  const dataFile = join(directory, "store.json");
  const state = createSeededPersistedState() as unknown as Record<string, unknown>;
  state.paymentOrders = [
    {
      id: "payment-order-unknown-refund-status",
      paymentNo: "payment-no-unknown-refund-status",
      provider: "wechat",
      phase: "pre_open",
      status: "paid",
      amount: 1000
    }
  ];
  state.paymentRefunds = [
    {
      id: "payment-refund-unknown-refund-status",
      paymentOrderId: "payment-order-unknown-refund-status",
      paymentNo: "payment-no-unknown-refund-status",
      refundNo: "refund-no-unknown-refund-status",
      provider: "wechat",
      status: "succeeded",
      amount: 1000
    }
  ];
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /运行数据完整性检查未通过/
      );
    }
  );
});

test("生产环境拒绝失败状态却未获渠道明确失败确认的退款快照", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-refund-outcome-"));
  const dataFile = join(directory, "store.json");
  const state = createSeededPersistedState() as unknown as Record<string, unknown>;
  state.paymentOrders = [
    {
      id: "payment-order-ambiguous-failed-refund",
      paymentNo: "payment-no-ambiguous-failed-refund",
      provider: "wechat",
      phase: "pre_open",
      status: "paid",
      amount: 1000
    }
  ];
  state.paymentRefunds = [
    {
      id: "payment-refund-ambiguous-failed-refund",
      paymentOrderId: "payment-order-ambiguous-failed-refund",
      paymentNo: "payment-no-ambiguous-failed-refund",
      refundNo: "refund-no-ambiguous-failed-refund",
      provider: "wechat",
      status: "failed",
      providerOutcome: "unknown",
      amount: 1000
    }
  ];
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /运行数据完整性检查未通过/
      );
    }
  );
});

test("生产环境检测到中断恢复残留时拒绝加载可能混代的运行数据", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-interrupted-restore-"));
  const dataFile = join(directory, "store.json");
  const systemLogFile = join(directory, "system-audit.ndjson");
  const uploadDir = join(directory, "uploads");
  writeFileSync(dataFile, `${JSON.stringify(createSeededPersistedState(), null, 2)}\n`, "utf8");
  writeFileSync(systemLogFile, '{"event":"baseline"}\n', "utf8");
  writeFileSync(join(directory, ".store.json.staging-test.tmp"), "partial", "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      SYSTEM_LOG_FILE: systemLogFile,
      UPLOAD_DIR: uploadDir,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /检测到未完成的运行数据恢复残留/
      );
    }
  );
});

test("生产环境同样拒绝恢复回滚残留", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-rollback-residue-"));
  const dataFile = join(directory, "store.json");
  const systemLogFile = join(directory, "system-audit.ndjson");
  const uploadDir = join(directory, "uploads");
  writeFileSync(dataFile, `${JSON.stringify(createSeededPersistedState(), null, 2)}\n`, "utf8");
  writeFileSync(systemLogFile, '{"event":"baseline"}\n', "utf8");
  writeFileSync(join(directory, ".system-audit.ndjson.rollback-test.tmp"), "rollback", "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      SYSTEM_LOG_FILE: systemLogFile,
      UPLOAD_DIR: uploadDir,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /检测到未完成的运行数据恢复残留/
      );
    }
  );
});
