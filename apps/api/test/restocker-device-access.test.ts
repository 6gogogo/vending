import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { NestFactory } from "@nestjs/core";
import type { CabinetEventRecord } from "@vm/shared-types";

import { AppModule } from "../src/app.module";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP
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

const startApi = async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-restocker-access-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");

  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === "object");

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    store: app.get(InMemoryStoreService)
  };
};

const createTenantAdminToken = (store: InMemoryStoreService) => {
  const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  return store.createBackofficeSession(user, credential.role, credential.tenantId);
};

const toLocalDateKey = (value = new Date()) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const buildClosedRestockEvent = (payload: {
  eventId: string;
  userId: string;
  phone: string;
  deviceCode: string;
}): CabinetEventRecord => {
  const now = new Date().toISOString();
  return {
    eventId: payload.eventId,
    orderNo: `order-${payload.eventId}`,
    userId: payload.userId,
    phone: payload.phone,
    role: "restocker",
    deviceCode: payload.deviceCode,
    doorNum: "1",
    operationType: "restock",
    hasInboundGoods: true,
    status: "closed",
    physicalDoorState: "closed",
    createdAt: now,
    updatedAt: now,
    amount: 0,
    goods: []
  };
};

test("实例管理员可创建独立补货员并开通最小权限后台账号", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000101",
        name: "测试补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: {
        id?: string;
        role?: string;
        assignedDeviceCodes?: string[];
      };
    };
    const restockerUserId = createUserPayload.data?.id;

    assert.equal(createUserResponse.status, 201);
    assert.ok(restockerUserId);
    assert.equal(createUserPayload.data?.role, "restocker");
    assert.deepEqual(createUserPayload.data?.assignedDeviceCodes, []);

    const createCredentialResponse = await fetch(`${baseUrl}/auth/backoffice-credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        userId: restockerUserId,
        username: "restocker-test",
        password: "restocker-test-password",
        role: "restocker"
      })
    });

    assert.equal(createCredentialResponse.status, 201);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "restocker-test",
        password: "restocker-test-password"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: {
        user?: {
          role?: string;
          backofficeRole?: string;
          scope?: string;
          permissions?: string[];
        };
      };
    };

    assert.equal(loginResponse.status, 201);
    assert.equal(loginPayload.data?.user?.role, "restocker");
    assert.equal(loginPayload.data?.user?.backofficeRole, "restocker");
    assert.equal(loginPayload.data?.user?.scope, "tenant");
    assert.deepEqual(loginPayload.data?.user?.permissions, [
      "goods:view",
      "devices:view",
      "devices:operate"
    ]);
  } finally {
    await app.close();
  }
});

test("补货员只能列出和查看管理员明确分配的柜机", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000102",
        name: "设备分配测试补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    const restockerUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(restockerUserId);

    const [assignedDevice, unassignedDevice] = store.devices;
    assert.ok(assignedDevice);
    assert.ok(unassignedDevice);

    const assignmentResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(restockerUserId)}/device-assignment`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceCodes: [assignedDevice.deviceCode]
        })
      }
    );
    const assignmentPayload = (await assignmentResponse.json()) as {
      data?: { assignedDeviceCodes?: string[] };
    };

    assert.equal(assignmentResponse.status, 200);
    assert.deepEqual(assignmentPayload.data?.assignedDeviceCodes, [
      assignedDevice.deviceCode
    ]);

    const restocker = store.users.find((entry) => entry.id === restockerUserId);
    assert.ok(restocker);
    const restockerToken = store.createSession(restocker);
    const synchronizedDeviceCodes: Array<string | undefined> = [];
    const originalSyncDeviceStocks =
      store.syncDeviceStocksFromBatches.bind(store);
    store.syncDeviceStocksFromBatches = (deviceCode?: string) => {
      synchronizedDeviceCodes.push(deviceCode);
      return originalSyncDeviceStocks(deviceCode);
    };
    const listResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${restockerToken}`
      }
    });
    store.syncDeviceStocksFromBatches = originalSyncDeviceStocks;
    const listPayload = (await listResponse.json()) as {
      data?: Array<{ deviceCode?: string }>;
    };

    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      listPayload.data?.map((entry) => entry.deviceCode),
      [assignedDevice.deviceCode]
    );
    assert.deepEqual(synchronizedDeviceCodes, [assignedDevice.deviceCode]);

    const assignedDetailResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(assignedDevice.deviceCode)}`,
      {
        headers: {
          authorization: `Bearer ${restockerToken}`
        }
      }
    );
    const unassignedDetailResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(unassignedDevice.deviceCode)}`,
      {
        headers: {
          authorization: `Bearer ${restockerToken}`
        }
      }
    );

    assert.equal(assignedDetailResponse.status, 200);
    assert.equal(unassignedDetailResponse.status, 403);
  } finally {
    await app.close();
  }
});

test("补货员开柜预结算在业务写入前拒绝未分配柜机", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000103",
        name: "开柜权限测试补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    const restockerUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(restockerUserId);

    const [assignedDevice, unassignedDevice] = store.devices;
    assert.ok(assignedDevice);
    assert.ok(unassignedDevice);
    const assignmentResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(restockerUserId)}/device-assignment`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceCodes: [assignedDevice.deviceCode]
        })
      }
    );
    assert.equal(assignmentResponse.status, 200);

    const restocker = store.users.find((entry) => entry.id === restockerUserId);
    assert.ok(restocker);
    const restockerToken = store.createSession(restocker);
    const beforeEvents = structuredClone(store.events);
    const requestPreview = (deviceCode: string) =>
      fetch(`${baseUrl}/cabinet-events/open/pre-settlement`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${restockerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone: restocker.phone,
          deviceCode,
          doorNum: "1",
          hasInboundGoods: true
        })
      });

    const unassignedResponse = await requestPreview(unassignedDevice.deviceCode);
    const unassignedPayload = (await unassignedResponse.json()) as {
      message?: string;
    };

    assert.equal(unassignedResponse.status, 403);
    assert.equal(unassignedPayload.message, "当前账号未被分配该柜机。");
    assert.deepEqual(store.events, beforeEvents);

    assignedDevice.status = "online";
    assignedDevice.lastSeenAt = new Date().toISOString();
    store.updateDeviceRuntime(assignedDevice.deviceCode, {
      lastRefreshAt: assignedDevice.lastSeenAt,
      openedAfterLastCommand: true
    });

    const assignedResponse = await requestPreview(assignedDevice.deviceCode);
    const assignedPayload = (await assignedResponse.json()) as {
      data?: {
        role?: string;
        operationType?: string;
      };
    };

    assert.equal(assignedResponse.status, 200);
    assert.equal(assignedPayload.data?.role, "restocker");
    assert.equal(assignedPayload.data?.operationType, "restock");
    assert.deepEqual(store.events, beforeEvents);
  } finally {
    await app.close();
  }
});

test("商户重新分配柜机后列表与开柜预结算使用同一授权结果", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const merchant = store.users.find(
      (entry) => entry.role === "merchant" && entry.status === "active"
    );
    const [assignedDevice, unassignedDevice] = store.devices;
    assert.ok(merchant);
    assert.ok(assignedDevice);
    assert.ok(unassignedDevice);

    const assignmentResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(merchant.id)}/device-assignment`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceCodes: [assignedDevice.deviceCode]
        })
      }
    );
    assert.equal(assignmentResponse.status, 200);

    const merchantToken = store.createSession(merchant);
    const listResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${merchantToken}`
      }
    });
    const listPayload = (await listResponse.json()) as {
      data?: Array<{ deviceCode?: string }>;
    };
    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      listPayload.data?.map((entry) => entry.deviceCode),
      [assignedDevice.deviceCode]
    );

    const previewResponse = await fetch(`${baseUrl}/cabinet-events/open/pre-settlement`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${merchantToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: merchant.phone,
        deviceCode: unassignedDevice.deviceCode,
        doorNum: "1",
        hasInboundGoods: true
      })
    });
    const previewPayload = (await previewResponse.json()) as { message?: string };

    assert.equal(previewResponse.status, 403);
    assert.equal(previewPayload.message, "当前账号未被分配该柜机。");
  } finally {
    await app.close();
  }
});

test("补货员只能读取公共货品模板，不能看到或维护商户私有模板", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const merchant = store.users.find(
      (entry) => entry.role === "merchant" && entry.status === "active"
    );
    const goods = store.goodsCatalog[0];
    assert.ok(merchant);
    assert.ok(goods);

    const privateTemplateId = "template-private-merchant-only";
    const now = new Date().toISOString();
    store.merchantGoodsTemplates.unshift({
      id: privateTemplateId,
      ownerUserId: merchant.id,
      goodsId: goods.goodsId,
      goodsCode: goods.goodsCode,
      goodsName: "商户私有模板",
      category: goods.category,
      defaultQuantity: 1,
      defaultShelfLifeDays: 2,
      status: "active",
      createdAt: now,
      updatedAt: now
    });

    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000104",
        name: "模板隔离测试补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    const restocker = store.users.find(
      (entry) => entry.id === createUserPayload.data?.id
    );
    assert.equal(createUserResponse.status, 201);
    assert.ok(restocker);

    const restockerToken = store.createSession(restocker);
    const listResponse = await fetch(`${baseUrl}/merchant-goods-templates`, {
      headers: {
        authorization: `Bearer ${restockerToken}`
      }
    });
    const listPayload = (await listResponse.json()) as {
      data?: Array<{ id?: string; ownerUserId?: string }>;
    };

    assert.equal(listResponse.status, 200);
    assert.ok((listPayload.data?.length ?? 0) > 0);
    assert.equal(
      listPayload.data?.some((entry) => entry.id === privateTemplateId),
      false
    );
    assert.equal(
      listPayload.data?.every((entry) => entry.ownerUserId === "system"),
      true
    );

    const createTemplateResponse = await fetch(
      `${baseUrl}/merchant-goods-templates`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${restockerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          goodsName: "补货员不得创建",
          category: "daily",
          defaultQuantity: 1,
          defaultShelfLifeDays: 2
        })
      }
    );
    assert.equal(createTemplateResponse.status, 403);
  } finally {
    await app.close();
  }
});

test("补货员仅能在已分配柜机完成补货，并只能读取自己的汇总和追溯", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000105",
        name: "补货闭环测试补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    const restocker = store.users.find(
      (entry) => entry.id === createUserPayload.data?.id
    );
    assert.equal(createUserResponse.status, 201);
    assert.ok(restocker);

    const [assignedDevice, unassignedDevice] = store.devices;
    const goods = store.goodsCatalog[0];
    assert.ok(assignedDevice);
    assert.ok(unassignedDevice);
    assert.ok(goods);

    const assignmentResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(restocker.id)}/device-assignment`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceCodes: [assignedDevice.deviceCode]
        })
      }
    );
    assert.equal(assignmentResponse.status, 200);

    const assignedEvent = buildClosedRestockEvent({
      eventId: "event-restocker-assigned",
      userId: restocker.id,
      phone: restocker.phone,
      deviceCode: assignedDevice.deviceCode
    });
    const unassignedEvent = buildClosedRestockEvent({
      eventId: "event-restocker-unassigned",
      userId: restocker.id,
      phone: restocker.phone,
      deviceCode: unassignedDevice.deviceCode
    });
    store.events.unshift(assignedEvent, unassignedEvent);

    const restockerToken = store.createSession(restocker);
    const templateId = `catalog-${goods.goodsId}`;
    const inventoryBeforeDenied = structuredClone(store.inventory);
    const submitRestock = (event: CabinetEventRecord) =>
      fetch(`${baseUrl}/merchant-restocks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${restockerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          templateId,
          deviceCode: event.deviceCode,
          quantity: 1,
          productionDate: toLocalDateKey(),
          confirmed: true,
          cabinetEventId: event.eventId
        })
      });

    const deniedResponse = await submitRestock(unassignedEvent);
    const deniedPayload = (await deniedResponse.json()) as { message?: string };
    assert.equal(deniedResponse.status, 403);
    assert.equal(deniedPayload.message, "当前账号未被分配该柜机。");
    assert.deepEqual(store.inventory, inventoryBeforeDenied);

    const acceptedResponse = await submitRestock(assignedEvent);
    const acceptedPayload = (await acceptedResponse.json()) as {
      data?: {
        batch?: { sourceUserId?: string };
      };
    };
    assert.equal(acceptedResponse.status, 201);
    assert.equal(acceptedPayload.data?.batch?.sourceUserId, restocker.id);
    assert.equal(
      store.logs.find(
        (entry) =>
          entry.type === "merchant-restock-template" &&
          entry.metadata?.cabinetEventId === assignedEvent.eventId
      )?.actor.type,
      "restocker"
    );

    const merchant = store.users.find(
      (entry) => entry.role === "merchant" && entry.status === "active"
    );
    assert.ok(merchant);
    const summaryResponse = await fetch(
      `${baseUrl}/inventory-orders/merchant-summary?userId=${encodeURIComponent(merchant.id)}`,
      {
        headers: {
          authorization: `Bearer ${restockerToken}`
        }
      }
    );
    const summaryPayload = (await summaryResponse.json()) as {
      data?: {
        donatedUnits?: number;
        records?: Array<{ userId?: string }>;
      };
    };
    assert.equal(summaryResponse.status, 200);
    assert.equal(summaryPayload.data?.donatedUnits, 1);
    assert.equal(
      summaryPayload.data?.records?.every(
        (entry) => entry.userId === restocker.id
      ),
      true
    );

    const tracesResponse = await fetch(`${baseUrl}/merchant-restock-traces`, {
      headers: {
        authorization: `Bearer ${restockerToken}`
      }
    });
    const tracesPayload = (await tracesResponse.json()) as {
      data?: {
        batches?: Array<{ sourceUserId?: string }>;
      };
    };
    assert.equal(tracesResponse.status, 200);
    assert.equal(
      tracesPayload.data?.batches?.every(
        (entry) => entry.sourceUserId === restocker.id
      ),
      true
    );
  } finally {
    await app.close();
  }
});
