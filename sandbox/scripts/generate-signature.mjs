import { basename, resolve } from "node:path";

import { readFixture, withSignature } from "./helpers.mjs";

const fixtureArg = process.argv[2];

if (!fixtureArg) {
  throw new Error("请传入测试载荷文件路径。");
}

const payload = await readFixture(resolve(process.cwd(), fixtureArg));
const signedPayload = withSignature(payload, { allowDemoCredentials: true });

console.log(`已生成签名：${basename(fixtureArg)}`);
console.log(JSON.stringify(signedPayload, null, 2));
