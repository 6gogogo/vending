import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { BadRequestException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module";
import {
  parseCabinetOpenRequest,
  parseCabinetReservationCreatePayload
} from "../src/common/validation/cabinet-operation-input";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { listenOnFetchSafeLoopbackPort } from "./support/fetch-safe-api-listener";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP,
  SYSTEM_LOG_FILE: process.env.SYSTEM_LOG_FILE
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

test("柜机操作解析器严格拒绝未知字段、错误类型、重复商品、空预约意图和超限数量", () => {
  const openBase = {
    phone: "13800000003",
    deviceCode: "CAB-1001",
    doorNum: "1"
  };
  const invalidOpenPayloads = [
    { ...openBase, unexpected: true },
    { ...openBase, payStyle: "1" },
    { ...openBase, phone: 13800000003 },
    {
      ...openBase,
      intentItems: [
        { goodsId: "goods-001", quantity: 1 },
        { goodsId: "goods-001", quantity: 1 }
      ]
    },
    {
      ...openBase,
      intentItems: [{ goodsId: "goods-001", quantity: 1_001 }]
    }
  ];

  for (const payload of invalidOpenPayloads) {
    assert.throws(() => parseCabinetOpenRequest(payload), BadRequestException);
  }

  assert.throws(
    () =>
      parseCabinetReservationCreatePayload({
        deviceCode: "CAB-1001",
        doorNum: "1",
        intentItems: []
      }),
    BadRequestException
  );
});

test("柜机操作真实路由统一返回 400，且失败请求不会产生事件、预约或网关副作用", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-cabinet-operation-input-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.SYSTEM_LOG_FILE = join(directory, "system-audit.jsonl");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  const port = await listenOnFetchSafeLoopbackPort(app);

  try {
    const store = app.get(InMemoryStoreService);
    const gateway = app.get(SmartVmGateway);
    const user = store.users.find(
      (entry) => entry.role === "special" && entry.status === "active"
    );
    const device = store.devices[0];
    const goods = device?.doors.flatMap((door) => door.goods)[0];
    assert.ok(user);
    assert.ok(device);
    assert.ok(goods);

    let gatewayCalls = 0;
    gateway.openDoor = (async () => {
      gatewayCalls += 1;
      return { orderNo: "must-not-open", smartVmExchange: undefined };
    }) as typeof gateway.openDoor;

    const token = store.createSession(user);
    const baseUrl = `http://127.0.0.1:${port}/api`;
    const openBase = {
      phone: user.phone,
      deviceCode: device.deviceCode,
      doorNum: device.doors[0]?.doorNum ?? "1"
    };
    const requests = [
      {
        label: "开柜未知字段",
        path: "/cabinet-events/open",
        body: { ...openBase, unexpected: true },
        expectedMessage: "包含不支持的字段"
      },
      {
        label: "客户端不能覆盖平台支付方式",
        path: "/cabinet-events/open",
        body: { ...openBase, payStyle: "1" },
        expectedMessage: "包含不支持的字段"
      },
      {
        label: "预结算错误字段类型",
        path: "/cabinet-events/open/pre-settlement",
        body: { ...openBase, phone: 13800000003 },
        expectedMessage: "手机号必须是字符串"
      },
      {
        label: "开柜重复商品",
        path: "/cabinet-events/open",
        body: {
          ...openBase,
          intentItems: [
            { goodsId: goods.goodsId, quantity: 1 },
            { goodsId: goods.goodsId, quantity: 1 }
          ]
        },
        expectedMessage: "商品明细不能重复提交商品"
      },
      {
        label: "预结算超限数量",
        path: "/cabinet-events/open/pre-settlement",
        body: {
          ...openBase,
          intentItems: [{ goodsId: goods.goodsId, quantity: 1_001 }]
        },
        expectedMessage: "数量必须是 1-1000 的整数"
      },
      {
        label: "预约空意图",
        path: "/reservations",
        body: {
          deviceCode: device.deviceCode,
          doorNum: device.doors[0]?.doorNum ?? "1",
          intentItems: []
        },
        expectedMessage: "商品明细必须是非空数组"
      }
    ];

    for (const request of requests) {
      const eventsBefore = structuredClone(store.events);
      const reservationsBefore = structuredClone(store.reservations);
      const logsBefore = structuredClone(store.logs);
      const gatewayCallsBefore = gatewayCalls;
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(request.body)
      });
      const responseBody = (await response.json()) as {
        statusCode?: number;
        message?: string | string[];
      };

      assert.equal(response.status, 400, request.label);
      assert.equal(responseBody.statusCode, 400, request.label);
      const errorMessage = Array.isArray(responseBody.message)
        ? responseBody.message.join("；")
        : responseBody.message ?? "";
      assert.match(errorMessage, new RegExp(request.expectedMessage), request.label);
      assert.deepEqual(store.events, eventsBefore, `${request.label} 不应新增或修改事件`);
      assert.deepEqual(
        store.reservations,
        reservationsBefore,
        `${request.label} 不应新增或修改预约`
      );
      assert.deepEqual(store.logs, logsBefore, `${request.label} 不应新增操作日志`);
      assert.equal(gatewayCalls, gatewayCallsBefore, `${request.label} 不应调用柜机网关`);
    }
  } finally {
    await app.close();
  }
});
