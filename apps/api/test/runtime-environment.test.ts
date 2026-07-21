import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  envFilesDeclareProductionRuntime,
  isProductionRuntime
} from "../src/common/config/runtime-environment.js";

test("NODE_ENV 与 APP_ENV 任一声明 production 都启用严格生产模式", () => {
  const cases = [
    { nodeEnv: undefined, appEnv: undefined, expected: false },
    { nodeEnv: "development", appEnv: undefined, expected: false },
    { nodeEnv: undefined, appEnv: "staging", expected: false },
    { nodeEnv: "test", appEnv: "staging", expected: false },
    { nodeEnv: "production", appEnv: undefined, expected: true },
    { nodeEnv: undefined, appEnv: "production", expected: true },
    { nodeEnv: "development", appEnv: "production", expected: true },
    { nodeEnv: "production", appEnv: "development", expected: true },
    { nodeEnv: " Production ", appEnv: "test", expected: true },
    { nodeEnv: "test", appEnv: "PRODUCTION", expected: true }
  ] as const;

  for (const testCase of cases) {
    assert.equal(
      isProductionRuntime({
        NODE_ENV: testCase.nodeEnv,
        APP_ENV: testCase.appEnv
      }),
      testCase.expected,
      `NODE_ENV=${String(testCase.nodeEnv)}, APP_ENV=${String(testCase.appEnv)}`
    );
  }
});

test("本地环境文件声明 production 时不会再回落加载示例配置", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-runtime-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, ".env"), "APP_ENV = 'production'\n", "utf8");
  writeFileSync(join(directory, ".env.development"), "NODE_ENV=development\n", "utf8");

  assert.equal(envFilesDeclareProductionRuntime([".env"], directory), true);
  assert.equal(envFilesDeclareProductionRuntime([".env.development"], directory), false);
  assert.equal(envFilesDeclareProductionRuntime(["missing.env"], directory), false);
});
