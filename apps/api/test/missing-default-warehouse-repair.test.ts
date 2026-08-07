import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createEmptyPersistedState,
  PersistedStateWriteError
} from "../src/common/store/persistence.js";
import { applyDefaultWarehouseRepair } from "../src/scripts/repair-missing-default-warehouse.js";

const apiRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = resolve(apiRoot, "../../node_modules/tsx/dist/cli.mjs");
const repairScript = resolve(
  apiRoot,
  "src/scripts/repair-missing-default-warehouse.ts"
);

const createLiveRuntime = () => {
  const root = mkdtempSync(join(tmpdir(), "vm-default-warehouse-repair-"));
  const instanceId = "live-warehouse-repair-test";
  const dataFile = join(root, "store.json");
  const systemLogFile = join(root, "system-audit.ndjson");
  const state = createEmptyPersistedState("live", instanceId);
  state.initializationSource = "live-bootstrap";
  state.platformTenants.push({
    id: instanceId,
    code: "current",
    name: "仓库修复测试实例",
    serviceMode: "production",
    status: "active",
    instanceUrl: "https://warehouse-repair.example.test",
    createdAt: "2026-08-07T00:00:00.000Z"
  });
  mkdirSync(root, { recursive: true });
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  return {
    root,
    dataFile,
    systemLogFile,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "",
      VM_DATA_PLANE: "live",
      VM_DATA_ROOT: root,
      VM_DATA_PLANE_ID: instanceId,
      VM_PLATFORM_TENANT_NAME: "仓库修复测试实例",
      PUBLIC_BASE_URL: "https://warehouse-repair.example.test",
      API_DATA_FILE: "",
      SYSTEM_LOG_FILE: "",
      UPLOAD_DIR: "",
      API_BACKUP_DIR: "",
      FINANCIAL_SINGLE_WRITER_LEASE_FILE: "",
      TSX_TSCONFIG_PATH: resolve(apiRoot, "tsconfig.json")
    }
  };
};

const runRepair = (
  runtime: ReturnType<typeof createLiveRuntime>,
  ...args: string[]
) =>
  spawnSync(process.execPath, [tsxCli, repairScript, ...args], {
    cwd: apiRoot,
    env: runtime.env,
    encoding: "utf8"
  });

const createRepairAudit = (completedResult: boolean) => {
  const outcomes: string[] = [];
  const audit = {
    beginCriticalIntent: () => ({ operationId: "repair-test", startedAt: 100 }),
    completeCriticalOperation: (
      _operation: unknown,
      input: { outcome: string }
    ) => {
      outcomes.push(input.outcome);
      return input.outcome === "completed" ? completedResult : true;
    }
  } as Parameters<typeof applyDefaultWarehouseRepair>[1];

  return { audit, outcomes };
};

const createRepairStore = (persist: () => void) => ({
  warehouses: [],
  logOperation: () => undefined,
  persist
}) as unknown as Parameters<typeof applyDefaultWarehouseRepair>[0];

test("缺少显式备份确认时拒绝修复且不改写 live 数据", (t) => {
  const runtime = createLiveRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  const before = readFileSync(runtime.dataFile, "utf8");

  const result = runRepair(runtime);

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /confirm-backed-up-live-data/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), before);
  assert.equal(existsSync(runtime.systemLogFile), false);
});

test("受控修复为已完成初始化的 live 数据幂等补建默认仓库并写入审计", (t) => {
  const runtime = createLiveRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  const first = runRepair(runtime, "--confirm-backed-up-live-data");
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /默认本地仓库已补建/);

  const repaired = JSON.parse(readFileSync(runtime.dataFile, "utf8")) as {
    warehouses: Array<Record<string, unknown>>;
    logs: Array<Record<string, unknown>>;
  };
  assert.equal(repaired.warehouses.length, 1);
  assert.equal(repaired.warehouses[0]?.code, "WAREHOUSE-LOCAL");
  assert.equal(repaired.warehouses[0]?.name, "本地仓库");
  assert.equal(repaired.warehouses[0]?.status, "active");
  assert.equal(typeof repaired.warehouses[0]?.createdAt, "string");
  assert.equal(typeof repaired.warehouses[0]?.updatedAt, "string");
  assert.equal(
    repaired.logs.filter((entry) => entry.type === "repair-missing-default-warehouse").length,
    1
  );

  const auditContent = readFileSync(runtime.systemLogFile, "utf8");
  assert.match(auditContent, /repair-missing-default-warehouse/);
  assert.doesNotMatch(auditContent, /仓库修复测试实例/);

  const second = runRepair(runtime, "--confirm-backed-up-live-data");
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /已存在启用的本地仓库，无需重复修复/);

  const rerun = JSON.parse(readFileSync(runtime.dataFile, "utf8")) as {
    warehouses: Array<Record<string, unknown>>;
    logs: Array<Record<string, unknown>>;
  };
  assert.equal(rerun.warehouses.length, 1);
  assert.equal(
    rerun.logs.filter((entry) => entry.type === "repair-missing-default-warehouse").length,
    1
  );
});

test("默认仓库已持久化后完成审计失败时不再伪造失败终态", () => {
  let persisted = false;
  const { audit, outcomes } = createRepairAudit(false);
  const store = createRepairStore(() => {
    persisted = true;
  });

  const result = applyDefaultWarehouseRepair(store, audit, () => 200);

  assert.equal(persisted, true);
  assert.equal(store.warehouses.length, 1);
  assert.equal(result.auditCompleted, false);
  assert.equal(result.persistenceDurabilityConfirmed, true);
  assert.deepEqual(outcomes, ["completed"]);
});

test("默认仓库文件已替换但目录同步未确认时保留真实提交结果", () => {
  const { audit, outcomes } = createRepairAudit(true);
  const store = createRepairStore(() => {
    throw new PersistedStateWriteError("目录同步未确认", true);
  });

  const result = applyDefaultWarehouseRepair(store, audit, () => 200);

  assert.equal(store.warehouses.length, 1);
  assert.equal(result.auditCompleted, true);
  assert.equal(result.persistenceDurabilityConfirmed, false);
  assert.deepEqual(outcomes, ["completed"]);
});

test("默认仓库持久化未提交时记录失败终态并保持失败结果", () => {
  const { audit, outcomes } = createRepairAudit(true);
  const store = createRepairStore(() => {
    throw new PersistedStateWriteError("写入前失败", false);
  });

  assert.throws(
    () => applyDefaultWarehouseRepair(store, audit, () => 200),
    /写入前失败/
  );
  assert.deepEqual(outcomes, ["failed"]);
});

test("发布流程包含旧 live 实例默认仓库修复门禁且禁止提交后重试", () => {
  const releaseGuide = readFileSync(
    resolve(apiRoot, "../../docs/发布与公网部署验证流程.md"),
    "utf8"
  );

  assert.match(
    releaseGuide,
    /repair:missing-default-warehouse -- --confirm-backed-up-live-data/
  );
  assert.match(releaseGuide, /真实数据已经发生提交；不得重复执行修复/);
});
