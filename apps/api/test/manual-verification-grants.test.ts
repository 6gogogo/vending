import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "../src/app.module";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { listenOnFetchSafeLoopbackPort } from "./support/fetch-safe-api-listener";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP,
  VERIFICATION_CODE_PROVIDER: process.env.VERIFICATION_CODE_PROVIDER,
  VERIFICATION_CODE_PREVIEW_ENABLED:
    process.env.VERIFICATION_CODE_PREVIEW_ENABLED
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

const startApiWithDataFile = async (dataFile: string) => {
  process.env.API_DATA_FILE = dataFile;
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  process.env.VERIFICATION_CODE_PROVIDER = "mock";
  process.env.VERIFICATION_CODE_PREVIEW_ENABLED = "false";

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  app.setGlobalPrefix("api");
  const port = await listenOnFetchSafeLoopbackPort(app);

  return {
    app,
    baseUrl: `http://127.0.0.1:${port}/api`,
    dataFile,
    store: app.get(InMemoryStoreService)
  };
};

const startApi = async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-manual-verification-"));
  const dataFile = join(directory, "store.json");
  temporaryDirectories.push(directory);
  return startApiWithDataFile(dataFile);
};

const createTenantAdminToken = (store: InMemoryStoreService) => {
  const credential = store.backofficeCredentials.find(
    (entry) => entry.role === "admin"
  );
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  return store.createBackofficeSession(
    user,
    credential.role,
    credential.tenantId
  );
};

const createProviderToken = (store: InMemoryStoreService) => {
  const credential = store.backofficeCredentials.find(
    (entry) => entry.role === "super_admin"
  );
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  return store.createBackofficeSession(
    user,
    credential.role,
    credential.tenantId
  );
};

test("后台签发的 6 位人工码只用于绑定账号且单次消费，不落手机号或验证码明文", async () => {
  const { app, baseUrl, dataFile, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    };
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        role: "special",
        phone: "18800000901",
        name: "人工码测试账号"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string; tenantId?: string };
    };
    const targetUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(targetUserId);

    const issueResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: targetUserId,
          purpose: "app-login",
          code: "654321",
          expiresInSeconds: 300
        })
      }
    );
    const issuePayload = (await issueResponse.json()) as {
      data?: {
        id?: string;
        userId?: string;
        tenantId?: string;
        purpose?: string;
        status?: string;
        expiresAt?: string;
        codeLength?: number;
        code?: string;
        codeHash?: string;
        codeSalt?: string;
        phone?: string;
      };
    };

    assert.equal(issueResponse.status, 201);
    assert.ok(issuePayload.data?.id);
    assert.equal(issuePayload.data?.userId, targetUserId);
    assert.equal(issuePayload.data?.tenantId, createUserPayload.data?.tenantId);
    assert.equal(issuePayload.data?.purpose, "app-login");
    assert.equal(issuePayload.data?.status, "active");
    assert.equal(issuePayload.data?.codeLength, 6);
    assert.equal(issuePayload.data?.code, undefined);
    assert.equal(issuePayload.data?.codeHash, undefined);
    assert.equal(issuePayload.data?.codeSalt, undefined);
    assert.equal(issuePayload.data?.phone, undefined);

    const persistedBeforeUse = JSON.parse(
      readFileSync(dataFile, "utf8")
    ) as { verificationCodes?: unknown };
    const persistedVerificationCodes = JSON.stringify(
      persistedBeforeUse.verificationCodes
    );
    assert.equal(persistedVerificationCodes.includes("18800000901"), false);
    assert.equal(persistedVerificationCodes.includes("654321"), false);

    const wrongCodeResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000901",
        code: "111111"
      })
    });
    assert.equal(wrongCodeResponse.status, 401);

    const loginResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000901",
        code: "654321"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: { state?: string; phone?: string };
    };

    assert.equal(loginResponse.status, 201);
    assert.equal(loginPayload.data?.state, "not_registered");
    assert.equal(loginPayload.data?.phone, "18800000901");

    const replayResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000901",
        code: "654321"
      })
    });
    assert.equal(replayResponse.status, 401);

    const invalidCodeResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: targetUserId,
          purpose: "app-login",
          code: "12345"
        })
      }
    );
    const unknownUserResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: "missing-user",
          purpose: "app-login",
          code: "123456"
        })
      }
    );
    assert.equal(invalidCodeResponse.status, 400);
    assert.equal(unknownUserResponse.status, 404);

    const revocableIssueResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: targetUserId,
          purpose: "app-login",
          code: "123456",
          expiresInSeconds: 120
        })
      }
    );
    const revocableIssuePayload = (await revocableIssueResponse.json()) as {
      data?: { id?: string };
    };
    const revocableGrantId = revocableIssuePayload.data?.id;
    assert.equal(revocableIssueResponse.status, 201);
    assert.ok(revocableGrantId);

    const listResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        headers: adminHeaders
      }
    );
    const listPayload = (await listResponse.json()) as {
      data?: Array<{
        id?: string;
        status?: string;
        phone?: string;
        code?: string;
      }>;
    };
    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.data?.length, 2);
    assert.equal(
      listPayload.data?.find((entry) => entry.id === issuePayload.data?.id)
        ?.status,
      "consumed"
    );
    assert.equal(
      listPayload.data?.find((entry) => entry.id === revocableGrantId)?.status,
      "active"
    );
    assert.ok(
      listPayload.data?.every(
        (entry) => entry.phone === undefined && entry.code === undefined
      )
    );

    const revokeResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes/${encodeURIComponent(revocableGrantId)}/revoke`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          reason: "本地验收撤销测试"
        })
      }
    );
    const revokePayload = (await revokeResponse.json()) as {
      data?: { status?: string };
    };
    assert.equal(revokeResponse.status, 201);
    assert.equal(revokePayload.data?.status, "revoked");

    const revokedCodeResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000901",
        code: "123456"
      })
    });
    assert.equal(revokedCodeResponse.status, 401);

    const issueLog = store.logs.find(
      (entry) => entry.type === "issue-manual-verification-code"
    );
    assert.ok(issueLog);
    assert.equal(issueLog.primarySubject?.id, targetUserId);
    assert.equal(JSON.stringify(issueLog).includes("18800000901"), false);
    assert.equal(JSON.stringify(issueLog).includes("654321"), false);
    assert.ok(
      store.logs.some(
        (entry) => entry.type === "revoke-manual-verification-code"
      )
    );
    assert.ok(
      store.logs.some(
        (entry) =>
          entry.type === "consume-manual-verification-code" &&
          entry.metadata?.manualGrantId === issuePayload.data?.id
      )
    );

    const supersededIssueResponses = [];
    for (const code of ["777777", "888888"]) {
      supersededIssueResponses.push(
        await fetch(`${baseUrl}/auth/manual-verification-codes`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({
            userId: targetUserId,
            purpose: "app-login",
            code
          })
        })
      );
    }
    const supersededIssuePayloads = await Promise.all(
      supersededIssueResponses.map(
        async (response) =>
          (await response.json()) as { data?: { id?: string } }
      )
    );
    const supersededGrantId = supersededIssuePayloads[0]?.data?.id;
    const activeGrantId = supersededIssuePayloads[1]?.data?.id;
    assert.ok(supersededGrantId);
    assert.ok(activeGrantId);

    const historyResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      { headers: adminHeaders }
    );
    const historyPayload = (await historyResponse.json()) as {
      data?: Array<{ id?: string; status?: string }>;
    };
    assert.equal(
      historyPayload.data?.find((entry) => entry.id === supersededGrantId)
        ?.status,
      "superseded"
    );
    assert.equal(
      historyPayload.data?.find((entry) => entry.id === activeGrantId)?.status,
      "active"
    );
    assert.ok(
      store.logs.some(
        (entry) =>
          entry.type === "supersede-manual-verification-code" &&
          entry.metadata?.manualGrantId === supersededGrantId
      )
    );
  } finally {
    await app.close();
  }
});

test("后台创建补货员并分配柜机后，可用自定 6 位人工码直接进入移动作业入口", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    };
    const assignedDevice = store.devices[0];
    const unassignedDevice = store.devices[1];
    assert.ok(assignedDevice);
    assert.ok(unassignedDevice);

    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000908",
        name: "人工码移动端补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string; mobileProfileCompleted?: boolean };
    };
    const targetUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(targetUserId);
    assert.equal(createUserPayload.data?.mobileProfileCompleted, true);

    const assignmentResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(targetUserId)}/device-assignment`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          deviceCodes: [assignedDevice.deviceCode]
        })
      }
    );
    assert.equal(assignmentResponse.status, 200);

    const issueResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: targetUserId,
          purpose: "app-login",
          code: "638214",
          expiresInSeconds: 300
        })
      }
    );
    assert.equal(issueResponse.status, 201);

    const loginResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000908",
        code: "638214"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: {
        state?: string;
        token?: string;
        user?: { id?: string; role?: string };
      };
    };
    assert.equal(loginResponse.status, 201);
    assert.equal(loginPayload.data?.state, "approved");
    assert.equal(loginPayload.data?.user?.id, targetUserId);
    assert.equal(loginPayload.data?.user?.role, "restocker");
    assert.ok(loginPayload.data?.token);

    const devicesResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${loginPayload.data?.token}`
      }
    });
    const devicesPayload = (await devicesResponse.json()) as {
      data?: Array<{ deviceCode?: string }>;
    };
    assert.equal(devicesResponse.status, 200);
    assert.deepEqual(
      devicesPayload.data?.map((entry) => entry.deviceCode),
      [assignedDevice.deviceCode]
    );
    assert.equal(
      devicesPayload.data?.some(
        (entry) => entry.deviceCode === unassignedDevice.deviceCode
      ),
      false
    );

    const replayResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000908",
        code: "638214"
      })
    });
    assert.equal(replayResponse.status, 401);
  } finally {
    await app.close();
  }
});

test("人工码达到失败上限或过期后关闭，API 重启后仍可单次校验", async () => {
  let runningApi: Awaited<ReturnType<typeof startApiWithDataFile>> | undefined =
    await startApi();

  try {
    const adminToken = createTenantAdminToken(runningApi.store);
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    };
    const createUserResponse = await fetch(`${runningApi.baseUrl}/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        role: "special",
        phone: "18800000902",
        name: "人工码锁定测试账号"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    const targetUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(targetUserId);

    const issueCode = (code: string) =>
      fetch(`${runningApi!.baseUrl}/auth/manual-verification-codes`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: targetUserId,
          purpose: "app-login",
          code,
          expiresInSeconds: 300
        })
      });
    const tryLogin = (code: string) =>
      fetch(`${runningApi!.baseUrl}/auth/app-login`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone: "18800000902",
          code
        })
      });

    assert.equal((await issueCode("222222")).status, 201);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await tryLogin("000000")).status, 401);
    }
    assert.equal((await tryLogin("222222")).status, 401);

    const lockedListResponse = await fetch(
      `${runningApi.baseUrl}/auth/manual-verification-codes`,
      {
        headers: adminHeaders
      }
    );
    const lockedListPayload = (await lockedListResponse.json()) as {
      data?: Array<{ status?: string; failedAttempts?: number }>;
    };
    assert.equal(lockedListResponse.status, 200);
    assert.equal(lockedListPayload.data?.[0]?.status, "locked");
    assert.equal(lockedListPayload.data?.[0]?.failedAttempts, 5);

    assert.equal((await issueCode("333333")).status, 201);
    const expiringRecord = runningApi.store.manualVerificationGrants.find(
      (entry) =>
        entry.targetUserId === targetUserId &&
        entry.purpose === "app-login" &&
        !entry.consumedAt &&
        !entry.revokedAt &&
        !entry.lockedAt &&
        !entry.supersededAt
    );
    assert.ok(expiringRecord);
    expiringRecord.expiresAt = new Date(Date.now() - 1_000).toISOString();
    runningApi.store.persist();
    assert.equal((await tryLogin("333333")).status, 401);

    const expiredListResponse = await fetch(
      `${runningApi.baseUrl}/auth/manual-verification-codes`,
      {
        headers: adminHeaders
      }
    );
    const expiredListPayload = (await expiredListResponse.json()) as {
      data?: Array<{ status?: string }>;
    };
    assert.equal(expiredListPayload.data?.[0]?.status, "expired");

    assert.equal((await issueCode("444444")).status, 201);
    const dataFile = runningApi.dataFile;
    await runningApi.app.close();
    runningApi = undefined;
    runningApi = await startApiWithDataFile(dataFile);

    const restartedLoginResponse = await fetch(
      `${runningApi.baseUrl}/auth/app-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone: "18800000902",
          code: "444444"
        })
      }
    );
    const restartedLoginPayload = (await restartedLoginResponse.json()) as {
      data?: { state?: string };
    };
    assert.equal(restartedLoginResponse.status, 201);
    assert.equal(restartedLoginPayload.data?.state, "not_registered");

    const replayResponse = await fetch(
      `${runningApi.baseUrl}/auth/app-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone: "18800000902",
          code: "444444"
        })
      }
    );
    assert.equal(replayResponse.status, 401);

    const restartedAdminToken = createTenantAdminToken(runningApi.store);
    const historyResponse = await fetch(
      `${runningApi.baseUrl}/auth/manual-verification-codes`,
      {
        headers: {
          authorization: `Bearer ${restartedAdminToken}`
        }
      }
    );
    const historyPayload = (await historyResponse.json()) as {
      data?: Array<{ status?: string }>;
    };
    const historyStatuses = new Set(
      historyPayload.data?.map((entry) => entry.status)
    );
    assert.equal(historyResponse.status, 200);
    assert.equal(historyStatuses.has("locked"), true);
    assert.equal(historyStatuses.has("expired"), true);
    assert.equal(historyStatuses.has("consumed"), true);
    assert.ok(
      runningApi.store.logs.some(
        (entry) => entry.type === "lock-manual-verification-code"
      )
    );
  } finally {
    await runningApi?.app.close();
  }
});

test("人工码只能由当前实例管理员为本实例有效账号签发和撤销", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const defaultAdminToken = createTenantAdminToken(store);
    const providerToken = createProviderToken(store);
    const defaultTarget = store.users.find(
      (entry) =>
        store.getUserTenantId(entry) === store.getDefaultTenantId() &&
        entry.role === "merchant" &&
        entry.status === "active"
    );
    const merchantCredential = defaultTarget
      ? store.findBackofficeCredentialByUserId(defaultTarget.id, "merchant")
      : undefined;
    assert.ok(defaultTarget);
    assert.ok(merchantCredential);
    const merchantToken = store.createBackofficeSession(
      defaultTarget,
      merchantCredential.role,
      merchantCredential.tenantId
    );

    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "manual-code-tenant",
        name: "人工码隔离实例",
        instanceUrl: "https://manual-code-tenant.example.test",
        firstAdmin: {
          name: "人工码隔离首管理员",
          phone: "18800000903",
          username: "manual-code-tenant-admin",
          password: "manual-code-tenant-password"
        }
      })
    });
    const createTenantPayload = (await createTenantResponse.json()) as {
      data?: {
        tenant?: { id?: string };
        firstAdmin?: { userId?: string };
      };
    };
    const tenantId = createTenantPayload.data?.tenant?.id;
    const tenantAdminUserId = createTenantPayload.data?.firstAdmin?.userId;
    assert.equal(createTenantResponse.status, 201);
    assert.ok(tenantId);
    assert.ok(tenantAdminUserId);

    const loginTenantAdminResponse = await fetch(
      `${baseUrl}/auth/backoffice-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: "manual-code-tenant-admin",
          password: "manual-code-tenant-password"
        })
      }
    );
    const loginTenantAdminPayload = (await loginTenantAdminResponse.json()) as {
      data?: { token?: string };
    };
    const tenantAdminToken = loginTenantAdminPayload.data?.token;
    assert.equal(loginTenantAdminResponse.status, 201);
    assert.ok(tenantAdminToken);

    const issue = (
      token: string,
      userId: string,
      code: string
    ) =>
      fetch(`${baseUrl}/auth/manual-verification-codes`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          userId,
          purpose: "app-login",
          code
        })
      });

    assert.equal(
      (await issue(providerToken, defaultTarget.id, "111111")).status,
      403
    );
    assert.equal(
      (await issue(merchantToken, defaultTarget.id, "222222")).status,
      403
    );
    assert.equal(
      (await issue(defaultAdminToken, tenantAdminUserId, "333333")).status,
      404
    );
    assert.equal(
      (await issue(tenantAdminToken, defaultTarget.id, "444444")).status,
      404
    );

    const ownTenantIssueResponse = await issue(
      tenantAdminToken,
      tenantAdminUserId,
      "555555"
    );
    const ownTenantIssuePayload = (await ownTenantIssueResponse.json()) as {
      data?: { id?: string; tenantId?: string };
    };
    const grantId = ownTenantIssuePayload.data?.id;
    assert.equal(ownTenantIssueResponse.status, 201);
    assert.ok(grantId);
    assert.equal(ownTenantIssuePayload.data?.tenantId, tenantId);

    const defaultListResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        headers: {
          authorization: `Bearer ${defaultAdminToken}`
        }
      }
    );
    const defaultListPayload = (await defaultListResponse.json()) as {
      data?: unknown[];
    };
    const tenantListResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        headers: {
          authorization: `Bearer ${tenantAdminToken}`
        }
      }
    );
    const tenantListPayload = (await tenantListResponse.json()) as {
      data?: Array<{ id?: string; tenantId?: string }>;
    };

    assert.deepEqual(defaultListPayload.data, []);
    assert.deepEqual(tenantListPayload.data, [
      {
        ...tenantListPayload.data?.[0],
        id: grantId,
        tenantId
      }
    ]);

    const crossTenantRevokeResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes/${encodeURIComponent(grantId)}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${defaultAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          reason: "不应允许跨实例撤销"
        })
      }
    );
    assert.equal(crossTenantRevokeResponse.status, 404);
  } finally {
    await app.close();
  }
});

test("人工码按用途隔离且不改变系统验证码提供商模式", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const merchant = store.users.find(
      (entry) =>
        entry.role === "merchant" &&
        entry.status === "active" &&
        store.getUserTenantId(entry) === store.getDefaultTenantId()
    );
    const merchantCredential = merchant
      ? store.findBackofficeCredentialByUserId(merchant.id, "merchant")
      : undefined;
    assert.ok(merchant);
    assert.ok(merchantCredential);

    const issueResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          userId: merchant.id,
          purpose: "password-reset",
          code: "666666"
        })
      }
    );
    assert.equal(issueResponse.status, 201);

    const wrongPurposeResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: merchant.phone,
        code: "666666"
      })
    });
    assert.equal(wrongPurposeResponse.status, 401);

    const resetResponse = await fetch(
      `${baseUrl}/auth/backoffice-password-reset`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: merchantCredential.username,
          phone: merchant.phone,
          code: "666666",
          newPassword: "manual-reset-password"
        })
      }
    );
    assert.equal(resetResponse.status, 201);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: merchantCredential.username,
        password: "manual-reset-password"
      })
    });
    assert.equal(loginResponse.status, 201);

    const replayResetResponse = await fetch(
      `${baseUrl}/auth/backoffice-password-reset`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: merchantCredential.username,
          phone: merchant.phone,
          code: "666666",
          newPassword: "manual-reset-replay-password"
        })
      }
    );
    assert.equal(replayResetResponse.status, 401);

    const publicConfigResponse = await fetch(`${baseUrl}/public-config`);
    const publicConfigPayload = (await publicConfigResponse.json()) as {
      data?: {
        verificationProvider?: string;
        verificationPreviewEnabled?: boolean;
      };
    };
    assert.equal(publicConfigResponse.status, 200);
    assert.equal(publicConfigPayload.data?.verificationProvider, "mock");
    assert.equal(
      publicConfigPayload.data?.verificationPreviewEnabled,
      false
    );
  } finally {
    await app.close();
  }
});

test("同一人工码并发提交时只有一次能够消费", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createTenantAdminToken(store);
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    };
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        role: "special",
        phone: "18800000904",
        name: "人工码并发测试账号"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    assert.equal(createUserResponse.status, 201);
    assert.ok(createUserPayload.data?.id);

    const issueResponse = await fetch(
      `${baseUrl}/auth/manual-verification-codes`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          userId: createUserPayload.data.id,
          purpose: "app-login",
          code: "777777"
        })
      }
    );
    assert.equal(issueResponse.status, 201);

    const attempts = await Promise.all(
      [0, 1].map(() =>
        fetch(`${baseUrl}/auth/app-login`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            phone: "18800000904",
            code: "777777"
          })
        })
      )
    );

    assert.deepEqual(
      attempts.map((response) => response.status).sort(),
      [201, 401]
    );
  } finally {
    await app.close();
  }
});
