import { resolve } from "node:path";

import { postJson, readFixture } from "./helpers.mjs";
import { assertLocalCandidateApiBaseUrl } from "./local-api-guard.mjs";

const fixtureArg = process.argv[2];
const baseUrl = process.env.LOCAL_API_BASE_URL ?? "http://localhost:4000/api";

assertLocalCandidateApiBaseUrl(baseUrl);

if (!fixtureArg) {
  throw new Error("请传入测试载荷文件路径。");
}

const payload = await readFixture(resolve(process.cwd(), fixtureArg));
const response = await postJson(baseUrl, "/cabinet-events/callbacks/door-status", payload);

console.log(JSON.stringify(response, null, 2));
