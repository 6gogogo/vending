import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FinancialSingleWriterLease } from "../src/common/coordination/financial-single-writer-lease.js";
import { createSeededPersistedState } from "../src/common/store/persistence.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(testDir, "..");
const tsxCli = resolve(apiRoot, "../../node_modules/tsx/dist/cli.mjs");
const maintenanceScript = resolve(apiRoot, "src/scripts/runtime-data-maintenance.ts");
const initDataScript = resolve(apiRoot, "src/scripts/init-data.ts");
const initEmptyDataScript = resolve(apiRoot, "src/scripts/init-empty-data.ts");
const initializeLiveDataScript = resolve(apiRoot, "src/scripts/initialize-live-data.ts");

interface IsolatedRuntime {
  root: string;
  env: NodeJS.ProcessEnv;
  dataFile: string;
  systemLogFile: string;
  uploadDir: string;
  backupDir: string;
}

const createIsolatedRuntime = (): IsolatedRuntime => {
  const root = mkdtempSync(join(tmpdir(), "vm-runtime-maintenance-"));
  const dataFile = join(root, "live", "store.json");
  const systemLogFile = join(root, "live", "system-audit.ndjson");
  const uploadDir = join(root, "live", "uploads");
  const backupDir = join(root, "backups");
  mkdirSync(dirname(dataFile), { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(
    dataFile,
    `${JSON.stringify(createSeededPersistedState("simulation-maintenance-test"), null, 2)}\n`,
    "utf8"
  );
  writeFileSync(systemLogFile, '{"event":"baseline"}\n', "utf8");
  writeFileSync(join(uploadDir, "sample.txt"), "upload-baseline", "utf8");

  return {
    root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      VM_DATA_PLANE: "simulation",
      VM_DATA_ROOT: "",
      VM_DATA_PLANE_ID: "simulation-maintenance-test",
      API_DATA_FILE: dataFile,
      SYSTEM_LOG_FILE: systemLogFile,
      UPLOAD_DIR: uploadDir,
      API_BACKUP_DIR: backupDir,
      FINANCIAL_SINGLE_WRITER_LEASE_FILE: join(
        root,
        "live",
        "financial-single-writer.lock"
      )
    },
    dataFile,
    systemLogFile,
    uploadDir,
    backupDir
  };
};

const runScript = (
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = apiRoot
) =>
  spawnSync(process.execPath, [
    tsxCli,
    ...(cwd === apiRoot ? [] : ["--tsconfig", resolve(apiRoot, "tsconfig.json")]),
    script,
    ...args
  ], {
    cwd,
    env,
    encoding: "utf8"
  });

const runMaintenance = (runtime: IsolatedRuntime, ...args: string[]) =>
  runScript(maintenanceScript, args, runtime.env);

const runMaintenanceAsync = (
  runtime: IsolatedRuntime,
  ...args: string[]
) =>
  new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, maintenanceScript, ...args],
      {
        cwd: apiRoot,
        env: runtime.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (status) => {
      resolveResult({ status, stdout, stderr });
    });
  });

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 10_000
) => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("等待维护脚本进入预期阶段超时。");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
};

const assertSucceeded = (result: ReturnType<typeof runScript>) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
};

const latestBackup = (runtime: IsolatedRuntime) =>
  join(
    runtime.backupDir,
    readdirSync(runtime.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .at(-1)!
  );

test("修复命令默认只读，且仅在摘要匹配时原子应用已证明安全的修复", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  const state = JSON.parse(readFileSync(runtime.dataFile, "utf8")) as Record<string, unknown>;
  const users = state.users as Array<Record<string, unknown>>;
  const goodsCatalog = state.goodsCatalog as Array<Record<string, unknown>>;
  const validGoods = goodsCatalog[0]!;
  const privateMarker = "repair-cli-private-marker";
  goodsCatalog.push({
    goodsId: privateMarker,
    goodsCode: `${privateMarker}-code`,
    name: "",
    category: "daily"
  });
  (state.inventory as Array<Record<string, unknown>>).push({
    id: `${privateMarker}-movement`,
    userId: users[0]!.id,
    deviceCode: "repair-cli-device",
    goodsId: validGoods.goodsId,
    type: "manual-deduction",
    quantity: 0,
    unitPrice: 0
  });
  (state.merchantGoodsTemplates as Array<Record<string, unknown>>).push({
    id: `${privateMarker}-template`,
    goodsId: `${privateMarker}-missing-goods`
  });
  writeFileSync(runtime.dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const beforeRepair = readFileSync(runtime.dataFile, "utf8");

  const dryRun = runMaintenance(runtime, "repair");
  assertSucceeded(dryRun);
  const dryOutput = `${dryRun.stdout}\n${dryRun.stderr}`;
  const sourceSha256 = dryOutput.match(/sourceSha256: ([a-f0-9]{64})/)?.[1];
  assert.ok(sourceSha256);
  assert.doesNotMatch(dryOutput, new RegExp(privateMarker));
  assert.equal(readFileSync(runtime.dataFile, "utf8"), beforeRepair);

  const mismatched = runMaintenance(
    runtime,
    "repair",
    "--apply",
    "--source-sha256",
    "0".repeat(64),
    "--yes"
  );
  assert.equal(mismatched.status, 1);
  assert.match(`${mismatched.stdout}\n${mismatched.stderr}`, /源数据摘要与修复计划不一致/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), beforeRepair);

  const missingConfirmation = runMaintenance(
    runtime,
    "repair",
    "--apply",
    "--source-sha256",
    sourceSha256
  );
  assert.equal(missingConfirmation.status, 1);
  assert.match(`${missingConfirmation.stdout}\n${missingConfirmation.stderr}`, /追加 --yes/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), beforeRepair);

  const applied = runMaintenance(
    runtime,
    "repair",
    "--apply",
    "--source-sha256",
    sourceSha256,
    "--yes"
  );
  assertSucceeded(applied);
  assert.match(`${applied.stdout}\n${applied.stderr}`, /运行数据修复完成/);
  assert.match(`${applied.stdout}\n${applied.stderr}`, /修复前证据已封存/);
  const repaired = readFileSync(runtime.dataFile, "utf8");
  assert.doesNotMatch(repaired, new RegExp(privateMarker));
  const evidenceRoot = join(runtime.backupDir, "repair-evidence");
  const evidenceDirectories = readdirSync(evidenceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(evidenceDirectories.length, 1);
  const evidenceDir = join(evidenceRoot, evidenceDirectories[0]!);
  assert.equal(readFileSync(join(evidenceDir, "store.json"), "utf8"), beforeRepair);
  assert.equal(
    readFileSync(join(evidenceDir, "system-audit.ndjson"), "utf8"),
    '{"event":"baseline"}\n'
  );
  assert.equal(readFileSync(join(evidenceDir, "uploads", "sample.txt"), "utf8"), "upload-baseline");
  const evidenceManifest = JSON.parse(
    readFileSync(join(evidenceDir, "repair-evidence-manifest.json"), "utf8")
  ) as {
    restorable: boolean;
    sourceSha256: string;
    dataPlane: { kind: string; planeId: string };
  };
  assert.equal(evidenceManifest.restorable, false);
  assert.equal(evidenceManifest.sourceSha256, sourceSha256);
  assert.deepEqual(evidenceManifest.dataPlane, {
    kind: "simulation",
    planeId: "simulation-maintenance-test"
  });
  const repairAuditEntries = readFileSync(runtime.systemLogFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { metadata?: Record<string, unknown> })
    .filter((entry) => entry.metadata?.operationClass === "runtime-data-repair");
  assert.equal(repairAuditEntries.length, 2);
  assert.equal(repairAuditEntries[0]?.metadata?.auditPhase, "intent");
  assert.equal(repairAuditEntries[1]?.metadata?.auditPhase, "completed");
  assert.equal(
    repairAuditEntries[0]?.metadata?.repairEvidenceManifestSha256,
    repairAuditEntries[1]?.metadata?.repairEvidenceManifestSha256
  );
  assertSucceeded(runMaintenance(runtime, "verify"));
});

test("测试种子和空库初始化命令拒绝覆盖任意已有审计证据", (t) => {
  const evidenceCases: Array<{
    name: string;
    prepare: (runtime: IsolatedRuntime) => string;
  }> = [
    {
      name: "业务数据文件",
      prepare: (runtime) => {
        mkdirSync(dirname(runtime.dataFile), { recursive: true });
        writeFileSync(runtime.dataFile, "{\"historical\":true}\n", "utf8");
        return runtime.dataFile;
      }
    },
    {
      name: "系统审计日志",
      prepare: (runtime) => {
        mkdirSync(dirname(runtime.systemLogFile), { recursive: true });
        writeFileSync(runtime.systemLogFile, '{"event":"historical-evidence"}\n', "utf8");
        return runtime.systemLogFile;
      }
    },
    {
      name: "上传目录",
      prepare: (runtime) => {
        mkdirSync(runtime.uploadDir, { recursive: true });
        const markerPath = join(runtime.uploadDir, "historical-evidence.txt");
        writeFileSync(markerPath, "upload-evidence", "utf8");
        return markerPath;
      }
    },
    {
      name: "备份目录",
      prepare: (runtime) => {
        mkdirSync(runtime.backupDir, { recursive: true });
        const markerPath = join(runtime.backupDir, "historical-evidence.txt");
        writeFileSync(markerPath, "backup-evidence", "utf8");
        return markerPath;
      }
    }
  ];

  for (const evidenceCase of evidenceCases) {
    const runtime = createIsolatedRuntime();
    t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
    rmSync(dirname(runtime.dataFile), { recursive: true, force: true });
    rmSync(runtime.backupDir, { recursive: true, force: true });
    mkdirSync(dirname(runtime.dataFile), { recursive: true });
    const protectedPath = evidenceCase.prepare(runtime);
    const protectedBefore = readFileSync(protectedPath, "utf8");
    const dataExistedBefore = existsSync(runtime.dataFile);
    const dataBefore = dataExistedBefore ? readFileSync(runtime.dataFile, "utf8") : undefined;

    for (const script of [initDataScript, initEmptyDataScript]) {
      const result = runScript(script, ["--confirm-reset"], runtime.env);
      assert.equal(result.status, 1, `${evidenceCase.name}: ${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /已拒绝覆盖审计证据/);
      assert.equal(readFileSync(protectedPath, "utf8"), protectedBefore);
      assert.equal(existsSync(runtime.dataFile), dataExistedBefore);

      if (dataBefore !== undefined) {
        assert.equal(readFileSync(runtime.dataFile, "utf8"), dataBefore);
      }
    }
  }
});

test("自动 repair 拒绝缺失原始数据平面标记，且不创建证据归档或改写数据", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  const state = JSON.parse(readFileSync(runtime.dataFile, "utf8")) as Record<string, unknown>;
  delete state.dataPlane;
  delete state.instanceId;
  delete state.initializationSource;
  writeFileSync(runtime.dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const before = readFileSync(runtime.dataFile, "utf8");

  const dryRun = runMaintenance(runtime, "repair");
  assertSucceeded(dryRun);
  const sourceSha256 = `${dryRun.stdout}\n${dryRun.stderr}`.match(/sourceSha256: ([a-f0-9]{64})/)?.[1];
  assert.ok(sourceSha256);

  const applied = runMaintenance(
    runtime,
    "repair",
    "--apply",
    "--source-sha256",
    sourceSha256,
    "--yes"
  );
  assert.equal(applied.status, 1);
  assert.match(`${applied.stdout}\n${applied.stderr}`, /数据平面标记与受控部署配置不一致/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), before);
  assert.equal(existsSync(join(runtime.backupDir, "repair-evidence")), false);
});

test("真实数据平面禁止自动 repair --apply", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vm-live-repair-blocked-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runScript(
    maintenanceScript,
    ["repair", "--apply", "--source-sha256", "0".repeat(64), "--yes"],
    {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "",
      VM_DATA_PLANE: "live",
      VM_DATA_ROOT: root,
      VM_DATA_PLANE_ID: "live-repair-blocked-test",
      API_DATA_FILE: "",
      SYSTEM_LOG_FILE: "",
      UPLOAD_DIR: "",
      API_BACKUP_DIR: "",
      FINANCIAL_SINGLE_WRITER_LEASE_FILE: ""
    }
  );

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /真实数据平面禁止自动 repair/);
  assert.deepEqual(readdirSync(root), []);
});

test("POSIX 新建备份目录和敏感文件使用私有权限", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 由 NTFS ACL 管理，不断言 POSIX mode。");
    return;
  }

  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "private-mode"));
  const backup = latestBackup(runtime);

  for (const targetPath of [
    backup,
    join(backup, "store.json"),
    join(backup, "system-audit.ndjson"),
    join(backup, "runtime-backup-manifest.json"),
    join(backup, "uploads", "sample.txt")
  ]) {
    assert.equal(statSync(targetPath).mode & 0o077, 0, targetPath);
  }
});

test("备份要求独占金融单写者租约，避免在线混合快照", (t) => {
  const runtime = createIsolatedRuntime();
  const lease = new FinancialSingleWriterLease({
    lockFile: runtime.env.FINANCIAL_SINGLE_WRITER_LEASE_FILE!,
    ownerId: "active-api",
    autoHeartbeat: false
  });
  lease.acquire();
  t.after(() => {
    lease.release();
    rmSync(runtime.root, { recursive: true, force: true });
  });

  const backup = runMaintenance(runtime, "backup", "--label", "must-be-stopped");

  assert.equal(backup.status, 1);
  assert.match(
    `${backup.stdout}\n${backup.stderr}`,
    /已有其他实例持有金融单写者租约/
  );
  assert.equal(existsSync(runtime.backupDir), false);
});

test("备份校验会拒绝清单中缺失的上传文件", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "missing-upload"));
  const backup = latestBackup(runtime);
  rmSync(join(backup, "uploads", "sample.txt"));

  const verification = runMaintenance(runtime, "verify", "--backup", backup);
  assert.equal(verification.status, 1);
  assert.match(`${verification.stdout}\n${verification.stderr}`, /备份文件缺失：uploads\/sample\.txt/);
});

test("备份校验会拒绝清单未声明的额外上传文件", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "unlisted-upload"));
  const backup = latestBackup(runtime);
  writeFileSync(join(backup, "uploads", "unlisted.txt"), "not-in-manifest", "utf8");

  const verification = runMaintenance(runtime, "verify", "--backup", backup);
  assert.equal(verification.status, 1);
  assert.match(
    `${verification.stdout}\n${verification.stderr}`,
    /备份包含清单未声明的文件：uploads\/unlisted\.txt/
  );
});

test("恢复会拒绝在初次校验后被替换的备份文件，且不覆盖当前账本", async (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "toctou-source"));
  const backup = latestBackup(runtime);
  const currentState = JSON.parse(
    readFileSync(runtime.dataFile, "utf8")
  ) as ReturnType<typeof createSeededPersistedState>;
  currentState.reservationSettings.holdMinutes = 75;
  writeFileSync(
    runtime.dataFile,
    `${JSON.stringify(currentState, null, 2)}\n`,
    "utf8"
  );
  const currentStoreBeforeRestore = readFileSync(runtime.dataFile, "utf8");

  const slowUploadDir = join(runtime.uploadDir, "safety-backup-delay");
  mkdirSync(slowUploadDir, { recursive: true });
  for (let index = 0; index < 500; index += 1) {
    writeFileSync(
      join(slowUploadDir, `${index.toString().padStart(4, "0")}.txt`),
      "delay",
      "utf8"
    );
  }

  const backupDirectoriesBeforeRestore = new Set(
    readdirSync(runtime.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  );
  const restore = runMaintenanceAsync(
    runtime,
    "restore",
    "--backup",
    backup,
    "--yes"
  );

  await waitFor(() =>
    existsSync(runtime.backupDir) &&
    readdirSync(runtime.backupDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        !backupDirectoriesBeforeRestore.has(entry.name)
    )
  );

  const tamperedStorePath = join(backup, "store.json");
  const tamperedState = JSON.parse(
    readFileSync(tamperedStorePath, "utf8")
  ) as ReturnType<typeof createSeededPersistedState>;
  tamperedState.reservationSettings.holdMinutes = 90;
  writeFileSync(
    tamperedStorePath,
    `${JSON.stringify(tamperedState, null, 2)}\n`,
    "utf8"
  );

  const result = await restore;
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /恢复暂存文件与备份清单不一致：store\.json/
  );
  assert.equal(readFileSync(runtime.dataFile, "utf8"), currentStoreBeforeRestore);
});

test("当前数据校验会拒绝越界预约设置、非法库存数量和损坏的审计日志", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  const state = JSON.parse(readFileSync(runtime.dataFile, "utf8")) as Record<string, unknown>;
  (state.reservationSettings as Record<string, unknown>).holdMinutes = 0;
  ((state.goodsBatches as Array<Record<string, unknown>>)[0]!).quantity = "4";
  writeFileSync(runtime.dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeFileSync(runtime.systemLogFile, "not-json\n", "utf8");

  const verification = runMaintenance(runtime, "verify");
  assert.equal(verification.status, 1);
  const output = `${verification.stdout}\n${verification.stderr}`;
  assert.match(output, /reservationSettings\.holdMinutes 必须是 5 至 1440 的整数/);
  assert.match(output, /goodsBatches\[0\]\.quantity 必须是整数且不小于 0/);
  assert.match(output, /系统审计日志第 1 行不是合法 JSON。/);
});

test("已有运行数据缺失系统审计日志时，校验和备份都必须失败", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  rmSync(runtime.systemLogFile);

  const verification = runMaintenance(runtime, "verify");
  assert.equal(verification.status, 1);
  assert.match(`${verification.stdout}\n${verification.stderr}`, /未找到系统审计日志/);

  const backup = runMaintenance(runtime, "backup", "--label", "missing-audit-log");
  assert.equal(backup.status, 1);
  assert.match(`${backup.stdout}\n${backup.stderr}`, /未找到系统审计日志/);
  assert.equal(existsSync(runtime.backupDir), false);
});

test("备份校验拒绝未纳入系统审计日志的不完整清单", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "incomplete-audit-log"));
  const backup = latestBackup(runtime);
  const manifestPath = join(backup, "runtime-backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    included: { systemLog: boolean };
    items: Array<{ key: string }>;
  };
  manifest.included.systemLog = false;
  manifest.items = manifest.items.filter((item) => item.key !== "systemLog");
  rmSync(join(backup, "system-audit.ndjson"));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const verification = runMaintenance(runtime, "verify", "--backup", backup);
  assert.equal(verification.status, 1);
  assert.match(`${verification.stdout}\n${verification.stderr}`, /系统审计日志/);
});

test("--keep 1 只保留当前最新的一份备份", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "one", "--keep", "1"));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "two", "--keep", "1"));

  const backups = readdirSync(runtime.backupDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(backups.length, 1);
  assert.match(backups[0]!.name, /-two$/);
});

test("--latest 和 --keep 绝不选择或删除同一备份根中的其他数据平面证据", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "simulation-one"));
  const simulationOne = latestBackup(runtime);
  const foreignEvidence = join(runtime.backupDir, "9999-foreign-live-evidence");
  cpSync(simulationOne, foreignEvidence, { recursive: true });
  const foreignManifestPath = join(foreignEvidence, "runtime-backup-manifest.json");
  const foreignManifest = JSON.parse(readFileSync(foreignManifestPath, "utf8")) as {
    dataPlane: { kind: string; planeId: string };
  };
  foreignManifest.dataPlane = {
    kind: "live",
    planeId: "foreign-live-instance"
  };
  writeFileSync(foreignManifestPath, `${JSON.stringify(foreignManifest, null, 2)}\n`, "utf8");

  const latestVerification = runMaintenance(runtime, "verify", "--latest");
  assertSucceeded(latestVerification);
  assert.match(`${latestVerification.stdout}\n${latestVerification.stderr}`, /simulation-one/);
  assert.equal(existsSync(foreignEvidence), true);

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "simulation-two", "--keep", "1"));
  const backupNames = readdirSync(runtime.backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(backupNames.includes("9999-foreign-live-evidence"), true);
  assert.equal(backupNames.filter((name) => name.includes("simulation-")).length, 1);
  assert.equal(backupNames.some((name) => name.endsWith("-simulation-two")), true);
});

test("备份清单与内部业务数据平面标记不一致时，verify、latest 和 restore 均拒绝使用", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "trusted-source"));
  const trustedBackup = latestBackup(runtime);
  const poisonedBackup = join(runtime.backupDir, "9999-poisoned-data-plane");
  cpSync(trustedBackup, poisonedBackup, { recursive: true });
  const poisonedStore = join(poisonedBackup, "store.json");
  const poisonedState = JSON.parse(readFileSync(poisonedStore, "utf8")) as Record<string, unknown>;
  poisonedState.instanceId = "simulation-poisoned-instance";
  writeFileSync(poisonedStore, `${JSON.stringify(poisonedState, null, 2)}\n`, "utf8");
  const manifestPath = join(poisonedBackup, "runtime-backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    items: Array<{ key: string; bytes: number; sha256: string }>;
  };
  const storeItem = manifest.items.find((item) => item.key === "store");
  assert.ok(storeItem);
  const poisonedBytes = readFileSync(poisonedStore);
  storeItem.bytes = poisonedBytes.length;
  storeItem.sha256 = createHash("sha256").update(poisonedBytes).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const directVerify = runMaintenance(runtime, "verify", "--backup", poisonedBackup);
  assert.equal(directVerify.status, 1);
  assert.match(
    `${directVerify.stdout}\n${directVerify.stderr}`,
    /数据平面标记与受控部署配置不一致/
  );

  const latestVerify = runMaintenance(runtime, "verify", "--latest");
  assertSucceeded(latestVerify);
  assert.match(`${latestVerify.stdout}\n${latestVerify.stderr}`, /trusted-source/);

  const originalStore = readFileSync(runtime.dataFile, "utf8");
  const restore = runMaintenance(runtime, "restore", "--backup", poisonedBackup, "--yes");
  assert.equal(restore.status, 1);
  assert.match(`${restore.stdout}\n${restore.stderr}`, /数据平面标记与受控部署配置不一致/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), originalStore);
  assert.equal(
    readdirSync(runtime.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .some((entry) => entry.name.includes("pre-restore-")),
    false
  );
});

test("恢复先校验确认，再逐项替换业务数据、日志和上传目录", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  const originalStore = readFileSync(runtime.dataFile, "utf8");
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "restore-source"));
  const backup = latestBackup(runtime);

  writeFileSync(runtime.dataFile, `${JSON.stringify({ corrupted: true })}\n`, "utf8");
  writeFileSync(runtime.systemLogFile, '{"event":"changed"}\n', "utf8");
  writeFileSync(join(runtime.uploadDir, "sample.txt"), "upload-changed", "utf8");

  const missingConfirmation = runMaintenance(runtime, "restore", "--backup", backup);
  assert.equal(missingConfirmation.status, 1);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), '{"corrupted":true}\n');

  assertSucceeded(
    runMaintenance(runtime, "restore", "--backup", backup, "--yes", "--no-safety-backup")
  );
  assert.equal(readFileSync(runtime.dataFile, "utf8"), originalStore);
  assert.equal(readFileSync(runtime.systemLogFile, "utf8"), '{"event":"baseline"}\n');
  assert.equal(readFileSync(join(runtime.uploadDir, "sample.txt"), "utf8"), "upload-baseline");
  assert.equal(
    readdirSync(dirname(runtime.dataFile)).some((name) => /\.(?:staging|rollback)-.*\.tmp$/.test(name)),
    false
  );
});

test("恢复拒绝跳过系统审计日志，保持当前数据不变", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "audit-bound-restore"));
  const backup = latestBackup(runtime);

  writeFileSync(runtime.dataFile, '{"corrupted":true}\n', "utf8");
  writeFileSync(runtime.systemLogFile, '{"event":"newer"}\n', "utf8");

  const result = runMaintenance(
    runtime,
    "restore",
    "--backup",
    backup,
    "--yes",
    "--skip-system-log",
    "--no-safety-backup"
  );

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /恢复不能跳过系统审计日志/
  );
  assert.equal(readFileSync(runtime.dataFile, "utf8"), '{"corrupted":true}\n');
  assert.equal(readFileSync(runtime.systemLogFile, "utf8"), '{"event":"newer"}\n');
});

test("备份平面实例标识不一致时，恢复在创建安全备份前失败且不改写数据", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "plane-source"));
  const backup = latestBackup(runtime);
  const storeBefore = readFileSync(runtime.dataFile, "utf8");
  const logBefore = readFileSync(runtime.systemLogFile, "utf8");
  const uploadsBefore = readFileSync(join(runtime.uploadDir, "sample.txt"), "utf8");
  const otherPlaneRuntime: IsolatedRuntime = {
    ...runtime,
    env: {
      ...runtime.env,
      VM_DATA_PLANE_ID: "simulation-other-instance"
    }
  };

  const result = runMaintenance(
    otherPlaneRuntime,
    "restore",
    "--backup",
    backup,
    "--yes"
  );

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /数据平面与当前运行平面不一致/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), storeBefore);
  assert.equal(readFileSync(runtime.systemLogFile, "utf8"), logBefore);
  assert.equal(readFileSync(join(runtime.uploadDir, "sample.txt"), "utf8"), uploadsBefore);
  assert.equal(
    readdirSync(runtime.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .some((entry) => entry.name.includes("pre-restore-")),
    false
  );
});

test("POSIX 恢复上传文件时收紧为私有权限", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 由 NTFS ACL 管理，不断言 POSIX mode。");
    return;
  }

  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  assertSucceeded(runMaintenance(runtime, "backup", "--label", "restore-private-upload"));
  const backup = latestBackup(runtime);
  const backupUpload = join(backup, "uploads", "sample.txt");
  chmodSync(backupUpload, 0o644);
  chmodSync(join(runtime.uploadDir, "sample.txt"), 0o644);

  assertSucceeded(
    runMaintenance(runtime, "restore", "--backup", backup, "--yes", "--no-safety-backup")
  );
  assert.equal(statSync(join(runtime.uploadDir, "sample.txt")).mode & 0o077, 0);
});

test("恢复拒绝使用位于 UPLOAD_DIR 内的备份，且不会改写现有数据", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));

  assertSucceeded(runMaintenance(runtime, "backup", "--label", "overlap-source"));
  const backup = latestBackup(runtime);
  const overlappingBackup = join(runtime.uploadDir, "nested-backup");
  cpSync(backup, overlappingBackup, { recursive: true });
  const originalStore = readFileSync(runtime.dataFile, "utf8");

  const restore = runMaintenance(
    runtime,
    "restore",
    "--backup",
    overlappingBackup,
    "--yes",
    "--no-safety-backup"
  );
  assert.equal(restore.status, 1);
  assert.match(`${restore.stdout}\n${restore.stderr}`, /恢复目标与备份目录不能重叠/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), originalStore);
});

test("生产环境初始化除通用确认外还要求逐字确认数据文件", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  const originalStore = readFileSync(runtime.dataFile, "utf8");
  const productionEnv = {
    ...runtime.env,
    NODE_ENV: "production"
  };

  const reset = runScript(initDataScript, ["--confirm-reset"], productionEnv);
  assert.equal(reset.status, 2);
  assert.match(`${reset.stdout}\n${reset.stderr}`, /confirm-production-data-file/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), originalStore);
});

test("真实初始化在取得租约或写入前拒绝混有历史审计证据的数据根", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vm-live-init-evidence-"));
  const auditFile = join(root, "system-audit.ndjson");
  const dataFile = join(root, "store.json");
  writeFileSync(auditFile, '{"event":"historical-evidence"}\n', "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runScript(
    initializeLiveDataScript,
    ["--confirm-live-initialization"],
    {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "",
      VM_DATA_PLANE: "live",
      VM_DATA_ROOT: root,
      VM_DATA_PLANE_ID: "live-init-evidence-test",
      API_DATA_FILE: "",
      SYSTEM_LOG_FILE: "",
      UPLOAD_DIR: "",
      API_BACKUP_DIR: "",
      FINANCIAL_SINGLE_WRITER_LEASE_FILE: "",
      VM_INITIAL_SUPER_ADMIN_USERNAME: "live-bootstrap-admin",
      VM_INITIAL_SUPER_ADMIN_PASSWORD: "test-only-initial-password",
      VM_INITIAL_SUPER_ADMIN_PHONE: "13900000000",
      VM_INITIAL_SUPER_ADMIN_NAME: "测试初始化管理员"
    }
  );

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /真实数据根目录含有遗留文件/);
  assert.equal(existsSync(dataFile), false);
  assert.equal(readFileSync(auditFile, "utf8"), '{"event":"historical-evidence"}\n');
});

test("真实初始化命令会从当前 API 工作区加载受控 .env", (t) => {
  const commandRoot = mkdtempSync(join(tmpdir(), "vm-live-init-env-command-"));
  const targetRoot = join(commandRoot, "live-root");
  writeFileSync(
    join(commandRoot, "package.json"),
    '{\n  "name": "@vm/api"\n}\n',
    "utf8"
  );
  writeFileSync(
    join(commandRoot, ".env"),
    [
      "NODE_ENV=test",
      "VM_DATA_PLANE=live",
      `VM_DATA_ROOT=${targetRoot.replaceAll("\\", "/")}`,
      "VM_DATA_PLANE_ID=live-env-command-test",
      "VM_PLATFORM_TENANT_NAME=命令配置正式实例",
      "PUBLIC_BASE_URL=https://vending.example.com",
      "VM_INITIAL_SUPER_ADMIN_USERNAME=env-command-admin",
      "VM_INITIAL_SUPER_ADMIN_PASSWORD=test-only-initial-password",
      "VM_INITIAL_SUPER_ADMIN_PHONE=13900000000",
      "VM_INITIAL_SUPER_ADMIN_NAME=命令配置管理员"
    ].join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(join(commandRoot, ".env"), 0o600);
  t.after(() => rmSync(commandRoot, { recursive: true, force: true }));

  const childEnv = { ...process.env };
  for (const key of [
    "APP_ENV",
    "VM_TEST_ISOLATED_ENV",
    "VM_SIMULATION_PROFILE",
    "VM_FULL_SIMULATION_ENABLED",
    "VM_DATA_PLANE",
    "VM_DATA_ROOT",
    "VM_DATA_PLANE_ID",
    "VM_PLATFORM_TENANT_NAME",
    "PUBLIC_BASE_URL",
    "API_DATA_FILE",
    "SYSTEM_LOG_FILE",
    "UPLOAD_DIR",
    "API_BACKUP_DIR",
    "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
    "VM_INITIAL_SUPER_ADMIN_USERNAME",
    "VM_INITIAL_SUPER_ADMIN_PASSWORD",
    "VM_INITIAL_SUPER_ADMIN_PHONE",
    "VM_INITIAL_SUPER_ADMIN_NAME",
    "VM_INITIAL_CREDENTIAL_SOURCE_DATA_FILE",
    "VM_INITIAL_TENANT_ADMIN_USERNAME"
  ]) {
    delete childEnv[key];
  }
  childEnv.NODE_ENV = "test";

  const result = runScript(
    initializeLiveDataScript,
    ["--confirm-live-initialization"],
    childEnv,
    commandRoot
  );

  assertSucceeded(result);
  const targetState = JSON.parse(
    readFileSync(join(targetRoot, "store.json"), "utf8")
  ) as ReturnType<typeof createSeededPersistedState>;
  assert.equal(targetState.dataPlane, "live");
  assert.equal(targetState.instanceId, "live-env-command-test");
  assert.equal(targetState.platformTenants[0]?.name, "命令配置正式实例");
});

test("真实初始化可只迁入现有非默认服务商与首管理员凭据散列", (t) => {
  const targetRoot = mkdtempSync(join(tmpdir(), "vm-live-init-credential-target-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "vm-live-init-credential-source-"));
  const sourceFile = join(sourceRoot, "store.json");
  const sourceState = createSeededPersistedState("simulation-credential-source");
  const sourceTenantId = sourceState.platformTenants[0]!.id;
  sourceState.users.unshift(
    {
      id: "provider-source-user",
      role: "admin",
      phone: "13911111111",
      name: "来源服务商",
      status: "active",
      regionName: "系统管理",
      neighborhood: "系统管理",
      tags: ["hidden-backoffice", "super-admin"],
      mobileProfileCompleted: false
    },
    {
      id: "tenant-admin-source-user",
      tenantId: sourceTenantId,
      role: "admin",
      phone: "13911111112",
      name: "来源实例管理员",
      status: "active",
      regionName: "实例运营",
      neighborhood: "实例运营",
      tags: ["实例管理员"],
      mobileProfileCompleted: true
    }
  );
  sourceState.backofficeCredentials.push(
    {
      userId: "provider-source-user",
      username: "provider-source",
      role: "super_admin",
      passwordSalt: "provider-source-salt",
      passwordHash: "provider-source-hash",
      usesDefaultPassword: false,
      passwordUpdatedAt: "2026-07-30T00:00:00.000Z"
    },
    {
      userId: "tenant-admin-source-user",
      username: "tenant-admin-source",
      role: "admin",
      tenantId: sourceTenantId,
      passwordSalt: "tenant-admin-source-salt",
      passwordHash: "tenant-admin-source-hash",
      usesDefaultPassword: false,
      passwordUpdatedAt: "2026-07-30T00:00:00.000Z"
    }
  );
  const providerCredential = sourceState.backofficeCredentials.find(
    (entry) => entry.role === "super_admin"
  );
  const tenantAdminCredential = sourceState.backofficeCredentials.find(
    (entry) => entry.role === "admin"
  );

  assert.ok(providerCredential);
  assert.ok(tenantAdminCredential);
  const sourceContent = `${JSON.stringify(sourceState, null, 2)}\n`;
  writeFileSync(sourceFile, sourceContent, { encoding: "utf8", mode: 0o600 });
  chmodSync(sourceFile, 0o600);
  t.after(() => {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  const result = runScript(
    initializeLiveDataScript,
    ["--confirm-live-initialization"],
    {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "",
      VM_DATA_PLANE: "live",
      VM_DATA_ROOT: targetRoot,
      VM_DATA_PLANE_ID: "xiaoguidai-live-test",
      VM_PLATFORM_TENANT_NAME: "小柜大爱",
      PUBLIC_BASE_URL: "https://vending.example.com",
      API_DATA_FILE: "",
      SYSTEM_LOG_FILE: "",
      UPLOAD_DIR: "",
      API_BACKUP_DIR: "",
      FINANCIAL_SINGLE_WRITER_LEASE_FILE: "",
      VM_INITIAL_CREDENTIAL_SOURCE_DATA_FILE: sourceFile,
      VM_INITIAL_SUPER_ADMIN_USERNAME: providerCredential.username,
      VM_INITIAL_TENANT_ADMIN_USERNAME: tenantAdminCredential.username,
      VM_INITIAL_SUPER_ADMIN_PASSWORD: "",
      VM_INITIAL_SUPER_ADMIN_PHONE: "",
      VM_INITIAL_SUPER_ADMIN_NAME: ""
    }
  );

  assertSucceeded(result);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(
      `${providerCredential.username}|${tenantAdminCredential.username}|provider-source|tenant-admin-source`,
      "u"
    )
  );
  assert.equal(readFileSync(sourceFile, "utf8"), sourceContent);

  const targetState = JSON.parse(
    readFileSync(join(targetRoot, "store.json"), "utf8")
  ) as ReturnType<typeof createSeededPersistedState>;
  assert.equal(targetState.dataPlane, "live");
  assert.equal(targetState.instanceId, "xiaoguidai-live-test");
  assert.equal(targetState.initializationSource, "live-bootstrap");
  assert.equal(targetState.platformTenants.length, 1);
  assert.equal(targetState.platformTenants[0]?.name, "小柜大爱");
  assert.equal(targetState.platformTenants[0]?.serviceMode, "production");
  assert.equal(targetState.users.length, 2);
  assert.equal(targetState.backofficeCredentials.length, 2);
  assert.equal(targetState.adminCredentials.length, 0);
  assert.equal(targetState.goodsCatalog.length, 0);
  assert.equal(targetState.devices.length, 0);
  assert.equal(targetState.paymentOrders.length, 0);
  assert.equal(targetState.reservations.length, 0);

  const importedProvider = targetState.backofficeCredentials.find(
    (entry) => entry.role === "super_admin"
  );
  const importedTenantAdmin = targetState.backofficeCredentials.find(
    (entry) => entry.role === "admin"
  );
  assert.equal(importedProvider?.passwordSalt, providerCredential.passwordSalt);
  assert.equal(importedProvider?.passwordHash, providerCredential.passwordHash);
  assert.equal(importedProvider?.usesDefaultPassword, false);
  assert.equal(importedProvider?.tenantId, undefined);
  assert.equal(importedTenantAdmin?.passwordSalt, tenantAdminCredential.passwordSalt);
  assert.equal(importedTenantAdmin?.passwordHash, tenantAdminCredential.passwordHash);
  assert.equal(importedTenantAdmin?.usesDefaultPassword, false);
  assert.equal(importedTenantAdmin?.tenantId, "xiaoguidai-live-test");
  assert.equal(importedTenantAdmin?.permissions, undefined);
});

test("清空脚本在写入前拒绝 UPLOAD_DIR 与运行数据路径重叠", (t) => {
  const runtime = createIsolatedRuntime();
  t.after(() => rmSync(runtime.root, { recursive: true, force: true }));
  const originalStore = readFileSync(runtime.dataFile, "utf8");
  const overlappingEnv = {
    ...runtime.env,
    UPLOAD_DIR: dirname(runtime.dataFile)
  };

  const reset = runScript(initEmptyDataScript, ["--confirm-reset"], overlappingEnv);
  assert.equal(reset.status, 1);
  assert.match(
    `${reset.stdout}\n${reset.stderr}`,
    /(?:UPLOAD_DIR 不能与运行数据文件重叠|API_DATA_FILE 不能与 UPLOAD_DIR 重叠)/
  );
  assert.equal(readFileSync(runtime.dataFile, "utf8"), originalStore);
});
