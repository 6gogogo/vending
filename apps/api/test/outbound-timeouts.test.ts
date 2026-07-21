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
