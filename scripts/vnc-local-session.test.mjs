import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertNoArguments,
  assertTrustedPathChain,
  assertVncLocalInteractiveSession
} from "./vnc-local-session.mjs";
import { printPublicAppAcceptanceFailure } from "./run-public-app-acceptance.mjs";

const activeGraphicalSession = {
  Remote: "no",
  Type: "wayland",
  Class: "user",
  State: "active"
};

const createTerminalProcess = () => ({
  stdin: { isTTY: true },
  stdout: { isTTY: true },
  stderr: { isTTY: true },
  getuid: () => 1000
});

test("受控验收入口拒绝任何命令行参数", () => {
  assert.throws(
    () => assertNoArguments(["--unsafe"], "受控公网 App 验收"),
    /不接受任何参数/u
  );
  assert.doesNotThrow(() => assertNoArguments([], "受控公网 App 验收"));
});

test("VNC 本机会话同时要求同一 TTY 与 active 本地图形 logind 会话", () => {
  const options = {
    processRef: createTerminalProcess(),
    realpathSync: () => "/dev/pts/9",
    resolveSessionProperties: () => activeGraphicalSession
  };

  assert.equal(assertVncLocalInteractiveSession(options), "/dev/pts/9");
  assert.throws(
    () =>
      assertVncLocalInteractiveSession({
        ...options,
        processRef: { ...createTerminalProcess(), stdin: { isTTY: false } }
      }),
    /交互终端/u
  );
  assert.throws(
    () =>
      assertVncLocalInteractiveSession({
        ...options,
        resolveSessionProperties: () => ({ ...activeGraphicalSession, Remote: "yes" })
      }),
    /本机 active 图形/u
  );
});

test("运行器或受管目录链被组写入时关闭式拒绝", () => {
  const metadata = {
    uid: 1000,
    mode: 0o40775,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false
  };

  assert.throws(
    () =>
      assertTrustedPathChain({
        targetPath: "/srv/vending/scripts/run-public-app-acceptance.mjs",
        rootPath: "/srv/vending",
        uid: 1000,
        realpathSync: (value) => value,
        lstatSync: (value) =>
          value.endsWith(".mjs")
            ? { ...metadata, mode: 0o100644, isDirectory: () => false, isFile: () => true }
            : metadata
      }),
    /不能被组或其他用户写入/u
  );
});

test("受控公网运行器在解析会话前就拒绝参数", () => {
  const result = spawnSync(process.execPath, ["scripts/run-public-app-acceptance.mjs", "--probe"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /不接受任何参数/u);
});

test("仓库源码不能直接作为生产口令入口运行", () => {
  const result = spawnSync(process.execPath, ["scripts/run-public-app-acceptance.mjs"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /已封存的本机运行器/u);
});

test("已核验运行器的业务失败只输出安全阶段和非敏感参考号", () => {
  let output = "";
  printPublicAppAcceptanceFailure(
    {
      stage: "创建自建验收夹具",
      recoveryReference: "f0f0f0f0-0000-4000-8000-000000000005",
      message: "不应显示的底层内容"
    },
    {
      write(value) {
        output += value;
      }
    }
  );

  assert.match(output, /创建自建验收夹具/u);
  assert.match(output, /f0f0f0f0-0000-4000-8000-000000000005/u);
  assert.doesNotMatch(output, /底层内容/u);
});
