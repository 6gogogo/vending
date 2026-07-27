import { posix as path } from "node:path";

export const API_SERVICE_UNIT = "vending-api-candidate.service";
export const MAINTENANCE_DROP_IN_NAME =
  "95-first-backoffice-password-maintenance.conf";
export const LOGIND_COMMAND_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C"
});
export const resolveSystemBusctlArguments = (args) => ["--system", ...args];

const safeSystemdPathPattern = /^\/[A-Za-z0-9._/+@:-]+$/u;
const localPseudoTerminalPattern = /^\/dev\/pts\/\d+$/u;
const sessionScopePattern = /(?:^|\/)session-([A-Za-z0-9_-]+)\.scope(?:\/|$)/gmu;
const logindSessionIdPattern = /^[A-Za-z0-9_-]+$/u;
const numericUserIdPattern = /^\d+$/u;
const gnomeTerminalVteCgroupPattern =
  /^0::\/user\.slice\/user-(\d+)\.slice\/user@\1\.service\/app\.slice\/app-org\.gnome\.Terminal\.slice\/vte-spawn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope$/iu;
const logindSessionObjectPathPattern =
  /^o\s+"(\/org\/freedesktop\/login1\/session\/[A-Za-z0-9_]+)"\s*$/u;
const logindSessionIdPropertyPattern = /^s\s+"([A-Za-z0-9_-]+)"\s*$/u;
const expectedLogindSessionProperties = new Set([
  "Remote",
  "Type",
  "Class",
  "State"
]);

const assertSafeSystemdPath = (value, name) => {
  const normalized = String(value ?? "").trim();

  if (
    !normalized.startsWith("/") ||
    path.resolve(normalized) !== normalized ||
    !safeSystemdPathPattern.test(normalized)
  ) {
    throw new Error(`${name} 必须是可安全写入 systemd unit 的绝对路径。`);
  }

  return normalized;
};

const assertPathWithin = (parentPath, targetPath, name) => {
  const relativePath = path.relative(parentPath, targetPath);

  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("..\\") ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${name} 必须位于受控运行时目录内。`);
  }
};

const assertLocalPseudoTerminal = (value) => {
  const normalized = String(value ?? "").trim();

  if (!localPseudoTerminalPattern.test(normalized)) {
    throw new Error("首次后台密码维护只能使用服务器 VNC 本机伪终端。");
  }

  return normalized;
};

export const resolveTypeScriptMaintenanceCommand = ({
  tsxCliPath,
  tsconfigPath,
  scriptPath,
  args = []
}) => [tsxCliPath, "--tsconfig", tsconfigPath, scriptPath, ...args];

export const resolveLogindSessionIdFromCgroup = (cgroup) => {
  sessionScopePattern.lastIndex = 0;
  const matches = [...String(cgroup ?? "").matchAll(sessionScopePattern)].map(
    (match) => match[1]
  );
  sessionScopePattern.lastIndex = 0;

  if (matches.length !== 1) {
    throw new Error("无法从当前进程 cgroup 唯一识别 logind 会话，已拒绝维护。");
  }

  return matches[0];
};

export const resolveCurrentLogindSessionId = ({
  cgroup,
  busctlSessionId
}) => {
  const cgroupValue = String(cgroup ?? "");
  const sessionId = String(busctlSessionId ?? "").trim();

  if (!logindSessionIdPattern.test(sessionId)) {
    throw new Error("无法从当前进程解析受管 logind 会话，已拒绝维护。");
  }

  if (sessionScopePattern.test(cgroupValue)) {
    sessionScopePattern.lastIndex = 0;
    const cgroupSessionId = resolveLogindSessionIdFromCgroup(cgroupValue);

    if (cgroupSessionId !== sessionId) {
      throw new Error("当前进程 cgroup 与 logind 会话不一致，已拒绝维护。");
    }

    return cgroupSessionId;
  }

  sessionScopePattern.lastIndex = 0;
  return sessionId;
};

export const isGnomeTerminalVteCgroup = ({ cgroup, uid }) => {
  const normalizedUid = String(uid ?? "").trim();
  const cgroupLines = String(cgroup ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!numericUserIdPattern.test(normalizedUid) || cgroupLines.length !== 1) {
    return false;
  }

  const match = cgroupLines[0].match(gnomeTerminalVteCgroupPattern);
  return Boolean(match && match[1] === normalizedUid);
};

export const parseLogindUserSessionIds = (output) => {
  const value = String(output ?? "").trim();

  if (!value) {
    throw new Error("logind 未返回当前用户的会话，已拒绝维护。");
  }

  const sessionIds = value.split(/\s+/u);
  if (
    sessionIds.some((sessionId) => !logindSessionIdPattern.test(sessionId)) ||
    new Set(sessionIds).size !== sessionIds.length
  ) {
    throw new Error("logind 返回了无效或重复的当前用户会话，已拒绝维护。");
  }

  return sessionIds;
};

export const parseLogindSessionObjectPath = (output) => {
  const match = String(output ?? "").trim().match(logindSessionObjectPathPattern);

  if (!match) {
    throw new Error("无法从 logind 进程会话响应解析对象路径，已拒绝维护。");
  }

  return match[1];
};

export const parseLogindSessionIdProperty = (output) => {
  const match = String(output ?? "").trim().match(logindSessionIdPropertyPattern);

  if (!match) {
    throw new Error("无法从 logind 会话属性解析会话编号，已拒绝维护。");
  }

  return match[1];
};

export const parseLogindSessionProperties = (output) => {
  const properties = {};

  for (const rawLine of String(output ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const separator = line.indexOf("=");
    const key = line.slice(0, separator);

    if (
      separator <= 0 ||
      !expectedLogindSessionProperties.has(key) ||
      Object.hasOwn(properties, key)
    ) {
      throw new Error("logind 会话返回了不完整或意外的属性，已拒绝维护。");
    }

    properties[key] = line.slice(separator + 1).trim();
  }

  if (
    expectedLogindSessionProperties.size !== Object.keys(properties).length ||
    [...expectedLogindSessionProperties].some(
      (property) => !Object.hasOwn(properties, property)
    )
  ) {
    throw new Error("logind 会话缺少必要属性，已拒绝维护。");
  }

  return properties;
};

export const isActiveLocalGraphicalLogindSession = (properties) => {
  const normalized = Object.fromEntries(
    Object.entries(properties ?? {}).map(([key, value]) => [
      key,
      String(value ?? "").trim()
    ])
  );

  return (
    normalized.Remote === "no" &&
    ["x11", "wayland"].includes(normalized.Type) &&
    normalized.Class === "user" &&
    normalized.State === "active"
  );
};

export const selectSingleActiveLocalGraphicalSession = (sessions) => {
  if (!Array.isArray(sessions)) {
    throw new Error("logind 当前用户会话格式无效，已拒绝维护。");
  }

  const normalizedSessions = sessions.map((session) => {
    const id = String(session?.id ?? "").trim();
    if (!logindSessionIdPattern.test(id)) {
      throw new Error("logind 当前用户会话编号无效，已拒绝维护。");
    }

    return { id, properties: session?.properties };
  });
  const localGraphicalSessions = normalizedSessions.filter((session) =>
    isActiveLocalGraphicalLogindSession(session.properties)
  );

  if (localGraphicalSessions.length !== 1) {
    throw new Error("无法唯一确认当前用户的本机 active 图形会话，已拒绝维护。");
  }

  return localGraphicalSessions[0].id;
};

export const assertLocalGraphicalLogindSession = (properties) => {
  if (!isActiveLocalGraphicalLogindSession(properties)) {
    throw new Error("首次后台密码维护只能从本机 active 图形 VNC 会话启动。");
  }
};

export const isStoppedServiceState = ({ activeState, mainPid }) =>
  ["inactive", "failed"].includes(String(activeState ?? "").trim()) &&
  String(mainPid ?? "").trim() === "0";

export const createFirstBackofficeMaintenanceSignalGuard = (
  signalTarget,
  onCancellationRequested = undefined
) => {
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"];
  let requestedSignal;
  const listeners = new Map();

  for (const signal of signals) {
    const listener = () => {
      if (requestedSignal) {
        return;
      }

      requestedSignal = signal;
      onCancellationRequested?.(signal);
    };
    listeners.set(signal, listener);
    signalTarget.on(signal, listener);
  }

  return {
    get requestedSignal() {
      return requestedSignal;
    },
    throwIfRequested() {
      if (requestedSignal) {
        throw new Error("首次后台密码维护已取消，正在恢复 API 服务。");
      }
    },
    dispose() {
      for (const [signal, listener] of listeners) {
        signalTarget.removeListener(signal, listener);
      }
    }
  };
};

export const createFirstBackofficeMaintenanceCancellationCoordinator = ({
  stopMaintenanceJob
}) => {
  if (typeof stopMaintenanceJob !== "function") {
    throw new Error("取消协调器必须接收受控维护停止函数。");
  }

  let maintenanceJobMayBeRunning = false;
  let cancellationStopEnabled = false;
  let cancellationStopPromise;
  let cancellationStopFailure;

  const stopJob = async () => {
    cancellationStopEnabled = false;
    await stopMaintenanceJob();
    maintenanceJobMayBeRunning = false;
  };

  const waitForScheduledStop = async () => {
    if (cancellationStopPromise) {
      await cancellationStopPromise;
    }

    if (cancellationStopFailure) {
      throw new Error("维护取消后无法确认维护 job 已停止，已保留现场人工恢复。");
    }
  };

  return {
    armJob() {
      maintenanceJobMayBeRunning = true;
      cancellationStopEnabled = true;
    },
    markJobStopped() {
      maintenanceJobMayBeRunning = false;
      cancellationStopEnabled = false;
    },
    requestStop() {
      if (
        cancellationStopEnabled &&
        maintenanceJobMayBeRunning &&
        !cancellationStopPromise
      ) {
        cancellationStopPromise = stopJob().catch((error) => {
          cancellationStopFailure = error;
        });
      }
    },
    async waitForScheduledStop() {
      await waitForScheduledStop();
    },
    async ensureJobStopped() {
      if (maintenanceJobMayBeRunning) {
        if (cancellationStopPromise) {
          await waitForScheduledStop();
        } else {
          await stopJob();
        }
      }

      await waitForScheduledStop();
    }
  };
};

export const resolveFirstBackofficeMaintenanceRecovery = ({
  serviceStopped,
  dropInInstalled,
  dropInIntegrity
}) => {
  if (dropInInstalled && !dropInIntegrity) {
    return {
      removeDropIn: false,
      restoreApi: false,
      checkHealth: false,
      manualRecoveryRequired: true
    };
  }

  if (!serviceStopped) {
    return {
      removeDropIn: Boolean(dropInInstalled),
      restoreApi: false,
      checkHealth: false,
      manualRecoveryRequired: false
    };
  }

  return {
    removeDropIn: Boolean(dropInInstalled),
    restoreApi: true,
    checkHealth: true,
    manualRecoveryRequired: false
  };
};

export const runFirstBackofficeMaintenanceRecovery = async ({
  serviceStopped,
  dropInInstalled,
  dropInIntegrity,
  removeDropIn,
  removeTemporaryDropIn,
  daemonReload,
  resetFailed,
  startApi,
  waitForActive,
  waitForHealth
}) => {
  const recovery = resolveFirstBackofficeMaintenanceRecovery({
    serviceStopped,
    dropInInstalled,
    dropInIntegrity
  });

  if (recovery.manualRecoveryRequired) {
    throw new Error(
      "维护 drop-in 完整性发生漂移，已保留现场并关闭式停止；请人工恢复。"
    );
  }

  if (recovery.removeDropIn) {
    await removeDropIn();
  }

  await removeTemporaryDropIn();

  if (dropInInstalled) {
    await daemonReload();
  }

  if (serviceStopped) {
    await resetFailed();
  }

  if (recovery.restoreApi) {
    await startApi();
    await waitForActive();

    if (recovery.checkHealth) {
      await waitForHealth();
    }
  }

  return recovery;
};

export const resolveFirstBackofficeMaintenancePlan = ({
  runtimeDirectory,
  workingDirectory,
  nodeExecutable,
  runnerPath,
  ttyPath
}) => {
  const safeRuntimeDirectory = assertSafeSystemdPath(runtimeDirectory, "XDG_RUNTIME_DIR");
  const safeWorkingDirectory = assertSafeSystemdPath(workingDirectory, "API 工作目录");
  const safeNodeExecutable = assertSafeSystemdPath(nodeExecutable, "Node 可执行文件");
  const safeRunnerPath = assertSafeSystemdPath(runnerPath, "维护运行器");
  const safeTtyPath = assertLocalPseudoTerminal(ttyPath);
  const runtimeSystemdDirectory = path.join(safeRuntimeDirectory, "systemd", "user");
  const dropInDirectory = path.join(
    runtimeSystemdDirectory,
    `${API_SERVICE_UNIT}.d`
  );
  const dropInPath = path.join(dropInDirectory, MAINTENANCE_DROP_IN_NAME);

  assertPathWithin(safeRuntimeDirectory, runtimeSystemdDirectory, "systemd 运行时目录");
  assertPathWithin(safeRuntimeDirectory, dropInDirectory, "维护 drop-in 目录");
  assertPathWithin(safeRuntimeDirectory, dropInPath, "维护 drop-in 文件");

  const contents = [
    "[Service]",
    "Type=oneshot",
    "ExecStartPre=",
    "ExecStart=",
    "ExecStartPost=",
    "ExecStop=",
    "ExecStopPost=",
    `ExecStart=${safeNodeExecutable} ${safeRunnerPath}`,
    "UnsetEnvironment=NODE_OPTIONS NODE_PATH",
    "Restart=no",
    "RemainAfterExit=no",
    "TimeoutStartSec=15min",
    `StandardInput=file:${safeTtyPath}`,
    `StandardOutput=file:${safeTtyPath}`,
    `StandardError=file:${safeTtyPath}`,
    ""
  ].join("\n");

  if (/^Environment(?:File)?=/mu.test(contents)) {
    throw new Error("维护 drop-in 不得覆盖或注入服务环境。");
  }

  return {
    workingDirectory: safeWorkingDirectory,
    runtimeSystemdDirectory,
    dropInDirectory,
    dropInPath,
    contents
  };
};
