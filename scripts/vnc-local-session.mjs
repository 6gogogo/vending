import { spawnSync as defaultSpawnSync } from "node:child_process";
import {
  lstatSync as defaultLstatSync,
  readFileSync as defaultReadFileSync,
  realpathSync as defaultRealpathSync
} from "node:fs";
import { posix as path } from "node:path";

import {
  LOGIND_COMMAND_ENVIRONMENT,
  assertLocalGraphicalLogindSession,
  isGnomeTerminalVteCgroup,
  parseLogindSessionIdProperty,
  parseLogindSessionObjectPath,
  parseLogindSessionProperties,
  parseLogindUserSessionIds,
  resolveCurrentLogindSessionId,
  resolveSystemBusctlArguments,
  selectSingleActiveLocalGraphicalSession
} from "./first-backoffice-password-maintenance.mjs";

const busctlPath = "/usr/bin/busctl";
const loginctlPath = "/usr/bin/loginctl";
const localPseudoTerminalPattern = /^\/dev\/pts\/\d+$/u;

const assertTrustedMetadata = ({ metadata, label, uid, kind }) => {
  const isExpectedKind =
    kind === "file" ? metadata.isFile?.() === true : metadata.isDirectory?.() === true;

  if (
    !isExpectedKind ||
    metadata.isSymbolicLink?.() === true ||
    metadata.uid !== uid ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error(`${label}必须归当前服务用户所有，且不能被组或其他用户写入。`);
  }
};

const isPathInside = (parentPath, targetPath) => {
  const relativePath = path.relative(parentPath, targetPath);
  return Boolean(relativePath) && !relativePath.startsWith("../") && relativePath !== ".." && !path.isAbsolute(relativePath);
};

export const assertNoArguments = (args, operation) => {
  if (!Array.isArray(args) || args.length !== 0) {
    throw new Error(`${operation}不接受任何参数。`);
  }
};

/**
 * 验证版本化运行器及其仓库目录链，避免 VNC 本地会话执行可被其他用户篡改的脚本。
 */
export const assertTrustedPathChain = ({
  targetPath,
  rootPath,
  uid,
  realpathSync = defaultRealpathSync,
  lstatSync = defaultLstatSync
}) => {
  const resolvedRoot = realpathSync(rootPath);
  const resolvedTarget = realpathSync(targetPath);

  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    throw new Error("受控验收运行器必须位于当前受管仓库内。");
  }

  let currentPath = resolvedTarget;

  while (true) {
    assertTrustedMetadata({
      metadata: lstatSync(currentPath),
      label: currentPath === resolvedTarget ? "受控验收运行器" : "受控验收目录",
      uid,
      kind: currentPath === resolvedTarget ? "file" : "directory"
    });

    if (currentPath === resolvedRoot) {
      return resolvedTarget;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath || !isPathInside(resolvedRoot, parentPath) && parentPath !== resolvedRoot) {
      throw new Error("受控验收运行器目录链无效。");
    }
    currentPath = parentPath;
  }
};

const executeBusctl = ({ spawnSync, args }) =>
  spawnSync(busctlPath, resolveSystemBusctlArguments(args), {
    encoding: "utf8",
    env: LOGIND_COMMAND_ENVIRONMENT,
    stdio: ["ignore", "pipe", "pipe"]
  });

const executeLoginctl = ({ spawnSync, args }) =>
  spawnSync(loginctlPath, args, {
    encoding: "utf8",
    env: LOGIND_COMMAND_ENVIRONMENT,
    stdio: ["ignore", "pipe", "pipe"]
  });

const readBusctlOutput = ({ spawnSync, args }) => {
  const result = executeBusctl({ spawnSync, args });
  if (result.error || result.status !== 0) {
    throw new Error("无法由 logind 核验当前 VNC 本机会话，已停止受控验收。");
  }
  return String(result.stdout ?? "");
};

const readLoginctlOutput = ({ spawnSync, args }) => {
  const result = executeLoginctl({ spawnSync, args });
  if (result.error || result.status !== 0) {
    throw new Error("无法核验当前 VNC 本机会话，已停止受控验收。");
  }
  return String(result.stdout ?? "");
};

const readSessionProperties = ({ spawnSync, sessionId }) =>
  parseLogindSessionProperties(
    readLoginctlOutput({
      spawnSync,
      args: [
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
      ]
    })
  );

const isNoKnownSessionBusctlFailure = (result) =>
  !result.error &&
  /(?:does not belong to any known session|no session for pid)/iu.test(
    String(result.stderr ?? "")
  );

const resolveSingleActiveLocalGraphicalSession = ({ spawnSync, uid }) => {
  const sessionIds = parseLogindUserSessionIds(
    readLoginctlOutput({
      spawnSync,
      args: ["show-user", String(uid), "-p", "Sessions", "--value"]
    })
  );

  return selectSingleActiveLocalGraphicalSession(
    sessionIds.map((id) => ({
      id,
      properties: readSessionProperties({ spawnSync, sessionId: id })
    }))
  );
};

const resolveProcessSessionProperties = ({ processRef, spawnSync, readFileSync }) => {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8");
  const sessionLookup = executeBusctl({
    spawnSync,
    args: [
      "call",
      "org.freedesktop.login1",
      "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager",
      "GetSessionByPID",
      "u",
      String(processRef.pid)
    ]
  });
  const uid = processRef.getuid();
  let sessionId;

  if (sessionLookup.error || sessionLookup.status !== 0) {
    if (isNoKnownSessionBusctlFailure(sessionLookup) && isGnomeTerminalVteCgroup({ cgroup, uid })) {
      sessionId = resolveSingleActiveLocalGraphicalSession({ spawnSync, uid });
    } else {
      throw new Error("无法由 logind 核验当前 VNC 本机会话，已停止受控验收。");
    }
  } else {
    const sessionObjectPath = parseLogindSessionObjectPath(String(sessionLookup.stdout ?? ""));
    const busctlSessionId = parseLogindSessionIdProperty(
      readBusctlOutput({
        spawnSync,
        args: [
          "get-property",
          "org.freedesktop.login1",
          sessionObjectPath,
          "org.freedesktop.login1.Session",
          "Id"
        ]
      })
    );
    sessionId = resolveCurrentLogindSessionId({ cgroup, busctlSessionId });
  }

  return readSessionProperties({ spawnSync, sessionId });
};

/**
 * 只接受 Spark VNC 的同一伪终端和 active 本地图形会话；SSH、管道和 detached cgroup 全部拒绝。
 */
export const assertVncLocalInteractiveSession = ({
  processRef = process,
  realpathSync = defaultRealpathSync,
  spawnSync = defaultSpawnSync,
  readFileSync = defaultReadFileSync,
  resolveSessionProperties = undefined
} = {}) => {
  if (!processRef.stdin?.isTTY || !processRef.stdout?.isTTY || !processRef.stderr?.isTTY) {
    throw new Error("受控公网 App 验收只能在 Spark VNC 本机交互终端运行。");
  }

  const terminalPaths = [0, 1, 2].map((descriptor) => realpathSync(`/proc/self/fd/${descriptor}`));
  const [terminalPath] = terminalPaths;
  if (
    !localPseudoTerminalPattern.test(terminalPath) ||
    terminalPaths.some((entry) => entry !== terminalPath)
  ) {
    throw new Error("受控公网 App 验收需要输入、输出和错误输出位于同一 VNC 本机伪终端。");
  }

  const properties =
    typeof resolveSessionProperties === "function"
      ? resolveSessionProperties()
      : resolveProcessSessionProperties({ processRef, spawnSync, readFileSync });
  assertLocalGraphicalLogindSession(properties);
  return terminalPath;
};

export const assertHiddenInputAvailable = (input = process.stdin) => {
  if (!input?.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("受控公网 App 验收只能在 Spark VNC 本机交互终端隐藏输入。");
  }
};

export const readHiddenLine = (prompt, { input = process.stdin, output = process.stdout } = {}) =>
  new Promise((resolveResult, reject) => {
    assertHiddenInputAvailable(input);
    const previousRawMode = input.isRaw;
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(previousRawMode);
      input.pause();
    };
    const finish = (result) => {
      cleanup();
      output.write("\n");
      resolveResult(result);
    };
    const fail = (error) => {
      cleanup();
      output.write("\n");
      reject(error);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          fail(new Error("受控公网 App 验收已取消。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
