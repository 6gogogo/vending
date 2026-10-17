import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinancialSingleWriterLease } from "../src/common/coordination/financial-single-writer-lease";
import { withLinuxFileMutex } from "../src/common/coordination/linux-file-mutex";

const linux = { skip: process.platform !== "linux" };
const oldBoot = "00000000-0000-0000-0000-000000000001";
const oldDate = "2020-01-01T00:00:00.000Z";
const currentBoot = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const seed = (file: string, overrides: Record<string, unknown> = {}) => {
  const owner = { ownerId: "old", pid: 2147483647, hostname: hostname(), ...overrides };
  writeFileSync(file, JSON.stringify({ version: 2, fencingToken: "old-token",
    acquiredAt: oldDate, heartbeatAt: oldDate, expiresAt: oldDate, ...owner }));
  writeFileSync(`${file}.lifecycle`, JSON.stringify({ version: 1, token: "old-guard", createdAt: oldDate, ...owner }));
};
const scoped = (run: (file: string, dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "vm-lock-recovery-"));
  try { run(join(dir, "writer.lock"), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

test("Linux 遗留死进程的锁自动隔离，包含无启动标识的旧版本", linux, () => scoped((file, dir) => {
  seed(file);
  const lease = new FinancialSingleWriterLease({ lockFile: file, autoHeartbeat: false });
  try {
    lease.acquire(); lease.heartbeat(); lease.assertHeld();
    assert.equal(readdirSync(dir).filter(n => n.startsWith("writer.lock.lifecycle.stale.")).length, 1);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).bootId, currentBoot());
  } finally { lease.release(); }
}));

test("Linux 重启后 PID 被重用、时钟回退也不会误判旧锁为活写者", linux, () => scoped((file) => {
  seed(file, { pid: process.pid, bootId: oldBoot, expiresAt: "2099-01-01T00:00:00.000Z" });
  const lease = new FinancialSingleWriterLease({ lockFile: file, autoHeartbeat: false });
  try { lease.acquire(); lease.assertHeld(); } finally { lease.release(); }
}));

test("Linux 同次开机 PID 重用通过进程启动标识识别", linux, () => scoped((file) => {
  seed(file, { pid: process.pid, bootId: currentBoot(), processStartTicks: "0" });
  const lease = new FinancialSingleWriterLease({ lockFile: file, autoHeartbeat: false });
  try { lease.acquire(); lease.assertHeld(); } finally { lease.release(); }
}));

test("Linux 活进程、异机、损坏及未到期租约不会被自动清锁", linux, () => {
  for (const overrides of [
    { pid: process.pid }, { hostname: "unverifiable-other-host" },
    { expiresAt: "2099-01-01T00:00:00.000Z" }, { bootId: "invalid" }
  ]) scoped((file) => {
    seed(file, overrides);
    const before = readFileSync(`${file}.lifecycle`, "utf8");
    const lease = new FinancialSingleWriterLease({ lockFile: file, autoHeartbeat: false });
    assert.throws(() => lease.acquire());
    assert.equal(readFileSync(`${file}.lifecycle`, "utf8"), before);
  });
  scoped((file) => {
    seed(file); writeFileSync(`${file}.lifecycle`, "{");
    assert.throws(() => new FinancialSingleWriterLease({ lockFile: file }).acquire());
    assert.equal(readFileSync(`${file}.lifecycle`, "utf8"), "{");
  });
});

test("Linux flock 辅助进程退出后仍持有系统锁，关闭父 fd 才释放", linux, () => scoped((file) => {
  withLinuxFileMutex(file, () => {
    assert.equal(spawnSync("/usr/bin/flock", ["-n", file, "true"]).status, 1);
  });
  assert.equal(spawnSync("/usr/bin/flock", ["-n", file, "true"]).status, 0);
  assert.ok(existsSync(file), "永久锁锚点不能删除");
}));

for (const mode of ["crash-in-fence", "crash-before-heartbeat-publish"]) {
test(`Linux ${mode} 被 SIGKILL 后保留完整租约并自动恢复`, linux, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vm-lock-kill-"));
  const file = join(dir, "writer.lock"), ready = join(dir, "ready");
  const fixture = join(import.meta.dirname, "fixtures/financial-single-writer-child.ts");
  const child = spawn(process.execPath, ["--import", "tsx", fixture, file, "crash", mode, ready],
    { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, stderr || "子进程未就绪");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(spawnSync("/usr/bin/flock", ["-n", `${file}.lifecycle.mutex`, "true"]).status, 1);
    child.kill("SIGKILL"); await exited;
    assert.equal(JSON.parse(readFileSync(file, "utf8")).ownerId, "crash");
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const recovered = spawnSync(process.execPath, ["--import", "tsx", fixture, file, "recovered", "once"],
      { encoding: "utf8", timeout: 15_000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.ok(readdirSync(dir).some(n => n.startsWith("writer.lock.lifecycle.stale.")));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
}
