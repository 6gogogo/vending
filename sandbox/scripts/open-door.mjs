import { resolve } from "node:path";

import { postJson, readFixture, withSignature } from "./helpers.mjs";

const fixtureArg = process.argv[2];
const baseUrl = process.env.SMARTVM_BASE_URL ?? "http://pre.smartvm.cn";
const confirmedDeviceCode = process.argv
  .find((argument) => argument.startsWith("--confirm-device="))
  ?.slice("--confirm-device=".length)
  .trim();

if (!fixtureArg) {
  throw new Error("请传入测试载荷文件路径。");
}

const fixture = await readFixture(resolve(process.cwd(), fixtureArg));

if (!fixture?.deviceCode || confirmedDeviceCode !== String(fixture.deviceCode)) {
  throw new Error(
    `已阻止开门请求。请核对载荷后显式追加 --confirm-device=${fixture?.deviceCode ?? "<设备编号>"}。`
  );
}

const payload = withSignature(fixture);
const response = await postJson(baseUrl, "/api/pay/container/opendoor", payload);

console.log(JSON.stringify(response, null, 2));
