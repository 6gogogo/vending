import {
  ensureAdminToken,
  findEvent,
  getSystemAuditEntries,
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
    Number(useFixture ? thirdArg ?? fixture?.amount : thirdArg ?? event?.amount ?? 0),
  targetUrl: fixture?.targetUrl ?? fixture?.notifyUrl ?? fixture?.noticeUrl
};

if (!payload.orderNo || !payload.eventId || !payload.deviceCode) {
  throw new Error("缺少 orderNo、eventId 或 deviceCode，无法补发付款成功。");
}

if (Number.isNaN(payload.amount)) {
  throw new Error("amount 必须是数字。");
}

const response = await postJson(baseUrl, "/cabinet-events/callbacks/payment-success", payload);

let platformApi;
let auditLookupError;

try {
  const token = await ensureAdminToken(baseUrl);
  const auditEntries = await getSystemAuditEntries(baseUrl, token, {
    pathContains: "/external/smartvm/api/pay/container/paymentSuccess",
    deviceCode: payload.deviceCode,
    limit: 20
  });

  const matchedAudit = Array.isArray(auditEntries)
    ? auditEntries.find((entry) => {
        const body = entry?.body ?? {};
        return body?.orderNo === payload.orderNo && body?.transactionId === payload.transactionId;
      })
    : undefined;

  if (matchedAudit) {
    platformApi = {
      apiName: "付款成功异步通知",
      requestUrl: matchedAudit.metadata?.requestUrl ?? matchedAudit.path,
      requestBody: matchedAudit.body,
      responseStatus: matchedAudit.statusCode,
      responseBody: matchedAudit.response ?? matchedAudit.error ?? null
    };
  }
} catch (error) {
  auditLookupError = error instanceof Error ? error.message : "无法读取平台转发审计日志。";
}

console.log(
  JSON.stringify(
    {
      mode: "via-local-api",
      localApi: {
        requestUrl: `${baseUrl.replace(/\/$/, "")}/cabinet-events/callbacks/payment-success`,
        source: useFixture ? maybeFixturePath : payload.orderNo,
        requestBody: payload,
        responseStatus: response.status,
        responseBody: response.json
      },
      platformApi,
      auditLookupError
    },
    null,
    2
  )
);
