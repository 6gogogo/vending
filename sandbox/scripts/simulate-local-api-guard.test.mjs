import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertLocalCandidateApiBaseUrl } from "./local-api-guard.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");

test("本机候选 API 地址只接受明确的 loopback 主机", () => {
  for (const allowedUrl of [
    "http://localhost:4000/api",
    "https://127.0.0.1:8100/api",
    "http://127.255.255.255:4000/api",
    "http://[::1]:4000/api"
  ]) {
    assert.doesNotThrow(() => assertLocalCandidateApiBaseUrl(allowedUrl));
  }

  for (const rejectedUrl of [
    "https://public.example.test/api",
    "https://127.0.0.1.example.test/api",
    "ftp://127.0.0.1/api",
    "http://localhost.evil.test/api"
  ]) {
    assert.throws(
      () => assertLocalCandidateApiBaseUrl(rejectedUrl),
      /测试柜联调脚本仅允许指向本机候选 API/
    );
  }
});

const runWithRemoteApiTarget = (scriptName, fixtureArg) => {
  const scriptUrl = pathToFileURL(resolve(scriptDirectory, scriptName)).href;
  const program = [
    `process.argv[2] = ${JSON.stringify(fixtureArg)};`,
    'globalThis.fetch = async () => { throw new Error("TEST_FETCH_WAS_CALLED"); };',
    `await import(${JSON.stringify(scriptUrl)});`
  ].join("\n");

  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCAL_API_BASE_URL: "https://public.example.test/api",
      ALLOW_REMOTE_LOCAL_API: "true"
    }
  });
};

test("柜门状态回调模拟拒绝非本地候选 API，即使设置了旧的远端覆盖开关", () => {
  const result = runWithRemoteApiTarget(
    "simulate-door-status.mjs",
    "sandbox/fixtures/door-status.sample.json"
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /测试柜联调脚本仅允许指向本机候选 API/);
  assert.doesNotMatch(output, /TEST_FETCH_WAS_CALLED/);
});

test("结算回调模拟拒绝非本地候选 API，即使设置了旧的远端覆盖开关", () => {
  const result = runWithRemoteApiTarget(
    "simulate-settlement.mjs",
    "sandbox/fixtures/settlement.sample.json"
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /测试柜联调脚本仅允许指向本机候选 API/);
  assert.doesNotMatch(output, /TEST_FETCH_WAS_CALLED/);
});

test("最新开柜事件模拟拒绝非本地候选 API，即使设置了旧的远端覆盖开关", () => {
  const result = runWithRemoteApiTarget("simulate-latest-event.mjs", "");
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /测试柜联调脚本仅允许指向本机候选 API/);
  assert.doesNotMatch(output, /TEST_FETCH_WAS_CALLED/);
});
