import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  MAINTENANCE_DROP_IN_NAME,
  LOGIND_COMMAND_ENVIRONMENT,
  assertLocalGraphicalLogindSession,
  createFirstBackofficeMaintenanceCancellationCoordinator,
  createFirstBackofficeMaintenanceSignalGuard,
  isGnomeTerminalVteCgroup,
  isStoppedServiceState,
  parseLogindUserSessionIds,
  parseLogindSessionProperties,
  parseLogindSessionIdProperty,
  parseLogindSessionObjectPath,
  resolveCurrentLogindSessionId,
  resolveFirstBackofficeMaintenanceRecovery,
  resolveLogindSessionIdFromCgroup,
  resolveFirstBackofficeMaintenancePlan,
  resolveSystemBusctlArguments,
  runFirstBackofficeMaintenanceRecovery,
  selectSingleActiveLocalGraphicalSession
} from "./first-backoffice-password-maintenance.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("本机首次后台密码维护计划只覆盖执行与终端配置，不注入环境变量", () => {
  const plan = resolveFirstBackofficeMaintenancePlan({
    runtimeDirectory: "/run/user/1000",
    workingDirectory: "/home/fivegogogo/vending/current",
    nodeExecutable: "/home/fivegogogo/.nvm/versions/node/v22.22.2/bin/node",
    runnerPath:
      "/home/fivegogogo/vending/current/scripts/first-backoffice-password-maintenance-runner.mjs",
    ttyPath: "/dev/pts/8"
  });

  assert.equal(
    plan.dropInPath,
    "/run/user/1000/systemd/user/vending-api-candidate.service.d/95-first-backoffice-password-maintenance.conf"
  );
  assert.equal(MAINTENANCE_DROP_IN_NAME, "95-first-backoffice-password-maintenance.conf");
  assert.match(plan.contents, /^Type=oneshot$/mu);
  assert.match(plan.contents, /^ExecStart=$/mu);
  assert.match(
    plan.contents,
    /^ExecStart=\/home\/fivegogogo\/.nvm\/versions\/node\/v22\.22\.2\/bin\/node \/home\/fivegogogo\/vending\/current\/scripts\/first-backoffice-password-maintenance-runner\.mjs$/mu
  );
  assert.match(plan.contents, /^TTYPath=\/dev\/pts\/8$/mu);
  assert.match(plan.contents, /^Restart=no$/mu);
  assert.match(plan.contents, /^UnsetEnvironment=NODE_OPTIONS NODE_PATH$/mu);
  assert.doesNotMatch(plan.contents, /^Environment(?:File)?=/mu);
  assert.doesNotMatch(plan.contents, /(?:password|code|secret)=/iu);
});

test("会话验证固定走系统总线并使用最小子进程环境", () => {
  assert.deepEqual(LOGIND_COMMAND_ENVIRONMENT, {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C"
  });
  assert.deepEqual(resolveSystemBusctlArguments(["call", "service"]), [
    "--system",
    "call",
    "service"
  ]);
  assert.equal(Object.hasOwn(LOGIND_COMMAND_ENVIRONMENT, "DBUS_SYSTEM_BUS_ADDRESS"), false);
  assert.equal(Object.hasOwn(LOGIND_COMMAND_ENVIRONMENT, "DBUS_SESSION_BUS_ADDRESS"), false);
});

test("旧的直接首次密码初始化 npm 入口已移除", () => {
  const rootPackage = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
  );
  const apiPackage = JSON.parse(
    readFileSync(resolve(repositoryRoot, "apps", "api", "package.json"), "utf8")
  );

  assert.equal(rootPackage.scripts["init:first-backoffice-password"], undefined);
  assert.equal(
    apiPackage.scripts["data:init:first-backoffice-password"],
    undefined
  );
  assert.equal(
    rootPackage.scripts["init:first-backoffice-password:maintenance"],
    "node scripts/run-first-backoffice-password-maintenance.mjs"
  );
});

test("本机首次后台密码维护计划拒绝非伪终端、相对路径和可注入路径", () => {
  const options = {
    runtimeDirectory: "/run/user/1000",
    workingDirectory: "/home/fivegogogo/vending/current",
    nodeExecutable: "/usr/bin/node",
    runnerPath:
      "/home/fivegogogo/vending/current/scripts/first-backoffice-password-maintenance-runner.mjs",
    ttyPath: "/dev/pts/3"
  };

  assert.throws(
    () => resolveFirstBackofficeMaintenancePlan({ ...options, ttyPath: "/dev/tty1" }),
    /本机伪终端/u
  );
  assert.throws(
    () => resolveFirstBackofficeMaintenancePlan({ ...options, runtimeDirectory: "runtime" }),
    /绝对路径/u
  );
  assert.throws(
    () =>
      resolveFirstBackofficeMaintenancePlan({
        ...options,
        nodeExecutable: "/usr/bin/node;unexpected"
      }),
    /绝对路径/u
  );
});

test("仅接受当前进程所属的本机 active 图形 logind 会话", () => {
  assert.equal(
    resolveLogindSessionIdFromCgroup(
      "0::/user.slice/user-1000.slice/session-5.scope"
    ),
    "5"
  );
  assert.throws(
    () =>
      resolveLogindSessionIdFromCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service"
      ),
    /cgroup/u
  );
  assert.equal(
    resolveCurrentLogindSessionId({
      cgroup:
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-7.scope",
      busctlSessionId: "5"
    }),
    "5"
  );
  assert.equal(
    resolveCurrentLogindSessionId({
      cgroup: "0::/user.slice/user-1000.slice/session-2968.scope",
      busctlSessionId: "2968"
    }),
    "2968"
  );
  assert.throws(
    () =>
      resolveCurrentLogindSessionId({
        cgroup: "0::/user.slice/user-1000.slice/session-2968.scope",
        busctlSessionId: "5"
      }),
    /不一致/u
  );
  assert.throws(
    () =>
      resolveCurrentLogindSessionId({
        cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/test.scope",
        busctlSessionId: ""
      }),
    /当前进程/u
  );
  assert.equal(
    parseLogindSessionObjectPath(
      'o "/org/freedesktop/login1/session/_35"\n'
    ),
    "/org/freedesktop/login1/session/_35"
  );
  assert.equal(parseLogindSessionIdProperty('s "5"\n'), "5");
  assert.throws(() => parseLogindSessionObjectPath("o /unexpected\n"), /对象路径/u);
  assert.throws(() => parseLogindSessionIdProperty('s ""\n'), /会话编号/u);
  assert.doesNotThrow(() =>
    assertLocalGraphicalLogindSession({
      Remote: "no",
      Type: "x11",
      Class: "user",
      State: "active"
    })
  );
  assert.throws(
    () =>
      assertLocalGraphicalLogindSession({
        Remote: "yes",
        Type: "x11",
        Class: "user",
        State: "active"
      }),
    /图形 VNC/u
  );
  assert.deepEqual(
    parseLogindSessionProperties("Remote=no\nType=x11\nClass=user\nState=active\n"),
    { Remote: "no", Type: "x11", Class: "user", State: "active" }
  );
  assert.throws(
    () => parseLogindSessionProperties("Remote=no\nType=x11\nClass=user\n"),
    /缺少必要属性/u
  );
  assert.throws(
    () =>
      parseLogindSessionProperties(
        "Remote=no\nType=x11\nClass=user\nState=active\nUnit=x\n"
      ),
    /意外/u
  );
});

test("GNOME Terminal 脱离 session scope 时只能回退到唯一的本机 active 图形会话", () => {
  const gnomeTerminalCgroup =
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-3ef89552-10ba-4acc-9ddc-a940df91432d.scope\n";

  assert.equal(
    isGnomeTerminalVteCgroup({ cgroup: gnomeTerminalCgroup, uid: 1000 }),
    true
  );
  assert.equal(
    isGnomeTerminalVteCgroup({ cgroup: gnomeTerminalCgroup, uid: 1001 }),
    false
  );
  assert.equal(
    isGnomeTerminalVteCgroup({
      cgroup:
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-3ef89552-10ba-4acc-9ddc-a940df91432d.scope",
      uid: 1000
    }),
    false
  );

  assert.deepEqual(parseLogindUserSessionIds("3056 3055 5\n"), [
    "3056",
    "3055",
    "5"
  ]);
  assert.throws(() => parseLogindUserSessionIds("5 unexpected/session\n"), /会话/u);

  assert.equal(
    selectSingleActiveLocalGraphicalSession([
      {
        id: "3056",
        properties: { Remote: "yes", Type: "tty", Class: "user", State: "active" }
      },
      {
        id: "5",
        properties: { Remote: "no", Type: "x11", Class: "user", State: "active" }
      }
    ]),
    "5"
  );
  assert.throws(
    () =>
      selectSingleActiveLocalGraphicalSession([
        {
          id: "5",
          properties: { Remote: "no", Type: "x11", Class: "user", State: "active" }
        },
        {
          id: "6",
          properties: { Remote: "no", Type: "wayland", Class: "user", State: "active" }
        }
      ]),
    /唯一/u
  );
  assert.throws(
    () =>
      selectSingleActiveLocalGraphicalSession([
        {
          id: "3056",
          properties: { Remote: "yes", Type: "tty", Class: "user", State: "active" }
        }
      ]),
    /唯一/u
  );
});

test("停止完成只接受 inactive 或 failed 且无主进程", () => {
  assert.equal(isStoppedServiceState({ activeState: "inactive", mainPid: "0" }), true);
  assert.equal(isStoppedServiceState({ activeState: "failed", mainPid: "0" }), true);
  assert.equal(isStoppedServiceState({ activeState: "failed", mainPid: "42" }), false);
  assert.equal(isStoppedServiceState({ activeState: "active", mainPid: "0" }), false);
});

test("维护信号守卫将交互中断转为受控恢复请求", () => {
  const signalTarget = new EventEmitter();
  const observedSignals = [];
  const guard = createFirstBackofficeMaintenanceSignalGuard(
    signalTarget,
    (signal) => observedSignals.push(signal)
  );

  signalTarget.emit("SIGINT");
  signalTarget.emit("SIGTERM");

  assert.equal(guard.requestedSignal, "SIGINT");
  assert.deepEqual(observedSignals, ["SIGINT"]);
  assert.throws(() => guard.throwIfRequested(), /已取消/u);
  guard.dispose();
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGHUP"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("维护 job 停止确认后到达的取消信号不能再停止恢复后的 API", async () => {
  let stopCalls = 0;
  const coordinator = createFirstBackofficeMaintenanceCancellationCoordinator({
    stopMaintenanceJob: async () => {
      stopCalls += 1;
    }
  });

  coordinator.armJob();
  coordinator.markJobStopped();
  coordinator.requestStop();
  await coordinator.waitForScheduledStop();
  await coordinator.ensureJobStopped();

  assert.equal(stopCalls, 0);
});

test("运行中的维护 job 收到取消时只停止一次并在恢复前等待完成", async () => {
  let stopCalls = 0;
  let releaseStop;
  const stopFinished = new Promise((resolveStop) => {
    releaseStop = resolveStop;
  });
  const coordinator = createFirstBackofficeMaintenanceCancellationCoordinator({
    stopMaintenanceJob: async () => {
      stopCalls += 1;
      await stopFinished;
    }
  });

  coordinator.armJob();
  coordinator.requestStop();
  coordinator.requestStop();
  assert.equal(stopCalls, 1);

  const settled = coordinator.waitForScheduledStop();
  releaseStop();
  await settled;
  await coordinator.ensureJobStopped();

  assert.equal(stopCalls, 1);
});

test("取消 stop 失败时协调器关闭式拒绝后续清理与恢复", async () => {
  let stopCalls = 0;
  const coordinator = createFirstBackofficeMaintenanceCancellationCoordinator({
    stopMaintenanceJob: async () => {
      stopCalls += 1;
      throw new Error("injected stop failure");
    }
  });

  coordinator.armJob();
  coordinator.requestStop();

  await assert.rejects(
    () => coordinator.waitForScheduledStop(),
    /无法确认维护 job 已停止/u
  );
  await assert.rejects(
    () => coordinator.ensureJobStopped(),
    /无法确认维护 job 已停止/u
  );
  assert.equal(stopCalls, 1);
});

test("维护失败仍恢复 API，只有 drop-in 完整性漂移才关闭式保留现场", () => {
  assert.deepEqual(
    resolveFirstBackofficeMaintenanceRecovery({
      serviceStopped: true,
      dropInInstalled: true,
      dropInIntegrity: true
    }),
    {
      removeDropIn: true,
      restoreApi: true,
      checkHealth: true,
      manualRecoveryRequired: false
    }
  );
  assert.deepEqual(
    resolveFirstBackofficeMaintenanceRecovery({
      serviceStopped: true,
      dropInInstalled: true,
      dropInIntegrity: false
    }),
    {
      removeDropIn: false,
      restoreApi: false,
      checkHealth: false,
      manualRecoveryRequired: true
    }
  );
  assert.deepEqual(
    resolveFirstBackofficeMaintenanceRecovery({
      serviceStopped: false,
      dropInInstalled: true,
      dropInIntegrity: true
    }),
    {
      removeDropIn: true,
      restoreApi: false,
      checkHealth: false,
      manualRecoveryRequired: false
    }
  );
});

test("维护恢复按固定顺序移除受控 drop-in、重载并恢复 API", async () => {
  const calls = [];
  const action = (name) => async () => {
    calls.push(name);
  };

  await runFirstBackofficeMaintenanceRecovery({
    serviceStopped: true,
    dropInInstalled: true,
    dropInIntegrity: true,
    removeDropIn: action("remove-drop-in"),
    removeTemporaryDropIn: action("remove-temporary"),
    daemonReload: action("daemon-reload"),
    resetFailed: action("reset-failed"),
    startApi: action("start-api"),
    waitForActive: action("wait-active"),
    waitForHealth: action("wait-health")
  });

  assert.deepEqual(calls, [
    "remove-drop-in",
    "remove-temporary",
    "daemon-reload",
    "reset-failed",
    "start-api",
    "wait-active",
    "wait-health"
  ]);
});

test("drop-in 完整性漂移不会执行覆盖、重载或启动操作", async () => {
  const calls = [];
  const action = (name) => async () => {
    calls.push(name);
  };

  await assert.rejects(
    () =>
      runFirstBackofficeMaintenanceRecovery({
        serviceStopped: true,
        dropInInstalled: true,
        dropInIntegrity: false,
        removeDropIn: action("remove-drop-in"),
        removeTemporaryDropIn: action("remove-temporary"),
        daemonReload: action("daemon-reload"),
        resetFailed: action("reset-failed"),
        startApi: action("start-api"),
        waitForActive: action("wait-active"),
        waitForHealth: action("wait-health")
      }),
    /完整性/u
  );
  assert.deepEqual(calls, []);
});
