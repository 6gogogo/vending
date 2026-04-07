import { resolve } from "node:path";

import { postJson, readFixture, withSignature } from "./helpers.mjs";

const fixtureArg = process.argv[2];
const baseUrl = process.env.SMARTVM_BASE_URL ?? "http://pre.smartvm.cn";

if (!fixtureArg) {
  throw new Error("请传入测试载荷文件路径。");
}

const payload = withSignature(await readFixture(resolve(process.cwd(), fixtureArg)));
const response = await postJson(baseUrl, "/api/pay/container/refund", payload);

console.log(JSON.stringify(response, null, 2));
