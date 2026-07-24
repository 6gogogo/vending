import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const productionEnvPath = fileURLToPath(
  new URL("../../.env.production", import.meta.url)
);

test("微信生产构建固定使用已备案的 HTTPS API", () => {
  const productionEnv = readFileSync(productionEnvPath, "utf8");
  const configuredApiBaseUrl = productionEnv.match(
    /^VITE_API_BASE_URL=(.+)$/m
  )?.[1];

  assert.equal(configuredApiBaseUrl, "https://5gogogo.top/api");
});
