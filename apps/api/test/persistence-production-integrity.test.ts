import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEmptyPersistedState,
  createSeededPersistedState,
  readPersistedStateWithMetadata
} from "../src/common/store/persistence.js";
import { FinancialSingleWriterLease } from "../src/common/coordination/financial-single-writer-lease.js";
import { installFinancialWriterFence } from "../src/common/coordination/financial-writer-fence.js";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";

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

test("非生产 live 平面也拒绝不完整状态，绝不以模拟种子回填", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-live-persistence-integrity-"));
  const root = join(directory, "live-root");
  const dataFile = join(root, "store.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      VM_DATA_PLANE: "live",
      VM_DATA_ROOT: root,
      VM_DATA_PLANE_ID: "live-read-test",
      VM_PLATFORM_TENANT_NAME: "真实读取测试实例",
      PUBLIC_BASE_URL: "https://live-read.example.test",
      API_DATA_FILE: "",
      SYSTEM_LOG_FILE: "",
      UPLOAD_DIR: "",
      API_BACKUP_DIR: "",
      FINANCIAL_SINGLE_WRITER_LEASE_FILE: "",
      NODE_ENV: "test",
      APP_ENV: undefined
    },
    () => {
      const state = createEmptyPersistedState();
      state.initializationSource = "live-bootstrap";
      state.platformTenants.push({
        id: "live-read-test",
        code: "current",
        name: "真实读取测试实例",
        status: "active",
        instanceUrl: "https://live-read.example.test",
        createdAt: "2026-01-01T00:00:00.000Z"
      });
      const rawState = state as unknown as Record<string, unknown>;
      delete rawState.users;
      mkdirSync(root, { recursive: true });
      writeFileSync(dataFile, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");

      assert.throws(
        () => readPersistedStateWithMetadata(),
        /运行数据完整性检查未通过/
      );
    }
  );
});

test("真实平面由受控初始化持久化唯一当前租户，并在启动时拒绝配置缺失或不一致", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-live-platform-tenant-"));
  const root = join(directory, "live-root");
  const dataFile = join(root, "store.json");
  const environment = {
    VM_DATA_PLANE: "live",
    VM_DATA_ROOT: root,
    VM_DATA_PLANE_ID: "live-tenant-test",
    VM_PLATFORM_TENANT_NAME: "真实租户测试实例",
    PUBLIC_BASE_URL: "https://live-tenant.example.test",
    API_DATA_FILE: "",
    SYSTEM_LOG_FILE: "",
    UPLOAD_DIR: "",
    API_BACKUP_DIR: "",
    FINANCIAL_SINGLE_WRITER_LEASE_FILE: "",
    NODE_ENV: "test",
    APP_ENV: undefined
  };
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(environment, () => {
    const state = createEmptyPersistedState();
    mkdirSync(root, { recursive: true });
    writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    assert.equal(state.platformTenants.length, 0);
    assert.throws(
      () => readPersistedStateWithMetadata(),
      /待初始化的真实数据平面只能由受控初始化命令读取/
    );

    state.initializationSource = "live-bootstrap";
    state.platformTenants.push({
      id: environment.VM_DATA_PLANE_ID,
      code: "current",
      name: environment.VM_PLATFORM_TENANT_NAME,
      status: "active",
      instanceUrl: environment.PUBLIC_BASE_URL,
      contactName: "实例管理员",
      planName: "正式版",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    assert.deepEqual(state.platformTenants, [
      {
        id: environment.VM_DATA_PLANE_ID,
        code: "current",
        name: environment.VM_PLATFORM_TENANT_NAME,
        status: "active",
        instanceUrl: environment.PUBLIC_BASE_URL,
        contactName: "实例管理员",
        planName: "正式版",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]);
    assert.ok(readPersistedStateWithMetadata());

    const wrongUrl = structuredClone(state);
    wrongUrl.platformTenants[0]!.instanceUrl = "https://other.example.test";
    writeFileSync(dataFile, `${JSON.stringify(wrongUrl, null, 2)}\n`, "utf8");
    assert.throws(
      () => readPersistedStateWithMetadata(),
      /客户实例 URL 必须与 PUBLIC_BASE_URL 一致/
    );

    writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    delete process.env.VM_PLATFORM_TENANT_NAME;
    assert.throws(
      () => readPersistedStateWithMetadata(),
      /缺少必填配置：VM_PLATFORM_TENANT_NAME/
    );
  });
});

test("仅完全无 marker 的历史模拟数据可进行一次兼容迁移，半迁移 marker 一律拒绝", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-legacy-simulation-marker-"));
  const dataFile = join(directory, "store.json");
  const legacy = createSeededPersistedState() as unknown as Record<string, unknown>;
  delete legacy.dataPlane;
  delete legacy.instanceId;
  delete legacy.initializationSource;
  writeFileSync(dataFile, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      VM_DATA_PLANE: "simulation",
      VM_DATA_ROOT: "",
      VM_DATA_PLANE_ID: "",
      API_DATA_FILE: dataFile,
      NODE_ENV: "test",
      APP_ENV: undefined
    },
    () => {
      const loaded = readPersistedStateWithMetadata();
      assert.ok(loaded);
      assert.equal(loaded.state.dataPlane, "simulation");
      assert.equal(loaded.state.instanceId, "simulation-default");
      assert.equal(loaded.state.initializationSource, "legacy-simulation");
      assert.equal(loaded.requiresDataPlaneRewrite, true);
    }
  );

  const invalidMarker = {
    ...createSeededPersistedState(),
    dataPlane: "not-a-plane"
  };
  writeFileSync(dataFile, `${JSON.stringify(invalidMarker, null, 2)}\n`, "utf8");

  withEnvironment(
    {
      VM_DATA_PLANE: "simulation",
      VM_DATA_ROOT: "",
      VM_DATA_PLANE_ID: "",
      API_DATA_FILE: dataFile,
      NODE_ENV: "test",
      APP_ENV: undefined
    },
    () => {
      assert.throws(
        () => readPersistedStateWithMetadata(),
        /运行数据平面标记无效或不完整/
      );
    }
  );
});

test("生产模拟平面在受控启动时补齐历史人工验证码签发集合", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-legacy-manual-grants-"));
  const dataFile = join(directory, "store.json");
  const legacy = createSeededPersistedState() as unknown as Record<string, unknown>;
  delete legacy.manualVerificationGrants;
  writeFileSync(dataFile, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      VM_DATA_PLANE: "simulation",
      VM_DATA_ROOT: "",
      VM_DATA_PLANE_ID: "",
      API_DATA_FILE: dataFile,
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    () => {
      const loaded = readPersistedStateWithMetadata();

      assert.ok(loaded);
      assert.deepEqual(loaded.state.manualVerificationGrants, []);
      assert.equal(loaded.requiresDataPlaneRewrite, true);
    }
  );
});

test("模拟平面拒绝人工验证码签发集合的非数组值", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-invalid-manual-grants-"));
  const dataFile = join(directory, "store.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  for (const invalidValue of [null, "not-an-array"]) {
    const state = createSeededPersistedState() as unknown as Record<string, unknown>;
    state.manualVerificationGrants = invalidValue;
    writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    withEnvironment(
      {
        VM_DATA_PLANE: "simulation",
        VM_DATA_ROOT: "",
        VM_DATA_PLANE_ID: "",
        API_DATA_FILE: dataFile,
        NODE_ENV: "test",
        APP_ENV: undefined
      },
      () => {
        assert.throws(
          () => readPersistedStateWithMetadata(),
          /运行数据完整性检查未通过/
        );
      }
    );
  }
});

test("受控启动把历史模拟快照的空人工验证码签发集合写回磁盘", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-manual-grants-bootstrap-"));
  const dataFile = join(directory, "store.json");
  const lockFile = join(directory, "financial-writer.lock");
  const legacy = createSeededPersistedState() as unknown as Record<string, unknown>;
  delete legacy.manualVerificationGrants;
  writeFileSync(dataFile, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      VM_DATA_PLANE: "simulation",
      VM_DATA_ROOT: "",
      VM_DATA_PLANE_ID: "",
      API_DATA_FILE: dataFile,
      FINANCIAL_SINGLE_WRITER_ENABLED: "true",
      NODE_ENV: "test",
      APP_ENV: undefined
    },
    () => {
      const lease = new FinancialSingleWriterLease({
        lockFile,
        ownerId: "manual-grants-bootstrap",
        autoHeartbeat: false
      });
      lease.acquire();
      const uninstall = installFinancialWriterFence(lease);

      try {
        const store = new InMemoryStoreService();
        assert.equal(store.flushBootstrapPersistence(), true);
        const rewritten = JSON.parse(readFileSync(dataFile, "utf8")) as Record<string, unknown>;
        assert.deepEqual(rewritten.manualVerificationGrants, []);
      } finally {
        uninstall();
        lease.release();
      }
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
