import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { postAbsoluteJson, readFixture, withSignature } from "./helpers.mjs";

const fixtureArg = process.argv[2] ?? "sandbox/fixtures/payment-success.sample.json";
const configuredBaseUrl = process.env.SMARTVM_BASE_URL ?? "http://pre.smartvm.cn";

const fixturePath = resolve(process.cwd(), fixtureArg);

if (!existsSync(fixturePath)) {
  throw new Error(`未找到测试载荷文件：${fixturePath}`);
}

const fixture = await readFixture(fixturePath);
const targetUrl =
  fixture.targetUrl ??
  fixture.notifyUrl ??
  fixture.noticeUrl ??
  `${configuredBaseUrl.replace(/\/$/, "")}/api/pay/container/paymentSuccess`;

const payload = {
  orderNo: fixture.orderNo,
  eventId: fixture.eventId,
  transactionId: fixture.transactionId ?? `sandbox-txn-${Date.now()}`,
  openId: fixture.openId,
  deviceCode: fixture.deviceCode,
  amount: Number(fixture.amount ?? 0)
};

if (!payload.orderNo || !payload.eventId || !payload.deviceCode) {
  throw new Error("缺少 orderNo、eventId 或 deviceCode，无法调用付款成功异步通知。");
}

if (Number.isNaN(payload.amount)) {
  throw new Error("amount 必须是数字。");
}

const signedPayload = withSignature(payload);
const response = await postAbsoluteJson(targetUrl, signedPayload);

console.log(
  JSON.stringify(
    {
      apiName: "付款成功异步通知",
      requestUrl: targetUrl,
      requestBody: signedPayload,
      responseStatus: response.status,
      responseBody: response.json
    },
    null,
    2
  )
);
