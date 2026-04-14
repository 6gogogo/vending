import {
  authPostJson,
  ensureAdminToken,
  findEvent,
  getSandboxConfig
} from "./helpers.mjs";

const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.localApiBaseUrl;
const orderNo = process.argv[2];
const transactionId = process.argv[3] ?? `sandbox-refund-txn-${Date.now()}`;
const refundNo = process.argv[4] ?? `sandbox-refund-${Date.now()}`;
const amountArg = process.argv[5];

const event = await findEvent(baseUrl, orderNo);
const amount = amountArg !== undefined ? Number(amountArg) : event.amount ?? 0;

if (Number.isNaN(amount)) {
  throw new Error("amount 必须是数字。");
}

const token = await ensureAdminToken(baseUrl);
const payload = {
  orderNo: event.orderNo,
  transactionId,
  deviceCode: event.deviceCode,
  refundNo,
  amount
};

const response = await authPostJson(baseUrl, "/inventory-orders/refund", payload, token);

console.log(
  JSON.stringify(
    {
      mode: "via-local-api",
      requestUrl: `${baseUrl.replace(/\/$/, "")}/inventory-orders/refund`,
      requestBody: payload,
      responseStatus: response.status,
      responseBody: response.json
    },
    null,
    2
  )
);
