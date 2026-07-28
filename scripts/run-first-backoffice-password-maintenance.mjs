import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  API_SERVICE_UNIT,
  assertLocalGraphicalLogindSession,
  createFirstBackofficeMaintenanceCancellationCoordinator,
  createFirstBackofficeMaintenanceSignalGuard,
  isStoppedServiceState,
  isGnomeTerminalVteCgroup,
  LOGIND_COMMAND_ENVIRONMENT,
  parseLogindSessionProperties,
  parseLogindSessionIdProperty,
  parseLogindSessionObjectPath,
  parseLogindUserSessionIds,
  resolveCurrentLogindSessionId,
  resolveFirstBackofficeMaintenancePlan,
  resolveSystemBusctlArguments,
  runFirstBackofficeMaintenanceRecovery,
  selectSingleActiveLocalGraphicalSession
} from "./first-backoffice-password-maintenance.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(currentFilePath), ".."));
const systemctlPath = "/usr/bin/systemctl";
const busctlPath = "/usr/bin/busctl";
const loginctlPath = "/usr/bin/loginctl";
const gitPath = "/usr/bin/git";
const HEALTH_URL = "http://127.0.0.1:8100/api/health";
const HEALTH_TIMEOUT_MS = 45_000;
const controlledFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const firstBackofficePasswordMaintenanceOperation = Object.freeze({
  operation: "首次后台密码维护",
  runnerFileName: "first-backoffice-password-maintenance-runner.mjs",
  dropInName: "95-first-backoffice-password-maintenance.conf",
  lockFileName: "vending-first-backoffice-password-maintenance.lock",
  failureMessage: "首次后台密码维护未完成；密码未成功初始化或前置校验失败。",
  successMessage: "首次后台密码维护完成，API 已恢复并通过本机健康检查。"
});

const hash = (value) => createHash("sha256").update(value).digest("hex");

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });

const runSystemctl = (args, { allowFailure = false, stdio = "inherit" } = {}) => {
  const result = spawnSync(systemctlPath, args, {
    encoding: "utf8",
    stdio
  });

  if (result.error) {
    throw result.error;
  }

  if (!allowFailure && result.status !== 0) {
    throw new Error(`systemctl 命令失败：${args.join(" ")}`);
  }

  return result;
};

const runSystemctlAsync = (
  args,
  { allowFailure = false, stdio = "inherit" } = {}
) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(systemctlPath, args, { stdio });

    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (!allowFailure && status !== 0) {
        reject(new Error(`systemctl 命令失败：${args.join(" ")}`));
        return;
      }

      resolveResult({ status, signal });
    });
  });

const systemctlValue = (property) => {
  const result = runSystemctl(
    ["--user", "show", API_SERVICE_UNIT, `--property=${property}`, "--value"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const value = String(result.stdout ?? "").trim();

  if (!value) {
    throw new Error(`无法读取受管 API 服务的 ${property}。`);
  }

  return value;
};

const executeBusctl = (args) =>
  spawnSync(busctlPath, resolveSystemBusctlArguments(args), {
    encoding: "utf8",
    env: LOGIND_COMMAND_ENVIRONMENT,
    stdio: ["ignore", "pipe", "pipe"]
  });

const runBusctl = (args) => {
  const result = executeBusctl(args);

  if (result.error || result.status !== 0) {
    throw new Error("无法由 logind 核验当前进程会话，拒绝维护。");
  }

  return String(result.stdout ?? "");
};

const runLoginctl = (args) => {
  const result = spawnSync(loginctlPath, args, {
    encoding: "utf8",
    env: LOGIND_COMMAND_ENVIRONMENT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error || result.status !== 0) {
    throw new Error("无法核验当前 logind 会话，拒绝在非本机上下文初始化密码。");
  }

  return String(result.stdout ?? "");
};

const readLogindSessionProperties = (sessionId) =>
  parseLogindSessionProperties(
    runLoginctl([
      "show-session",
      sessionId,
      "-p",
      "Remote",
      "-p",
      "Type",
      "-p",
      "Class",
      "-p",
      "State"
    ])
  );

const isNoKnownSessionBusctlFailure = (result) =>
  !result.error &&
  /(?:does not belong to any known session|no session for pid)/iu.test(
    String(result.stderr ?? "")
  );

const readSingleActiveLocalGraphicalSessionId = () => {
  const sessionIds = parseLogindUserSessionIds(
    runLoginctl([
      "show-user",
      String(process.getuid()),
      "-p",
      "Sessions",
      "--value"
    ])
  );

  return selectSingleActiveLocalGraphicalSession(
    sessionIds.map((id) => ({ id, properties: readLogindSessionProperties(id) }))
  );
};

const readCurrentLogindSessionId = () => {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8");
  const sessionLookup = executeBusctl([
    "call",
    "org.freedesktop.login1",
    "/org/freedesktop/login1",
    "org.freedesktop.login1.Manager",
    "GetSessionByPID",
    "u",
    String(process.pid)
  ]);

  if (sessionLookup.error || sessionLookup.status !== 0) {
    if (
      isNoKnownSessionBusctlFailure(sessionLookup) &&
      isGnomeTerminalVteCgroup({ cgroup, uid: process.getuid() })
    ) {
      return readSingleActiveLocalGraphicalSessionId();
    }

    throw new Error("无法由 logind 核验当前进程会话，拒绝维护。");
  }

  const sessionObjectPath = parseLogindSessionObjectPath(
    String(sessionLookup.stdout ?? "")
  );

  const sessionId = parseLogindSessionIdProperty(
    runBusctl([
      "get-property",
      "org.freedesktop.login1",
      sessionObjectPath,
      "org.freedesktop.login1.Session",
      "Id"
    ])
  );

  return resolveCurrentLogindSessionId({
    cgroup,
    busctlSessionId: sessionId
  });
};

const readCurrentLogindSessionProperties = () => {
  const sessionId = readCurrentLogindSessionId();
  return readLogindSessionProperties(sessionId);
};

const assertInteractiveLocalTerminal = () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error("首次后台密码维护只能在 Spark VNC 本机交互终端运行。");
  }

  const terminalPaths = [0, 1, 2].map((descriptor) =>
    realpathSync(`/proc/self/fd/${descriptor}`)
  );
  const [terminalPath] = terminalPaths;

  if (
    !/^\/dev\/pts\/\d+$/u.test(terminalPath) ||
    terminalPaths.some((entry) => entry !== terminalPath)
  ) {
    throw new Error("首次后台密码维护需要输入、输出和错误输出位于同一 VNC 本机伪终端。");
  }

  assertLocalGraphicalLogindSession(readCurrentLogindSessionProperties());

  return terminalPath;
};

const assertServiceUserDirectory = (
  directoryPath,
  name,
  { requirePrivateAccess = false } = {}
) => {
  const metadata = lstatSync(directoryPath);
  const prohibitedMode = requirePrivateAccess ? 0o077 : 0o022;

  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & prohibitedMode) !== 0
  ) {
    throw new Error(
      requirePrivateAccess
        ? `${name} 必须是当前服务用户私有的普通目录。`
        : `${name} 必须归当前服务用户所有，且不能被组或其他用户写入。`
    );
  }
};

const assertPrivateRegularFile = (filePath, name) => {
  const metadata = lstatSync(filePath);

  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${name} 必须是当前服务用户私有的普通文件。`);
  }
};

const createPrivateDirectory = (directoryPath, name) => {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { mode: 0o700 });
  }
  assertServiceUserDirectory(directoryPath, name, { requirePrivateAccess: true });
};

const ensureRuntimeSystemdDirectory = (runtimeDirectory, runtimeSystemdDirectory) => {
  const systemdDirectory = resolve(runtimeDirectory, "systemd");

  if (!existsSync(systemdDirectory)) {
    mkdirSync(systemdDirectory, { mode: 0o700 });
  }

  assertServiceUserDirectory(systemdDirectory, "systemd 运行时父目录");

  if (!existsSync(runtimeSystemdDirectory)) {
    mkdirSync(runtimeSystemdDirectory, { mode: 0o700 });
  }

  assertServiceUserDirectory(runtimeSystemdDirectory, "systemd 运行时目录");
};

const createExclusivePrivateFile = (filePath, contents) => {
  const descriptor = openSync(filePath, "wx", 0o600);

  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  assertPrivateRegularFile(filePath, "维护运行时文件");
};

const waitForActiveService = async () => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (systemctlValue("ActiveState") === "active") {
      return;
    }
    await sleep(500);
  }

  throw new Error("API 服务未能在恢复窗口内进入 active 状态。");
};

const waitForStoppedService = async () => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (
      isStoppedServiceState({
        activeState: systemctlValue("ActiveState"),
        mainPid: systemctlValue("MainPID")
      })
    ) {
      return;
    }
    await sleep(250);
  }

  throw new Error("API 服务未能在维护窗口内停止到无主进程状态。");
};

const waitForLocalHealth = async () => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = spawnSync(
      "/usr/bin/curl",
      ["--noproxy", "*", "--connect-timeout", "2", "--max-time", "3", "-sS", "-o", "/dev/null", "-w", "%{http_code}", HEALTH_URL],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );

    if (result.status === 0 && String(result.stdout ?? "").trim() === "200") {
      return;
    }
    await sleep(500);
  }

  throw new Error("API 服务已启动，但本机 /api/health 未在恢复窗口内返回 200。");
};

const assertCurrentRepositoryMatchesService = (operation) => {
  const workingDirectory = realpathSync(systemctlValue("WorkingDirectory"));

  if (workingDirectory !== repositoryRoot) {
    throw new Error(`必须从当前受管 API 服务的工作目录启动${operation}。`);
  }

  if (systemctlValue("LoadState") !== "loaded") {
    throw new Error("受管 API 服务未加载，拒绝修改运行时 drop-in。");
  }

  if (systemctlValue("ActiveState") !== "active") {
    throw new Error("受管 API 服务当前不是 active，拒绝覆盖其运行状态。");
  }

  const gitStatus = spawnSync(
    gitPath,
    ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=no"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  if (gitStatus.error || gitStatus.status !== 0) {
    throw new Error("无法确认受管工作树状态，拒绝启动首次密码维护。");
  }

  if (String(gitStatus.stdout ?? "").trim()) {
    throw new Error("受管工作树存在未提交的跟踪文件变更，拒绝启动首次密码维护。");
  }

  return workingDirectory;
};

const resolveVerifiedRunnerPath = (runnerFileName, operation) => {
  if (
    !controlledFileNamePattern.test(runnerFileName) ||
    !runnerFileName.endsWith(".mjs")
  ) {
    throw new Error("维护运行器必须是受控 scripts 目录中的 .mjs 文件。");
  }

  const runnerPath = resolve(repositoryRoot, "scripts", runnerFileName);
  const metadata = lstatSync(runnerPath);

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${operation}运行器必须是受管工作树中的普通文件。`);
  }

  const verifiedRunnerPath = realpathSync(runnerPath);
  const scriptsDirectory = realpathSync(resolve(repositoryRoot, "scripts"));

  if (dirname(verifiedRunnerPath) !== scriptsDirectory) {
    throw new Error(`${operation}运行器不能解析到受管 scripts 目录之外。`);
  }

  return verifiedRunnerPath;
};

const removeVerifiedDropIn = (dropInPath, expectedHash) => {
  assertPrivateRegularFile(dropInPath, "维护 drop-in");
  const actualHash = hash(readFileSync(dropInPath));

  if (actualHash !== expectedHash) {
    throw new Error("维护 drop-in 在运行期间发生变化，已拒绝覆盖；请保留现场人工恢复。");
  }

  unlinkSync(dropInPath);
};

const isVerifiedDropIn = (dropInPath, expectedHash) => {
  try {
    assertPrivateRegularFile(dropInPath, "维护 drop-in");
    return hash(readFileSync(dropInPath)) === expectedHash;
  } catch {
    return false;
  }
};

export const runBackofficePasswordMaintenance = async ({
  operation,
  runnerFileName,
  dropInName,
  lockFileName,
  failureMessage,
  successMessage
}) => {
  if (
    typeof operation !== "string" ||
    !operation ||
    !controlledFileNamePattern.test(dropInName) ||
    !dropInName.endsWith(".conf") ||
    !controlledFileNamePattern.test(lockFileName) ||
    !lockFileName.endsWith(".lock") ||
    typeof failureMessage !== "string" ||
    typeof successMessage !== "string"
  ) {
    throw new Error("后台密码维护操作配置无效，已拒绝执行。");
  }

  if (process.argv.length !== 2) {
    throw new Error(`${operation}命令不接受任何参数。`);
  }

  if (process.platform !== "linux") {
    throw new Error(`${operation}只能在 Spark Linux 主机运行。`);
  }

  const ttyPath = assertInteractiveLocalTerminal();
  const workingDirectory = assertCurrentRepositoryMatchesService(operation);
  const runtimeDirectory = `/run/user/${process.getuid()}`;
  const plan = resolveFirstBackofficeMaintenancePlan({
    runtimeDirectory,
    workingDirectory,
    nodeExecutable: realpathSync(process.execPath),
    runnerPath: resolveVerifiedRunnerPath(runnerFileName, operation),
    ttyPath,
    dropInName
  });
  const lockPath = resolve(runtimeDirectory, lockFileName);
  const temporaryDropInPath = `${plan.dropInPath}.${process.pid}.tmp`;
  const expectedDropInHash = hash(plan.contents);
  let lockCreated = false;
  let dropInInstalled = false;
  let serviceStopped = false;
  let maintenanceFailure;

  const stopSystemdMaintenanceJob = async () => {
    const result = await runSystemctlAsync(
      ["--user", "stop", API_SERVICE_UNIT],
      { allowFailure: true }
    );
    await waitForStoppedService();
    serviceStopped = true;
    return result;
  };

  const cancellationCoordinator =
    createFirstBackofficeMaintenanceCancellationCoordinator({
      stopMaintenanceJob: stopSystemdMaintenanceJob
    });

  const cancellationGuard = createFirstBackofficeMaintenanceSignalGuard(
    process,
    () => cancellationCoordinator.requestStop()
  );

  const stopMaintenanceAfterCancellation = async () => {
    if (!cancellationGuard.requestedSignal) {
      return;
    }

    cancellationCoordinator.requestStop();
    await cancellationCoordinator.waitForScheduledStop();

    cancellationGuard.throwIfRequested();
  };

  try {
    cancellationGuard.throwIfRequested();
    assertServiceUserDirectory(runtimeDirectory, "systemd 用户运行时目录", {
      requirePrivateAccess: true
    });
    createExclusivePrivateFile(lockPath, `${process.pid}\n`);
    lockCreated = true;
    cancellationGuard.throwIfRequested();
    ensureRuntimeSystemdDirectory(runtimeDirectory, plan.runtimeSystemdDirectory);

    if (existsSync(plan.dropInDirectory)) {
      assertServiceUserDirectory(plan.dropInDirectory, "维护 drop-in 目录", {
        requirePrivateAccess: true
      });
      if (lstatSync(plan.dropInDirectory).isSymbolicLink()) {
        throw new Error("维护 drop-in 目录不能是符号链接。");
      }
      if (readdirSync(plan.dropInDirectory).length > 0) {
        throw new Error("维护 drop-in 路径已存在未知内容，拒绝叠加运行器。");
      }
    } else {
      createPrivateDirectory(plan.dropInDirectory, "维护 drop-in 目录");
    }

    if (existsSync(plan.dropInPath) || existsSync(temporaryDropInPath)) {
      throw new Error("首次后台密码维护 drop-in 已存在，拒绝并发或覆盖执行。");
    }

    createExclusivePrivateFile(temporaryDropInPath, plan.contents);
    renameSync(temporaryDropInPath, plan.dropInPath);
    dropInInstalled = true;
    assertPrivateRegularFile(plan.dropInPath, "维护 drop-in");

    runSystemctl(["--user", "daemon-reload"]);
    cancellationGuard.throwIfRequested();
    const stopResult = runSystemctl(["--user", "stop", API_SERVICE_UNIT], {
      allowFailure: true
    });
    await waitForStoppedService();
    serviceStopped = true;
    cancellationGuard.throwIfRequested();

    if (stopResult.status !== 0) {
      throw new Error("API 服务停止命令异常，已停止维护并准备恢复原服务。");
    }

    cancellationCoordinator.armJob();
    const result = await runSystemctlAsync(
      ["--user", "start", "--wait", API_SERVICE_UNIT],
      { allowFailure: true }
    );
    await stopMaintenanceAfterCancellation();

    if (result.status !== 0 || result.signal) {
      await cancellationCoordinator.ensureJobStopped();
      maintenanceFailure = new Error(failureMessage);
    } else {
      await waitForStoppedService();
      cancellationCoordinator.markJobStopped();
      await stopMaintenanceAfterCancellation();
    }
  } finally {
    let restorationFailure;

    try {
      await cancellationCoordinator.waitForScheduledStop();
      await cancellationCoordinator.ensureJobStopped();
      const dropInIntegrity =
        !dropInInstalled ||
        (isVerifiedDropIn(plan.dropInPath, expectedDropInHash) &&
          (!existsSync(temporaryDropInPath) ||
            isVerifiedDropIn(temporaryDropInPath, expectedDropInHash)));
      await runFirstBackofficeMaintenanceRecovery({
        serviceStopped,
        dropInInstalled,
        dropInIntegrity,
        removeDropIn: () =>
          removeVerifiedDropIn(plan.dropInPath, expectedDropInHash),
        removeTemporaryDropIn: () => {
          if (existsSync(temporaryDropInPath)) {
            removeVerifiedDropIn(temporaryDropInPath, expectedDropInHash);
          }
        },
        daemonReload: () => runSystemctl(["--user", "daemon-reload"]),
        resetFailed: () => runSystemctl(["--user", "reset-failed", API_SERVICE_UNIT]),
        startApi: () => runSystemctl(["--user", "start", API_SERVICE_UNIT]),
        waitForActive: waitForActiveService,
        waitForHealth: waitForLocalHealth
      });
    } catch (error) {
      restorationFailure = error;
    } finally {
      try {
        if (lockCreated && existsSync(lockPath)) {
          assertPrivateRegularFile(lockPath, "维护锁文件");
          unlinkSync(lockPath);
        }
      } finally {
        cancellationGuard.dispose();
      }
    }

    if (restorationFailure) {
      throw restorationFailure;
    }
  }

  if (maintenanceFailure) {
    throw maintenanceFailure;
  }

  console.log(successMessage);
};

const isDirectExecution =
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(currentFilePath);

if (isDirectExecution) {
  void runBackofficePasswordMaintenance(
    firstBackofficePasswordMaintenanceOperation
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
