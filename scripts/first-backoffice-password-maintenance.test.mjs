import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ADMIN_BACKOFFICE_PASSWORD_RECOVERY_DROP_IN_NAME,
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
  resolveTypeScriptMaintenanceCommand,
  runFirstBackofficeMaintenanceRecovery,
  selectSingleActiveLocalGraphicalSession
} from "./first-backoffice-password-maintenance.mjs";
import { resolveRuntimeDataMaintenanceCommands } from "./backoffice-password-maintenance-runner.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("首次后台密码初始化使用 API tsconfig 装载装饰器脚本", () => {
  const command = resolveTypeScriptMaintenanceCommand({
    tsxCliPath: resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    tsconfigPath: resolve(repositoryRoot, "apps", "api", "tsconfig.json"),
    scriptPath: resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "initialize-first-backoffice-password.ts"
    ),
    args: ["--probe"]
  });
  const result = spawnSync(process.execPath, command, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /本命令不接受参数/u);
  assert.doesNotMatch(result.stderr, /TransformError/u);
});

test("admin 密码恢复脚本拒绝参数，避免从命令行接收口令", () => {
  const command = resolveTypeScriptMaintenanceCommand({
    tsxCliPath: resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    tsconfigPath: resolve(repositoryRoot, "apps", "api", "tsconfig.json"),
    scriptPath: resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "recover-admin-backoffice-password.ts"
    ),
    args: ["--probe"]
  });
  const result = spawnSync(process.execPath, command, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /本命令不接受参数/u);
  assert.doesNotMatch(result.stderr, /TransformError/u);
});

test("admin 密码恢复维护入口固定运行器且拒绝命令行参数", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(
        repositoryRoot,
        "scripts",
        "run-recover-admin-backoffice-password-maintenance.mjs"
      ),
      "--probe"
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /admin 后台密码恢复命令不接受任何参数/u);
  assert.doesNotMatch(result.stderr, /TransformError/u);
});

test("首次初始化维护入口仍可直接启动并拒绝命令行参数", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, "scripts", "run-first-backoffice-password-maintenance.mjs"),
      "--probe"
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /admin 后台密码维护命令不接受任何参数/u);
  assert.doesNotMatch(result.stderr, /TransformError/u);
});

test("首次后台密码预检入口拒绝命令行参数，避免注入密码或运行模式", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(
        repositoryRoot,
        "scripts",
        "run-first-backoffice-password-maintenance-preflight.mjs"
      ),
      "--probe"
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /admin 后台密码维护预检命令不接受任何参数/u);
  assert.doesNotMatch(result.stderr, /TransformError/u);
});

test("首次后台密码预检脚本使用 API tsconfig 装载并拒绝参数", () => {
  const command = resolveTypeScriptMaintenanceCommand({
    tsxCliPath: resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    tsconfigPath: resolve(repositoryRoot, "apps", "api", "tsconfig.json"),
    scriptPath: resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "verify-first-backoffice-password-maintenance.ts"
    ),
    args: ["--probe"]
  });
  const result = spawnSync(process.execPath, command, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /本命令不接受参数/u);
  assert.doesNotMatch(result.stderr, /TransformError/u);
});

test("首次后台密码预检只做只读运行数据校验，不创建备份", () => {
  assert.deepEqual(
    resolveRuntimeDataMaintenanceCommands({ readOnlyPreflight: true }),
    [["verify"]]
  );
  assert.deepEqual(
    resolveRuntimeDataMaintenanceCommands({
      readOnlyPreflight: false,
      backupLabel: "pre-first-backoffice-password"
    }),
    [
      ["verify"],
      ["backup", "--label", "pre-first-backoffice-password", "--keep", "30"],
      ["verify", "--latest"]
    ]
  );
  assert.throws(
    () =>
      resolveRuntimeDataMaintenanceCommands({
        readOnlyPreflight: true,
        backupLabel: "unexpected"
      }),
    /运行模式或备份标签/u
  );
  assert.throws(
    () => resolveRuntimeDataMaintenanceCommands({ readOnlyPreflight: false }),
    /运行模式或备份标签/u
  );
});

test("首次初始化在要求输入密码前先取得金融单写租约", () => {
  const source = readFileSync(
    resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "initialize-first-backoffice-password.ts"
    ),
    "utf8"
  );

  assert.ok(
    source.indexOf("const financialWriter = acquireFinancialSingleWriterForMaintenance()") <
      source.indexOf("password = await readConfirmedPassword"),
    "金融单写租约必须在密码输入前取得"
  );
});

test("已初始化 admin 的本机维护会先校验当前密码，再请求新密码", () => {
  const source = readFileSync(
    resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "initialize-first-backoffice-password.ts"
    ),
    "utf8"
  );
  const leasePosition = source.indexOf(
    "const financialWriter = acquireFinancialSingleWriterForMaintenance()"
  );
  const currentPasswordPosition = source.indexOf(
    'currentPassword = await readHiddenLine("输入当前 admin 密码以验证（输入不回显）：")'
  );
  const currentPasswordVerificationPosition = source.indexOf(
    "assertCurrentAdminBackofficePassword(store, currentPassword)"
  );
  const newPasswordPromptPosition = source.indexOf(
    'prompt: "当前密码验证通过。输入新的 admin 密码（输入不回显）："'
  );

  assert.ok(leasePosition >= 0);
  assert.ok(currentPasswordPosition > leasePosition);
  assert.ok(currentPasswordVerificationPosition > currentPasswordPosition);
  assert.ok(newPasswordPromptPosition > currentPasswordVerificationPosition);
});

test("admin 密码恢复在要求确认或输入密码前先取得金融单写租约", () => {
  const source = readFileSync(
    resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "recover-admin-backoffice-password.ts"
    ),
    "utf8"
  );
  const leasePosition = source.indexOf(
    "const financialWriter = acquireFinancialSingleWriterForMaintenance()"
  );

  assert.ok(
    leasePosition < source.indexOf("await assertRecoveryConfirmation()"),
    "金融单写租约必须在恢复确认前取得"
  );
  assert.ok(
    leasePosition < source.indexOf("const password = await readConfirmedPassword"),
    "金融单写租约必须在恢复密码输入前取得"
  );
});

test("预检文案不把 API 恢复误称为绝对零写入", () => {
  const preflightScript = readFileSync(
    resolve(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "scripts",
      "verify-first-backoffice-password-maintenance.ts"
    ),
    "utf8"
  );
  const deploymentGuide = readFileSync(
    resolve(repositoryRoot, "docs", "发布与公网部署验证流程.md"),
    "utf8"
  );

  assert.doesNotMatch(preflightScript, /未写入运行数据或审计日志/u);
  assert.match(deploymentGuide, /恢复启动仍可能产生常规启动审计/u);
});

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
  assert.match(plan.contents, /^StandardInput=file:\/dev\/pts\/8$/mu);
  assert.match(plan.contents, /^StandardOutput=file:\/dev\/pts\/8$/mu);
  assert.match(plan.contents, /^StandardError=file:\/dev\/pts\/8$/mu);
  assert.match(plan.contents, /^Restart=no$/mu);
  assert.match(plan.contents, /^UnsetEnvironment=NODE_OPTIONS NODE_PATH$/mu);
  assert.doesNotMatch(plan.contents, /^Standard(?:Input|Output|Error)=tty$/mu);
  assert.doesNotMatch(plan.contents, /^TTY(?:Path|Reset|VHangup|VTDisallocate)=/mu);
  assert.doesNotMatch(plan.contents, /^Environment(?:File)?=/mu);
  assert.doesNotMatch(plan.contents, /(?:password|code|secret)=/iu);
});

test("admin 密码恢复使用独立受控 drop-in，不与首次初始化路径重叠", () => {
  const plan = resolveFirstBackofficeMaintenancePlan({
    runtimeDirectory: "/run/user/1000",
    workingDirectory: "/home/fivegogogo/vending/current",
    nodeExecutable: "/home/fivegogogo/.nvm/versions/node/v22.22.2/bin/node",
    runnerPath:
      "/home/fivegogogo/vending/current/scripts/recover-admin-backoffice-password-maintenance-runner.mjs",
    ttyPath: "/dev/pts/8",
    dropInName: ADMIN_BACKOFFICE_PASSWORD_RECOVERY_DROP_IN_NAME
  });

  assert.equal(
    plan.dropInPath,
    "/run/user/1000/systemd/user/vending-api-candidate.service.d/96-admin-backoffice-password-recovery.conf"
  );
  assert.notEqual(
    ADMIN_BACKOFFICE_PASSWORD_RECOVERY_DROP_IN_NAME,
    MAINTENANCE_DROP_IN_NAME
  );
  assert.match(
    plan.contents,
    /^ExecStart=\/home\/fivegogogo\/.nvm\/versions\/node\/v22\.22\.2\/bin\/node \/home\/fivegogogo\/vending\/current\/scripts\/recover-admin-backoffice-password-maintenance-runner\.mjs$/mu
  );
  assert.doesNotMatch(plan.contents, /^Environment(?:File)?=/mu);
});

test("首次后台密码预检使用独立受控 drop-in，并保持同一 VNC TTY 契约", () => {
  const plan = resolveFirstBackofficeMaintenancePlan({
    runtimeDirectory: "/run/user/1000",
    workingDirectory: "/home/fivegogogo/vending/current",
    nodeExecutable: "/home/fivegogogo/.nvm/versions/node/v22.22.2/bin/node",
    runnerPath:
      "/home/fivegogogo/vending/current/scripts/first-backoffice-password-maintenance-preflight-runner.mjs",
    ttyPath: "/dev/pts/8",
    dropInName: "97-first-backoffice-password-maintenance-preflight.conf"
  });

  assert.equal(
    plan.dropInPath,
    "/run/user/1000/systemd/user/vending-api-candidate.service.d/97-first-backoffice-password-maintenance-preflight.conf"
  );
  assert.doesNotMatch(plan.dropInPath, /95-first-backoffice-password-maintenance/u);
  assert.doesNotMatch(
    plan.dropInPath,
    /96-admin-backoffice-password-recovery/u
  );
  assert.match(
    plan.contents,
    /^ExecStart=\/home\/fivegogogo\/.nvm\/versions\/node\/v22\.22\.2\/bin\/node \/home\/fivegogogo\/vending\/current\/scripts\/first-backoffice-password-maintenance-preflight-runner\.mjs$/mu
  );
  assert.match(plan.contents, /^StandardInput=file:\/dev\/pts\/8$/mu);
  assert.match(plan.contents, /^StandardOutput=file:\/dev\/pts\/8$/mu);
  assert.match(plan.contents, /^StandardError=file:\/dev\/pts\/8$/mu);
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
  assert.equal(
    rootPackage.scripts["preflight:first-backoffice-password:maintenance"],
    "node scripts/run-first-backoffice-password-maintenance-preflight.mjs"
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
  assert.throws(
    () =>
      resolveFirstBackofficeMaintenancePlan({
        ...options,
        dropInName: "../unexpected.conf"
      }),
    /drop-in 名称/u
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
