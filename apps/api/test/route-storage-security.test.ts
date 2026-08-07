import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  BadRequestException,
  HttpException,
  UnauthorizedException
} from "@nestjs/common";
import type { StocktakeRecord, SystemAuditLogEntry } from "@vm/shared-types";

import { resolveTrustProxySetting } from "../src/common/config/http-runtime";
import {
  toSafeFilenameSegment,
  toSafeSpreadsheetCell
} from "../src/common/export/html-workbook";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { appendSystemAuditLog } from "../src/common/store/persistence";
import { AuthService } from "../src/modules/auth/auth.service";
import { AiInsightsService } from "../src/modules/ai-insights/ai-insights.service";
import { DevicesService } from "../src/modules/devices/devices.service";
import { GoodsService } from "../src/modules/goods/goods.service";
import { OperationLogsService } from "../src/modules/operation-logs/operation-logs.service";
import { RegistrationApplicationsService } from "../src/modules/registration-applications/registration-applications.service";
import { detectValidatedImageExtension } from "../src/modules/uploads/image-file-validation";
import { UploadsController } from "../src/modules/uploads/uploads.controller";
import { WarehousesService } from "../src/modules/warehouses/warehouses.service";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP,
  SYSTEM_LOG_FILE: process.env.SYSTEM_LOG_FILE,
  UPLOAD_DIR: process.env.UPLOAD_DIR
};

const createTemporaryDirectory = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createIsolatedStore = () => {
  const directory = createTemporaryDirectory("vm-route-store-");
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
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

test("HTML-XLS 单元格同时阻止 HTML 与公式注入", () => {
  assert.equal(toSafeSpreadsheetCell('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(toSafeSpreadsheetCell("  =HYPERLINK(\"https://invalid\")"), "&#39;  =HYPERLINK(&quot;https://invalid&quot;)");
  assert.equal(toSafeSpreadsheetCell("+SUM(1,1)"), "&#39;+SUM(1,1)");
  assert.equal(toSafeSpreadsheetCell(-3), "-3");
  assert.equal(toSafeFilenameSegment("CAB\r\n../危险:*?"), "CAB-..-危险");
});

test("操作日志、货品总览、盘点三类导出均使用安全单元格", () => {
  const store = createIsolatedStore();
  const maliciousHtml = '<img src=x onerror="alert(1)">';
  const maliciousFormula = "=HYPERLINK(\"https://invalid\")";

  store.logs.unshift({
    id: "log-export-security",
    category: "admin",
    type: "security-test",
    status: "success",
    occurredAt: new Date().toISOString(),
    actor: { type: "admin", name: maliciousFormula },
    description: maliciousHtml,
    detail: maliciousFormula
  });

  const operationLogs = new OperationLogsService(store, {} as never);
  const operationBody = operationLogs.buildExport(undefined, "super_admin").body;

  assert.doesNotMatch(operationBody, /<img src=x/);
  assert.match(operationBody, /&lt;img src=x/);
  assert.match(operationBody, /&#39;=HYPERLINK/);

  const catalogItem = store.goodsCatalog[0];
  assert.ok(catalogItem);
  catalogItem.name = maliciousHtml;
  catalogItem.manufacturer = maliciousFormula;

  const goods = new GoodsService(store, {} as never, {} as never);
  const goodsBody = goods.buildOverviewExport().body;

  assert.doesNotMatch(goodsBody, /<img src=x/);
  assert.match(goodsBody, /&lt;img src=x/);
  assert.match(goodsBody, /&#39;=HYPERLINK/);

  const record: StocktakeRecord = {
    id: "stocktake-security",
    deviceCode: "CAB\r\n../001",
    deviceName: maliciousHtml,
    createdAt: new Date().toISOString(),
    actorUserName: maliciousFormula,
    items: [
      {
        goodsId: catalogItem.goodsId,
        goodsName: maliciousHtml,
        category: catalogItem.category,
        systemQuantity: 1,
        actualQuantity: 2,
        delta: 1,
        batchCount: 1
      }
    ]
  };
  store.stocktakes.unshift(record);

  const warehouses = new WarehousesService(store, {} as never);
  const stocktakeExport = warehouses.buildStocktakeExport(record.id);

  assert.doesNotMatch(stocktakeExport.body, /<img src=x/);
  assert.match(stocktakeExport.body, /&lt;img src=x/);
  assert.match(stocktakeExport.body, /&#39;=HYPERLINK/);
  assert.doesNotMatch(stocktakeExport.filename, /[\r\n/\\:*?]/);
});

test("公开申请更新必须绑定原手机号，不能用自己的验证码改写别人的申请", async () => {
  const store = createIsolatedStore();
  const region = store.regions[0];
  assert.ok(region);
  const application = {
    id: "application-victim",
    phone: "13800001001",
    requestedRole: "special" as const,
    profile: {
      name: "原申请人",
      regionId: region.id,
      regionName: region.name,
      neighborhood: region.name
    },
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.registrationApplications.unshift(application);
  let verificationCalls = 0;
  const service = new RegistrationApplicationsService(
    store,
    {
      verifyCode: async () => {
        verificationCalls += 1;
        return true;
      }
    } as never,
    { get: () => "false" } as never
  );

  await assert.rejects(
    service.updatePendingApplication(
      application.id,
      {
        phone: "13800001002",
        code: "123456",
        requestedRole: "merchant",
        profile: {
          name: "攻击者资料",
          regionId: region.id,
          regionName: region.name
        }
      },
      store.getDefaultTenantId()
    ),
    UnauthorizedException
  );

  assert.equal(verificationCalls, 0);
  assert.equal(application.phone, "13800001001");
  assert.equal(application.profile.name, "原申请人");
  assert.equal(application.requestedRole, "special");
});

test("补货员只能由后台创建，公开注册在消费验证码前拒绝伪造角色", async () => {
  const store = createIsolatedStore();
  const region = store.regions[0];
  assert.ok(region);
  let verificationCalls = 0;
  const service = new RegistrationApplicationsService(
    store,
    {
      verifyCode: async () => {
        verificationCalls += 1;
        return true;
      }
    } as never,
    { get: () => "false" } as never
  );
  const beforeApplications = structuredClone(store.registrationApplications);
  const beforeUsers = structuredClone(store.users);

  await assert.rejects(
    service.createOrUpdateByPhone(
      {
        phone: "13800001003",
        code: "123456",
        requestedRole: "restocker",
        profile: {
          name: "伪造补货员",
          regionId: region.id,
          regionName: region.name
        }
      },
      store.getDefaultTenantId()
    ),
    BadRequestException
  );

  assert.equal(verificationCalls, 0);
  assert.deepEqual(store.registrationApplications, beforeApplications);
  assert.deepEqual(store.users, beforeUsers);
});

test("公开手机号状态查询有来源限流，注册资料字段有长度边界", async () => {
  const store = createIsolatedStore();
  const region = store.regions[0];
  assert.ok(region);
  const service = new RegistrationApplicationsService(
    store,
    { verifyCode: async () => true } as never,
    { get: () => "false" } as never
  );
  const knownPhone = store.registrationApplications[0]?.phone;
  assert.ok(knownPhone);
  const tenantId = store.getDefaultTenantId();
  const knownPublicLookup = await service.lookupByPhone(
    knownPhone,
    undefined,
    "127.0.0.8",
    tenantId
  );
  const unknownPublicLookup = await service.lookupByPhone(
    "13988888888",
    undefined,
    "127.0.0.8",
    tenantId
  );
  assert.deepEqual(knownPublicLookup, { phone: knownPhone, state: "new" });
  assert.deepEqual(unknownPublicLookup, { phone: "13988888888", state: "new" });

  for (let index = 0; index < 30; index += 1) {
    await service.lookupByPhone(
      `1390000${String(index).padStart(4, "0")}`,
      undefined,
      "127.0.0.9",
      tenantId
    );
  }

  await assert.rejects(
    service.lookupByPhone(
      "13999999999",
      undefined,
      "127.0.0.9",
      tenantId
    ),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429
  );

  await assert.rejects(
    service.createOrUpdateByPhone(
      {
        phone: "13800001003",
        code: "123456",
        profile: {
          name: "名".repeat(101),
          regionId: region.id,
          regionName: region.name
        }
      },
      tenantId
    ),
    /姓名不能超过 100 个字符/
  );
});

test("远程开门统一拒绝无效条件，并接受任意长度的非空原因", async () => {
  const store = createIsolatedStore();
  const device = store.devices[0];
  const admin = store.users.find((entry) => entry.role === "admin");
  assert.ok(device);
  assert.ok(admin);
  device.status = "online";
  device.lastSeenAt = new Date().toISOString();
  let gatewayCalls = 0;
  const gateway = {
    async openDoor() {
      gatewayCalls += 1;
      return {
        orderNo: "mock-order-security",
        smartVmExchange: {
          direction: "outbound",
          occurredAt: new Date().toISOString(),
          method: "POST",
          path: "/mock/open",
          requestUrl: "mock://smartvm/open",
          requestBody: {},
          statusCode: 200,
          responseBody: {},
          ok: true,
          simulated: true
        }
      };
    },
    extractErrorMessage: () => "mock error",
    extractExchangeTrace: () => undefined
  };
  const service = new DevicesService(store, {} as never, gateway as never);

  await assert.rejects(
    service.remoteOpen(device.deviceCode, { reason: " \t\n " }, admin.id),
    /请填写远程开门原因/
  );
  assert.equal(gatewayCalls, 0);

  const originalStatus = device.status;
  device.status = "offline";
  await assert.rejects(
    service.remoteOpen(device.deviceCode, { reason: "现场维修复核" }, admin.id),
    /柜机当前离线，不能开门/
  );
  assert.equal(gatewayCalls, 0);
  device.status = originalStatus;

  store.updateDeviceRuntime(device.deviceCode, { doorState: "open" });
  await assert.rejects(
    service.remoteOpen(device.deviceCode, { reason: "现场维修复核" }, admin.id),
    /柜门当前已开启，不能重复开门/
  );
  assert.equal(gatewayCalls, 0);
  store.updateDeviceRuntime(device.deviceCode, { doorState: "closed" });

  await assert.rejects(
    service.remoteOpen(
      device.deviceCode,
      { doorNum: "1.5", reason: "现场维修复核" },
      admin.id
    ),
    /柜门编号必须为有效的正整数/
  );
  assert.equal(gatewayCalls, 0);

  const missingDoorNum = "999999";
  assert.equal(device.doors.some((door) => door.doorNum === missingDoorNum), false);
  await assert.rejects(
    service.remoteOpen(
      device.deviceCode,
      { doorNum: missingDoorNum, reason: "现场维修复核" },
      admin.id
    ),
    /该柜机不存在对应柜门/
  );
  assert.equal(gatewayCalls, 0);

  await service.remoteOpen(
    device.deviceCode,
    { doorNum: "1", reason: "  测试  " },
    admin.id
  );

  assert.equal(gatewayCalls, 1);
  const shortReasonLog = store.logs.find(
    (entry) => entry.type === "remote-open-device" && entry.metadata?.reason === "测试"
  );
  assert.ok(shortReasonLog);

  const longReasonStore = createIsolatedStore();
  const longReasonDevice = longReasonStore.devices[0];
  const longReasonAdmin = longReasonStore.users.find((entry) => entry.role === "admin");
  assert.ok(longReasonDevice);
  assert.ok(longReasonAdmin);
  longReasonDevice.status = "online";
  longReasonDevice.lastSeenAt = new Date().toISOString();
  const longReasonService = new DevicesService(
    longReasonStore,
    {} as never,
    gateway as never
  );
  const longReason = "现场排查说明".repeat(60);
  assert.ok(longReason.length > 200);
  await longReasonService.remoteOpen(
    longReasonDevice.deviceCode,
    { doorNum: "1", reason: longReason },
    longReasonAdmin.id
  );

  assert.equal(gatewayCalls, 2);
  assert.ok(
    longReasonStore.logs.some(
      (entry) => entry.type === "remote-open-device" && entry.metadata?.reason === longReason
    )
  );
});

test("系统审计统一入口脱敏签名、会话、手机号和 URL 查询参数", () => {
  const directory = createTemporaryDirectory("vm-system-audit-");
  const filePath = join(directory, "audit.ndjson");
  process.env.SYSTEM_LOG_FILE = filePath;
  const entry = {
    occurredAt: new Date().toISOString(),
    method: "POST",
    path: "/external/smartvm/open",
    statusCode: 200,
    durationMs: 1,
    body: {
      code: "123456",
      sign: "live-signature",
      token: "live-session-token",
      phone: "13812345678",
      nested: { clientId: "live-client-id", normal: "保留字段" }
    },
    metadata: {
      requestUrl: "https://example.invalid/open?sign=live-url-sign&phone=13812345678"
    },
    response: { code: 200 }
  } satisfies SystemAuditLogEntry;

  appendSystemAuditLog(entry);

  const serialized = readFileSync(filePath, "utf8");
  assert.doesNotMatch(serialized, /live-signature|live-session-token|live-client-id|live-url-sign/);
  assert.doesNotMatch(serialized, /13812345678/);
  assert.match(serialized, /138\*\*\*\*5678/);
  assert.match(serialized, /保留字段/);
  assert.match(serialized, /"code":200/);
  assert.doesNotMatch(serialized, /"code":"123456"/);

  appendFileSync(
    filePath,
    `${JSON.stringify({
      ...entry,
      body: { sign: "legacy-raw-sign", accessToken: "legacy-raw-token", phone: "13912345678" }
    })}\n`,
    "utf8"
  );
  const operationLogs = new OperationLogsService(createIsolatedStore(), {} as never);
  const exported = operationLogs.buildSystemAuditExport().body;
  const listed = JSON.stringify(operationLogs.listSystemAudit({ limit: 10 }));

  assert.doesNotMatch(exported, /legacy-raw-sign|legacy-raw-token|13912345678/);
  assert.doesNotMatch(listed, /legacy-raw-sign|legacy-raw-token|13912345678/);
  assert.match(exported, /139\*\*\*\*5678/);
});

test("上传只接受结构完整、尺寸合理的静态图片，且无配置时返回相对 URL", () => {
  const validPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const validGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const firstFrameOffset = validGif.indexOf(0x2c);
  const animatedGif = Buffer.concat([
    validGif.subarray(0, validGif.length - 1),
    validGif.subarray(firstFrameOffset, validGif.length - 1),
    Buffer.from([0x3b])
  ]);

  assert.equal(detectValidatedImageExtension(validPng), ".png");
  assert.equal(detectValidatedImageExtension(validGif), ".gif");
  assert.equal(detectValidatedImageExtension(animatedGif), undefined);
  assert.equal(
    detectValidatedImageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    undefined
  );

  const uploadDirectory = createTemporaryDirectory("vm-upload-");
  process.env.UPLOAD_DIR = uploadDirectory;
  const controller = new UploadsController({ get: () => undefined } as never);
  const response = controller.uploadImage({ buffer: validPng, originalname: "unsafe.svg" });

  assert.match(response.data.relativePath, /^\/uploads\/upload-[a-zA-Z0-9.-]+\.png$/);
  assert.equal(response.data.url, response.data.relativePath);
  assert.ok(existsSync(join(uploadDirectory, response.data.filename)));
});

test("反向代理默认不信任转发头，只接受明确的有限代理层数", () => {
  assert.equal(resolveTrustProxySetting(undefined), false);
  assert.equal(resolveTrustProxySetting(""), false);
  assert.equal(resolveTrustProxySetting("1"), 1);
  assert.equal(resolveTrustProxySetting("1", "127.0.0.1"), 1);
  assert.equal(resolveTrustProxySetting("1", "::1"), 1);
  assert.equal(resolveTrustProxySetting(undefined, "0.0.0.0"), false);
  assert.throws(() => resolveTrustProxySetting("0"), /1 至 10/);
  assert.throws(() => resolveTrustProxySetting("all"), /1 至 10/);
  assert.throws(
    () => resolveTrustProxySetting("1", "0.0.0.0"),
    /API_HOST 必须绑定回环地址/
  );
});

const createAuthHarness = () => {
  const store = createIsolatedStore();
  const service = new AuthService(
    {
      findByPhone: (phone: string) => store.users.find((entry) => entry.phone === phone),
      findById: (userId: string) => store.users.find((entry) => entry.id === userId)
    } as never,
    { getQuotaSummaryForUser: () => undefined } as never,
    { findLatestByPhone: () => undefined } as never,
    store,
    { requestCode: async () => undefined, verifyCode: async () => true } as never,
    { get: () => "true" } as never
  );

  return { store, service };
};

test("后台密码登录同时按账号和来源 IP 限制连续失败", async () => {
  const accountHarness = createAuthHarness();

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      accountHarness.service.backofficeLogin("missing-account", "wrong", "127.0.0.10"),
      UnauthorizedException
    );
  }

  await assert.rejects(
    accountHarness.service.backofficeLogin("missing-account", "wrong", "127.0.0.10"),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429
  );

  const ipHarness = createAuthHarness();

  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(
      ipHarness.service.adminPasswordLogin(`missing-${index}`, "wrong", "127.0.0.11"),
      UnauthorizedException
    );
  }

  await assert.rejects(
    ipHarness.service.adminPasswordLogin("missing-last", "wrong", "127.0.0.11"),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429
  );
});

test("普通管理员会话不能兼容升级成后台权限会话", () => {
  const { store, service } = createAuthHarness();
  const admin = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  assert.ok(admin);
  assert.ok(store.findBackofficeCredentialByUserId(admin.id, "admin") || store.findBackofficeCredentialByUserId(admin.id, "super_admin"));
  const ordinaryAdminToken = store.createSession(admin);

  assert.throws(() => service.getBackofficeSession(ordinaryAdminToken), UnauthorizedException);
});

test("认证会话和资料草稿只保存在进程内，旧快照中的 token 也不会恢复", () => {
  const store = createIsolatedStore();
  const admin = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  assert.ok(admin);

  const sessionToken = store.createSession(admin);
  const draftToken = store.createDraftSession({
    tenantId: store.getDefaultTenantId(),
    phone: "13812345678"
  });
  assert.ok(store.getSession(sessionToken));
  assert.ok(store.getDraftSession(draftToken));

  store.persist();
  const persistedText = readFileSync(process.env.API_DATA_FILE!, "utf8");
  const persistedState = JSON.parse(persistedText) as {
    sessions: unknown[];
    draftSessions: unknown[];
  };
  assert.deepEqual(persistedState.sessions, []);
  assert.deepEqual(persistedState.draftSessions, []);
  assert.doesNotMatch(persistedText, new RegExp(`${sessionToken}|${draftToken}`));

  const legacySessionToken = "session_legacy-token-that-must-not-revive";
  const legacyDraftToken = "draft_legacy-token-that-must-not-revive";
  const legacyState = store.snapshot();
  const now = Date.now();
  legacyState.sessions = [
    [
      legacySessionToken,
      {
        token: legacySessionToken,
        userId: admin.id,
        role: admin.role,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString()
      }
    ]
  ];
  legacyState.draftSessions = [
    [
      legacyDraftToken,
      {
        token: legacyDraftToken,
        phone: "13812345678",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString()
      }
    ]
  ];
  writeFileSync(process.env.API_DATA_FILE!, JSON.stringify(legacyState), "utf8");

  const restartedStore = new InMemoryStoreService();
  assert.equal(restartedStore.getSession(legacySessionToken), undefined);
  assert.equal(restartedStore.getDraftSession(legacyDraftToken), undefined);
  restartedStore.flushBootstrapPersistence();
  const cleanedLegacyText = readFileSync(process.env.API_DATA_FILE!, "utf8");
  assert.doesNotMatch(cleanedLegacyText, /legacy-token-that-must-not-revive/);

  assert.equal(store.revokeSession(sessionToken), true);
  assert.equal(store.getSession(sessionToken), undefined);
  assert.equal(store.revokeSession(sessionToken), false);
});

test("移动端 AI 状态隐藏上游配置，助手请求有长度和频率边界", async () => {
  const store = createIsolatedStore();
  let providerCalls = 0;
  const service = new AiInsightsService(
    store,
    {
      getStatus: () => ({
        enabled: true,
        provider: "openai-compatible",
        baseUrl: "https://private-gateway.invalid/v1",
        model: "private-model",
        missingConfig: ["PRIVATE_SETTING"],
        apiKeyConfigured: true,
        usingDefaultBaseUrl: false,
        usingDefaultModel: false
      }),
      completeJson: async () => {
        providerCalls += 1;
        return {
          model: "local-test-model",
          data: {
            answer: "本地测试回答",
            suggestedSteps: [],
            followUpQuestions: []
          }
        };
      }
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );

  const mobileStatus = service.status("special");
  assert.equal(mobileStatus.enabled, true);
  assert.equal(mobileStatus.baseUrl, "");
  assert.equal(mobileStatus.model, "");
  assert.deepEqual(mobileStatus.missingConfig, []);
  assert.equal(service.status("admin").baseUrl, "https://private-gateway.invalid/v1");

  await assert.rejects(
    service.supportAssistant({
      question: "问".repeat(1_001),
      role: "special",
      actorUserId: "special-ai-limit"
    }),
    /问题不能超过 1000 个字符/
  );
  assert.equal(providerCalls, 0);

  for (let index = 0; index < 10; index += 1) {
    await service.supportAssistant({
      question: `第 ${index + 1} 个本地测试问题`,
      role: "special",
      actorUserId: "special-ai-limit"
    });
  }

  assert.equal(providerCalls, 10);
  await assert.rejects(
    service.supportAssistant({
      question: "第 11 个本地测试问题",
      role: "special",
      actorUserId: "special-ai-limit"
    }),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429
  );
});
