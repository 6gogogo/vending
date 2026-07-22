import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  writeFileSync(dataFile, `${JSON.stringify(createSeededPersistedState(), null, 2)}\n`, "utf8");
  writeFileSync(systemLogFile, '{"event":"baseline"}\n', "utf8");
  writeFileSync(join(uploadDir, "sample.txt"), "upload-baseline", "utf8");

  return {
    root,
    env: {
      ...process.env,
      NODE_ENV: "test",
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

const runScript = (script: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: apiRoot,
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
    "0".repeat(64)
  );
  assert.equal(mismatched.status, 1);
  assert.match(`${mismatched.stdout}\n${mismatched.stderr}`, /源数据摘要与修复计划不一致/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), beforeRepair);

  const applied = runMaintenance(
    runtime,
    "repair",
    "--apply",
    "--source-sha256",
    sourceSha256
  );
  assertSucceeded(applied);
  assert.match(`${applied.stdout}\n${applied.stderr}`, /运行数据修复完成/);
  const repaired = readFileSync(runtime.dataFile, "utf8");
  assert.doesNotMatch(repaired, new RegExp(privateMarker));
  assertSucceeded(runMaintenance(runtime, "verify"));
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
  assert.match(`${reset.stdout}\n${reset.stderr}`, /UPLOAD_DIR 不能与运行数据文件重叠/);
  assert.equal(readFileSync(runtime.dataFile, "utf8"), originalStore);
});
