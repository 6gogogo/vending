import { createNonce, getSandboxConfig, postJson, signPayload } from "./helpers.mjs";

const sandboxConfig = getSandboxConfig();
const baseUrl = process.env.SMARTVM_BASE_URL ?? sandboxConfig.smartVmBaseUrl ?? "http://pre.smartvm.cn";
const clientId = process.env.SMARTVM_CLIENT_ID;
const key = process.env.SMARTVM_KEY;
const deviceCode = process.argv[2] ?? process.env.SMARTVM_DEVICE_CODE ?? sandboxConfig.smartVmDeviceCode ?? "91120149";
const phone = process.argv[3] ?? "13800000002";
const userId = process.argv[4] ?? "00000001";
const extraPayStyles = (process.env.SMARTVM_EXTRA_PAY_STYLES ?? "duan3")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!clientId || !key) {
  throw new Error("必须提供 SMARTVM_CLIENT_ID 和 SMARTVM_KEY。");
}

if (!deviceCode) {
  throw new Error("必须提供设备编号。");
}

const buildPayload = (patch = {}) => {
  const payload = {
    userId,
    eventId: `000000000000000000`,
    deviceCode,
    phone,
    ...patch
  };
  const nonceStr = createNonce();
  const unsignedPayload = {
    ...payload,
    clientId,
    nonceStr
  };

  return {
    ...unsignedPayload,
    sign: signPayload(unsignedPayload, key)
  };
};

const cases = [
  { name: "payStyle=2, doorNum=1", patch: { payStyle: "2", doorNum: "1" } },
  { name: "payStyle=3, doorNum=1", patch: { payStyle: "3", doorNum: "1" } },
  { name: "payStyle=7, doorNum=1", patch: { payStyle: "7", doorNum: "1" } },
  ...extraPayStyles.map((payStyle) => ({
    name: `payStyle=${payStyle}, doorNum=1`,
    patch: { payStyle, doorNum: "1" }
  })),
  { name: "payStyle=2, no doorNum", patch: { payStyle: "2" } },
  { name: "payStyle=3, no doorNum", patch: { payStyle: "3" } },
  { name: "payStyle=7, no doorNum", patch: { payStyle: "7" } },
  ...extraPayStyles.map((payStyle) => ({
    name: `payStyle=${payStyle}, no doorNum`,
    patch: { payStyle }
  }))
];

const results = [];

for (const testCase of cases) {
  const payload = buildPayload(testCase.patch);
  const response = await postJson(baseUrl, "/api/pay/container/opendoor", payload);
  results.push({
    case: testCase.name,
    requestUrl: `${baseUrl.replace(/\/$/, "")}/api/pay/container/opendoor`,
    requestBody: payload,
    responseStatus: response.status,
    responseBody: response.json
  });
}

console.log(JSON.stringify(results, null, 2));
