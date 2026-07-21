import { resolve } from "node:path";

import {
  authPostJson,
  ensureAdminToken,
  getSandboxConfig,
  readFixture
} from "./helpers.mjs";

const fixtureArg = process.argv[2];
const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.localApiBaseUrl;

if (!fixtureArg) {
  throw new Error("请传入模拟柜机载荷文件路径。");
}

const payload = await readFixture(resolve(process.cwd(), fixtureArg));
const token = await ensureAdminToken(baseUrl);
const response = await authPostJson(baseUrl, "/devices/mock/upsert", payload, token);

if (response.status < 200 || response.status >= 300) {
  throw new Error(
    `模拟柜机写入失败（HTTP ${response.status}）：${response.json?.message ?? "后端拒绝请求"}`
  );
}

console.log(
  JSON.stringify(
    {
      mode: "local-mock-fixture-reset",
      requestUrl: `${baseUrl.replace(/\/$/, "")}/devices/mock/upsert`,
      responseStatus: response.status,
      responseBody: response.json
    },
    null,
    2
  )
);
