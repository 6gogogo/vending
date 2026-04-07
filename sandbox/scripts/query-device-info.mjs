import { resolve } from "node:path";

import { getJson, getSandboxConfig, readFixture } from "./helpers.mjs";

const firstArg = process.argv[2];
const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.localApiBaseUrl;
const fixturePath = resolve(process.cwd(), "sandbox/fixtures/goods-query.sample.json");
const fallbackFixture = await readFixture(fixturePath);
const deviceCode = firstArg ?? sandboxConfig.smartVmDeviceCode ?? fallbackFixture.deviceCode;

if (!deviceCode) {
  throw new Error("请传入柜机编号，例如：npm run sandbox:device -- CAB-1001");
}

const unwrapEnvelope = (response) => {
  if (response && typeof response === "object" && "data" in response) {
    return response.data;
  }

  return response;
};

try {
  const response = await getJson(baseUrl, `/devices/${encodeURIComponent(deviceCode)}`);

  console.log(
    JSON.stringify(
      {
        deviceCode,
        device: unwrapEnvelope(response)
      },
      null,
      2
    )
  );
} catch (error) {
  throw new Error(
    `查询本地柜机失败。请确认后端已启动，且 ${baseUrl} 可访问。原始错误：${error instanceof Error ? error.message : String(error)}`
  );
}
