import { resolve } from "node:path";

import { postJson, readFixture } from "./helpers.mjs";

const fixtureArg = process.argv[2];
const baseUrl = process.env.LOCAL_API_BASE_URL ?? "http://localhost:4000/api";

if (!fixtureArg) {
  throw new Error("请传入模拟柜机载荷文件路径。");
}

const payload = await readFixture(resolve(process.cwd(), fixtureArg));
const response = await postJson(baseUrl, "/devices/mock/upsert", payload, {
  "x-role": "admin"
});

console.log(JSON.stringify(response, null, 2));
