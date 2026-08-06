import assert from "node:assert/strict";
import test from "node:test";

import { ConfigService } from "@nestjs/config";

import { ApiError, createJsonClient } from "../../../packages/shared-client/src/http";
import {
  SmartVmClient,
  SmartVmRequestError
} from "../../../packages/shared-client/src/smartvm/smartvm-client";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { PaymentsService } from "../src/modules/payments/payments.service";

const neverCompletingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  })) as typeof fetch;

const stalledJsonBodyFetch = (async () =>
  ({
    ok: true,
    status: 200,
    json: () => new Promise<never>(() => undefined)
  }) as unknown as Response) as typeof fetch;

test("通用 JSON 客户端包含响应体读取在内的超时会返回 408", async () => {
  const client = createJsonClient({
    baseUrl: "http://127.0.0.1:9",
    fetchImpl: stalledJsonBodyFetch,
    timeoutMs: 5
  });

  await assert.rejects(
    client.get("/health"),
    (error: unknown) => error instanceof ApiError && error.status === 408 && /请求超时/.test(error.message)
  );
});

test("SmartVM 客户端超时会中止请求并保留 504 跟踪语义", async () => {
  const exchanges: Array<{ statusCode: number; responseBody: unknown }> = [];
  const client = new SmartVmClient({
    baseUrl: "http://127.0.0.1:9",
    credentials: { clientId: "local-test", key: "local-test-key" },
    fetchImpl: neverCompletingFetch,
    timeoutMs: 5,
    onExchange: (exchange) => exchanges.push(exchange)
  });

  await assert.rejects(
    client.openDoor({
      userId: "user-local",
      eventId: "event-local",
      deviceCode: "device-local",
      payStyle: "2",
      phone: "13800000000"
    }),
    (error: unknown) =>
      error instanceof SmartVmRequestError &&
      error.statusCode === 504 &&
      error.path === "/api/pay/container/opendoor"
  );
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0]?.statusCode, 504);
});

test("SmartVM 设备确认沿用 1.1 POST JSON 契约，不调用旧 1.2 GET 状态接口", async () => {
  const requests: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url: String(input), init, body });
    return new Response(
      JSON.stringify({ code: 200, message: "请求成功", data: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new SmartVmClient({
    baseUrl: "https://smartvm.example",
    credentials: { clientId: "local-test", key: "local-test-key" },
    fetchImpl
  });

  await client.getCabinetGoodsInfo({ deviceCode: "91110265", doorNum: "1" });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://smartvm.example/api/pay/container/getCabinetGoodsInfo");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("content-type"),
    "application/json"
  );
  assert.equal(requests[0]?.body?.deviceCode, "91110265");
  assert.equal(requests[0]?.body?.doorNum, "1");
  assert.equal(requests[0]?.body?.clientId, "local-test");
  assert.equal(typeof requests[0]?.body?.nonceStr, "string");
  assert.equal(typeof requests[0]?.body?.sign, "string");
  assert.equal(requests[0]?.body?.assetId, undefined);
  assert.equal(requests[0]?.body?.nonce_str, undefined);
});

test("SmartVM 上游 HTML 错误只返回收敛后的状态信息", () => {
  const gateway = new SmartVmGateway(new ConfigService({}));
  const error = new SmartVmRequestError(
    "<!doctype html><html><title>HTTP Status 405</title><h1>Apache Tomcat</h1></html>",
    405,
    "/osapi/router/status",
    {},
    "<!doctype html><html><title>HTTP Status 405</title><h1>Apache Tomcat</h1></html>"
  );

  const message = gateway.extractErrorMessage(error);
  assert.match(message, /HTTP 405/);
  assert.doesNotMatch(message, /doctype|html|Tomcat/i);
});

test("SmartVM 付款回写拒绝不在允许来源中的 URL", async () => {
  const gateway = new SmartVmGateway(
    new ConfigService({
      SMARTVM_BASE_URL: "https://smartvm.example",
      SMARTVM_CLIENT_ID: "local-test",
      SMARTVM_KEY: "local-test-key"
    })
  );

  await assert.rejects(
    gateway.notifyPaymentSuccess(
      {
        orderNo: "order-local",
        eventId: "event-local",
        transactionId: "transaction-local",
        deviceCode: "device-local",
        amount: 100
      },
      { targetUrl: "http://127.0.0.1/internal" }
    ),
    /不在允许的来源列表/
  );
});

test("支付供应商超时返回明确错误，不无限占用请求", async () => {
  const service = new PaymentsService(
    {} as InMemoryStoreService,
    new ConfigService({ PAYMENT_PROVIDER_TIMEOUT_MS: "5" }),
    {} as CabinetEventsService,
    {} as InventoryOrdersService
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = neverCompletingFetch;

  try {
    await assert.rejects(
      (service as unknown as {
        callJsonEndpoint(url: string, label: string): Promise<unknown>;
      }).callJsonEndpoint("http://127.0.0.1:9/never", "本地支付 stub"),
      /本地支付 stub请求超过 5 毫秒/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
