import { resolve } from "node:path";

import { getSandboxConfig, postJson, readFixture, withSignature } from "./helpers.mjs";

const firstArg = process.argv[2];
const secondArg = process.argv[3];
const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.smartVmBaseUrl;

const isFixtureArg = typeof firstArg === "string" && firstArg.endsWith(".json");
const fixturePath = resolve(process.cwd(), firstArg ?? "sandbox/fixtures/goods-query.sample.json");

const payload = isFixtureArg || !firstArg
  ? await readFixture(fixturePath)
  : {
      deviceCode: firstArg,
      ...(secondArg ? { doorNum: secondArg } : {})
    };

if (!firstArg && !isFixtureArg && sandboxConfig.smartVmDeviceCode) {
  payload.deviceCode = sandboxConfig.smartVmDeviceCode;

  if (sandboxConfig.smartVmDoorNum) {
    payload.doorNum = sandboxConfig.smartVmDoorNum;
  }
}

const response = await postJson(
  baseUrl,
  "/api/pay/container/getCabinetGoodsInfo",
  withSignature(payload)
);

console.log(
  JSON.stringify(
    {
      request: payload,
      response
    },
    null,
    2
  )
);
