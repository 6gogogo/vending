import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { CabinetEventRecord } from "@vm/shared-types";
import { of } from "rxjs";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { PersistenceInterceptor } from "../src/common/store/persistence.interceptor";
import type { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsController } from "../src/modules/cabinet-events/cabinet-events.controller";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import type { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import type { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP,
  SYSTEM_LOG_FILE: process.env.SYSTEM_LOG_FILE
};

const createTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-callback-log-privacy-"));
  temporaryDirectories.push(directory);
  return directory;
};

const createHarness = () => {
  const directory = createTemporaryDirectory();
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const store = new InMemoryStoreService();
  const device = store.devices[0];
  const door = device?.doors[0];
  const user = store.users.find((entry) => entry.role === "special");
  assert.ok(device);
  assert.ok(door);
  assert.ok(user);

  store.events.splice(0, store.events.length);
  store.logs.splice(0, store.logs.length);
  store.callbackLog.splice(0, store.callbackLog.length);

  const now = new Date().toISOString();
  const event: CabinetEventRecord = {
    eventId: "event-callback-log-privacy",
    orderNo: "order-callback-log-privacy",
    userId: user.id,
    phone: user.phone,
    role: user.role,
    deviceCode: device.deviceCode,
    doorNum: door.doorNum,
    status: "created",
    physicalDoorState: "closed",
    createdAt: now,
    updatedAt: now,
    amount: 0,
    goods: []
  };
  store.events.push(event);

  const accessRules = {} as AccessRulesService;
  const service = new CabinetEventsService(
    store,
    accessRules,
    {
      verifySignedPayload: () => true,
      isUsingMockTransport: () => false
    } as unknown as SmartVmGateway,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({})
  );

  return {
    directory,
    store,
    device,
    event,
    service,
    controller: new CabinetEventsController(service, {} as never)
  };
};

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("柜机回调只落盘安全摘要，后台读取不暴露原始敏感字段且保留重放检测", () => {
  const { directory, store, device, event, service, controller } = createHarness();
  const rawSignature = "callback-signature-must-not-persist";
  const rawPhone = "13876543210";
  const rawPaymentReference = "payment-reference-must-not-persist";
  const rawCallbackToken = "callback-token-must-not-persist";
  const payload = {
    eventId: event.eventId,
    deviceCode: device.deviceCode,
    status: "SUCCESS" as const,
    clientId: "callback-client-must-not-persist",
    nonceStr: "callback-nonce-must-not-persist",
    timestamp: Math.floor(Date.now() / 1000),
    sign: rawSignature,
    phone: rawPhone,
    transactionId: rawPaymentReference,
    notifyUrl: `https://callback.invalid/notify?token=${rawCallbackToken}`,
    paymentToken: rawCallbackToken,
    detail: [
      {
        goodsId: "goods-callback-log-privacy",
        goodsName: "测试货品",
        quantity: 2,
        unitPrice: 350
      }
    ]
  };
  const forbiddenValues = [
    rawSignature,
    rawPhone,
    rawPaymentReference,
    rawCallbackToken,
    "callback-client-must-not-persist",
    "callback-nonce-must-not-persist"
  ];

  const first = service.handleDoorStatus(payload);
  assert.deepEqual(first, { eventId: event.eventId, duplicated: false });
  assert.equal(store.callbackLog.length, 1);
  const storedPayload = store.callbackLog[0]?.payload as Record<string, unknown> | undefined;
  assert.equal(storedPayload?.deviceCode, device.deviceCode);
  assert.equal(storedPayload?.eventId, event.eventId);
  assert.equal(storedPayload?.status, "SUCCESS");

  const persistedLog = JSON.stringify(store.callbackLog[0]);
  const operationLog = JSON.stringify(store.logs.find((entry) => entry.metadata?.callbackLogId));
  const response = controller.callbackLogs("20", device.deviceCode, {
    authUser: {
      tenantId: store.getDeviceTenantId(device)
    }
  });
  const responseBody = JSON.stringify(response.data);

  store.persist();
  const persistedFile = readFileSync(join(directory, "store.json"), "utf8");

  for (const value of forbiddenValues) {
    assert.doesNotMatch(persistedLog, new RegExp(value));
    assert.doesNotMatch(operationLog, new RegExp(value));
    assert.doesNotMatch(responseBody, new RegExp(value));
    assert.doesNotMatch(persistedFile, new RegExp(value));
  }

  assert.equal(response.data.length, 1);
  const responseEntry = response.data[0] as Record<string, unknown> | undefined;
  const responsePayload = responseEntry?.payload as Record<string, unknown> | undefined;
  assert.equal("replay" in (responseEntry ?? {}), false);
  assert.equal(responsePayload?.deviceCode, device.deviceCode);
  assert.equal(responsePayload?.status, "SUCCESS");

  const duplicated = service.handleDoorStatus({ ...payload });
  assert.deepEqual(duplicated, { eventId: event.eventId, duplicated: true });
  assert.equal(store.callbackLog.length, 1);

  assert.throws(
    () => service.handleDoorStatus({ ...payload, status: "CLOSED" }),
    BadRequestException
  );
});

test("启动时清理历史回调日志及关联操作日志中的原始回调字段", () => {
  const directory = createTemporaryDirectory();
  const dataFile = join(directory, "store.json");
  process.env.API_DATA_FILE = dataFile;
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const initialStore = new InMemoryStoreService();
  const state = initialStore.snapshot();
  const rawSignature = "legacy-callback-signature-must-not-persist";
  const rawPhone = "13765432109";
  const rawPaymentReference = "legacy-payment-reference-must-not-persist";
  const rawCallbackToken = "legacy-callback-token-must-not-persist";
  state.callbackLog = [
    {
      id: "callback-legacy-sensitive",
      type: "settlement",
      receivedAt: new Date().toISOString(),
      payload: {
        deviceCode: "CAB-LEGACY",
        eventId: "event-legacy",
        orderNo: "order-legacy-sensitive",
        sign: rawSignature,
        phone: rawPhone,
        transactionId: rawPaymentReference,
        notifyUrl: `https://callback.invalid/notify?token=${rawCallbackToken}`
      },
      replay: {
        payloadFingerprint: rawCallbackToken
      }
    }
  ] as never;
  state.logs = [
    {
      id: "log-legacy-sensitive",
      category: "device",
      type: "door-status-callback",
      status: "success",
      occurredAt: new Date().toISOString(),
      actor: { type: "system", name: "柜机平台" },
      description: "历史回调",
      detail: "历史回调",
      metadata: {
        callbackLogId: "callback-legacy-sensitive",
        callbackPayload: state.callbackLog[0]?.payload
      }
    }
  ];
  writeFileSync(dataFile, JSON.stringify(state), "utf8");

  const restartedStore = new InMemoryStoreService();
  const sanitizedInMemory = JSON.stringify({
    callbackLog: restartedStore.callbackLog,
    logs: restartedStore.logs
  });

  for (const value of [rawSignature, rawPhone, rawPaymentReference, rawCallbackToken]) {
    assert.doesNotMatch(sanitizedInMemory, new RegExp(value));
  }

  assert.equal(restartedStore.flushBootstrapPersistence(), true);
  const sanitizedOnDisk = readFileSync(dataFile, "utf8");

  for (const value of [rawSignature, rawPhone, rawPaymentReference, rawCallbackToken]) {
    assert.doesNotMatch(sanitizedOnDisk, new RegExp(value));
  }
});

test("柜机回调请求体写入系统审计时仅保留安全摘要", async () => {
  const directory = createTemporaryDirectory();
  process.env.SYSTEM_LOG_FILE = join(directory, "system-audit.ndjson");
  const rawSignature = "audit-callback-signature-must-not-persist";
  const rawPhone = "13654321098";
  const rawOrderNo = "audit-order-reference-must-not-persist";
  const rawTransactionId = "audit-transaction-reference-must-not-persist";
  const rawCallbackToken = "audit-callback-token-must-not-persist";
  const interceptor = new PersistenceInterceptor({ persist: () => undefined } as InMemoryStoreService);
  const request = {
    method: "POST",
    url: `/api/cabinet-events/callbacks/settlement?sign=${rawSignature}&orderNo=${rawOrderNo}`,
    query: {
      sign: rawSignature,
      orderNo: rawOrderNo,
      transactionId: rawTransactionId
    },
    body: {
      deviceCode: "CAB-AUDIT",
      eventId: "event-audit",
      orderNo: rawOrderNo,
      transactionId: rawTransactionId,
      phone: rawPhone,
      sign: rawSignature,
      notifyUrl: `https://callback.invalid/notify?token=${rawCallbackToken}`,
      amount: 700,
      detail: [{ goodsId: "goods-audit", quantity: 2, unitPrice: 350 }]
    }
  };
  const response = {
    statusCode: 200,
    getHeader: () => undefined
  };

  await new Promise<void>((resolve, reject) => {
    interceptor
      .intercept(
        {
          switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response
          })
        } as never,
        { handle: () => of({ code: 0, message: "success", data: {} }) } as never
      )
      .subscribe({ complete: resolve, error: reject });
  });

  const auditLog = readFileSync(process.env.SYSTEM_LOG_FILE!, "utf8");

  for (const value of [rawSignature, rawPhone, rawOrderNo, rawTransactionId, rawCallbackToken]) {
    assert.doesNotMatch(auditLog, new RegExp(value));
  }

  assert.match(auditLog, /"deviceCode":"CAB-AUDIT"/);
  assert.match(auditLog, /"eventId":"event-audit"/);
  assert.match(auditLog, /"amount":700/);
  assert.match(auditLog, /"itemCount":1/);
  assert.match(auditLog, /"totalQuantity":2/);
});
