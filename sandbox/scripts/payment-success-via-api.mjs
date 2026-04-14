import {
  findEvent,
  readFixture,
  getSandboxConfig,
  postJson
} from "./helpers.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.localApiBaseUrl;
const firstArg = process.argv[2];
const secondArg = process.argv[3];
const thirdArg = process.argv[4];

const maybeFixturePath = firstArg ? resolve(process.cwd(), firstArg) : "";
const useFixture = Boolean(firstArg && existsSync(maybeFixturePath));

const event = useFixture
  ? undefined
  : await findEvent(baseUrl, firstArg);
const fixture = useFixture
  ? await readFixture(maybeFixturePath)
  : undefined;

const payload = {
  orderNo: fixture?.orderNo ?? event?.orderNo,
  eventId: fixture?.eventId ?? event?.eventId,
  transactionId:
    (useFixture ? secondArg : secondArg) ??
    fixture?.transactionId ??
    `sandbox-txn-${Date.now()}`,
  deviceCode: fixture?.deviceCode ?? event?.deviceCode,
  amount:
    Number(useFixture ? thirdArg ?? fixture?.amount : thirdArg ?? event?.amount ?? 0)
};

if (!payload.orderNo || !payload.eventId || !payload.deviceCode) {
  throw new Error("缺少 orderNo、eventId 或 deviceCode，无法补发付款成功。");
}

if (Number.isNaN(payload.amount)) {
  throw new Error("amount 必须是数字。");
}

const response = await postJson(baseUrl, "/cabinet-events/callbacks/payment-success", payload);

console.log(
  JSON.stringify(
    {
      mode: "via-local-api",
      requestUrl: `${baseUrl.replace(/\/$/, "")}/cabinet-events/callbacks/payment-success`,
      source: useFixture ? maybeFixturePath : payload.orderNo,
      requestBody: payload,
      responseStatus: response.status,
      responseBody: response.json
    },
    null,
    2
  )
);
