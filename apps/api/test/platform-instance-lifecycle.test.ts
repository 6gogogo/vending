import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "../src/app.module";
import { createSeededPersistedState } from "../src/common/store/persistence";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { UsersService } from "../src/modules/users/users.service";
import { listenOnFetchSafeLoopbackPort } from "./support/fetch-safe-api-listener";

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

const startApiWithDataFile = async (dataFile: string) => {
  process.env.API_DATA_FILE = dataFile;
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error"]
  });
  app.setGlobalPrefix("api");
  // 与公网单层反向代理一致：仅在受信代理后使用 X-Forwarded-Host 还原实例域名。
  app.set("trust proxy", 1);
  const port = await listenOnFetchSafeLoopbackPort(app);

  return {
    app,
    baseUrl: `http://127.0.0.1:${port}/api`,
    store: app.get(InMemoryStoreService),
    dataFile
  };
};

const startApi = async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-platform-instance-"));
  temporaryDirectories.push(directory);
  return startApiWithDataFile(join(directory, "store.json"));
};

test("旧模拟快照会在 App 登录前修复默认实例的公网 Host 绑定", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-legacy-public-app-login-"));
  temporaryDirectories.push(directory);
  const dataFile = join(directory, "store.json");
  const state = createSeededPersistedState();
  const defaultTenant = state.platformTenants[0];
  assert.ok(defaultTenant);
  delete (defaultTenant as Partial<typeof defaultTenant>).serviceMode;
  defaultTenant.instanceUrl = "https://legacy-public.example.test";
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const { app, baseUrl, store } = await startApiWithDataFile(dataFile);

  try {
    const phone = "18800000999";
    const code = store.issueVerificationCode(phone, "app-login");
    const response = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "x-forwarded-host": "vending.5gogogo.top",
        "content-type": "application/json"
      },
      body: JSON.stringify({ phone, code })
    });
    const payload = (await response.json()) as { data?: { state?: string } };

    assert.equal(response.status, 201);
    assert.equal(payload.data?.state, "not_registered");
    assert.equal(
      store.platformTenants[0]?.instanceUrl,
      "https://vending.5gogogo.top"
    );
    assert.equal(store.platformTenants[0]?.serviceMode, "simulation");
  } finally {
    await app.close();
  }
});

const createProviderToken = (store: InMemoryStoreService) => {
  const credential = store.backofficeCredentials.find((entry) => entry.role === "super_admin");
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  return store.createBackofficeSession(user, credential.role, credential.tenantId);
};

const createDefaultAdminToken = (store: InMemoryStoreService) => {
  const defaultTenantId = store.getDefaultTenantId();
  const credential = store.backofficeCredentials.find(
    (entry) => entry.role === "admin" && entry.tenantId === defaultTenantId
  );
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  return store.createBackofficeSession(user, credential.role, credential.tenantId);
};

test("实例管理员侧不存在向上认领服务商账号的接口", async () => {
  const { app, baseUrl } = await startApi();

  try {
    const response = await fetch(`${baseUrl}/auth/claim-initial-provider-account`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        currentAdminPassword: "irrelevant",
        username: "forbidden-provider",
        newPassword: "irrelevant-password"
      })
    });

    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

test("实例管理员不能通过人员标签或批量导入改写服务商根账号", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const adminToken = createDefaultAdminToken(store);
    const providerToken = createProviderToken(store);
    const providerCredential = store.backofficeCredentials.find(
      (entry) => entry.role === "super_admin"
    );
    const providerUser = store.users.find(
      (entry) => entry.id === providerCredential?.userId
    );
    const adminCredential = store.backofficeCredentials.find(
      (entry) =>
        entry.role === "admin" &&
        entry.tenantId === store.getDefaultTenantId()
    );
    const adminUser = store.users.find(
      (entry) => entry.id === adminCredential?.userId
    );
    assert.ok(providerCredential);
    assert.ok(providerUser);
    assert.ok(adminCredential);
    assert.ok(adminUser);
    const providerBefore = structuredClone(providerUser);
    const providerCredentialBefore = structuredClone(providerCredential);
    const userCountBefore = store.users.length;
    const providerImportResponse = await fetch(`${baseUrl}/users/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "merchant",
        entries: [
          {
            phone: providerUser.phone,
            name: "不得覆盖服务商根账号"
          }
        ]
      })
    });
    const unknownFieldImportResponse = await fetch(
      `${baseUrl}/users/import`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          role: "special",
          entries: [
            {
              phone: "18800000097",
              name: "非法归属字段",
              tenantId: "forged-tenant"
            }
          ]
        })
      }
    );
    const updateResponse = await fetch(`${baseUrl}/users/${adminUser.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        tags: ["运营", "super-admin", "hidden-backoffice"]
      })
    });
    store.upsertBackofficeCredential({
      ...adminCredential,
      username: "historical-provider-admin",
      role: "super_admin",
      tenantId: undefined
    });
    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "historical-provider-admin",
        password: "admin"
      })
    });

    assert.equal(providerImportResponse.status, 400);
    assert.equal(unknownFieldImportResponse.status, 400);
    assert.equal(updateResponse.status, 400);
    assert.equal(loginResponse.status, 401);
    assert.deepEqual(providerUser, providerBefore);
    assert.deepEqual(providerCredential, providerCredentialBefore);
    assert.ok(store.getBackofficeSessionUser(providerToken));
    assert.equal(store.users.length, userCountBefore);
    assert.equal(adminUser.tags.includes("super-admin"), false);
    assert.equal(adminUser.tags.includes("hidden-backoffice"), false);
  } finally {
    await app.close();
  }
});

test("服务商原子创建客户实例及首管理员且响应不返回密码", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const token = createProviderToken(store);
    const before = {
      tenants: store.platformTenants.length,
      users: store.users.length,
      credentials: store.backofficeCredentials.length
    };
    const createActiveProductionResponse = await fetch(
      `${baseUrl}/platform/tenants`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          code: "tenant-active-before-live",
          name: "未通过生产门禁的正式实例",
          serviceMode: "production",
          status: "active",
          firstAdmin: {
            name: "未创建的首位管理员",
            phone: "18800000024",
            username: "tenant-active-before-live-admin",
            password: "tenant-active-before-live-password"
          }
        })
      }
    );
    assert.equal(createActiveProductionResponse.status, 409);
    assert.deepEqual(
      {
        tenants: store.platformTenants.length,
        users: store.users.length,
        credentials: store.backofficeCredentials.length
      },
      before
    );

    const response = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-b",
        name: "新客户实例",
        serviceMode: "production",
        status: "trial",
        instanceUrl: "https://tenant-b.example.test",
        contactName: "实例联系人",
        contactPhone: "18800000001",
        planName: "试运行",
        firstAdmin: {
          name: "首位实例管理员",
          phone: "18800000002",
          username: "tenant-b-admin",
          password: "tenant-b-password"
        }
      })
    });
    const payload = (await response.json()) as {
      code?: number;
      data?: {
        tenant?: { id?: string; code?: string; serviceMode?: string };
        firstAdmin?: {
          userId?: string;
          username?: string;
          tenantId?: string;
          password?: string;
          passwordHash?: string;
          passwordSalt?: string;
        };
      };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.code, 200);
    assert.equal(payload.data?.tenant?.code, "tenant-b");
    assert.equal(payload.data?.tenant?.serviceMode, "production");
    assert.equal(payload.data?.firstAdmin?.username, "tenant-b-admin");
    assert.equal(payload.data?.firstAdmin?.tenantId, payload.data?.tenant?.id);
    assert.equal(payload.data?.firstAdmin?.password, undefined);
    assert.equal(payload.data?.firstAdmin?.passwordHash, undefined);
    assert.equal(payload.data?.firstAdmin?.passwordSalt, undefined);
    assert.equal(store.platformTenants.length, before.tenants + 1);
    assert.equal(store.platformTenants.at(-1)?.serviceMode, "production");
    assert.equal(store.users.length, before.users + 1);
    assert.equal(store.backofficeCredentials.length, before.credentials + 1);

    const activateBeforeLiveResponse = await fetch(
      `${baseUrl}/platform/tenants/${encodeURIComponent(payload.data?.tenant?.id ?? "")}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "新客户实例",
          status: "active",
          instanceUrl: "https://tenant-b.example.test",
          contactName: "实例联系人",
          contactPhone: "18800000001",
          planName: "正式服务"
        })
      }
    );
    assert.equal(activateBeforeLiveResponse.status, 409);
    assert.equal(store.platformTenants.at(-1)?.status, "trial");

    const enterBeforeLiveResponse = await fetch(
      `${baseUrl}/platform/tenants/${encodeURIComponent(payload.data?.tenant?.id ?? "")}/enter`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`
        }
      }
    );
    assert.equal(enterBeforeLiveResponse.status, 409);
    assert.ok(store.getBackofficeSessionUser(token));

    const credential = store.backofficeCredentials.find(
      (entry) => entry.username === "tenant-b-admin"
    );
    assert.equal(credential?.tenantId, payload.data?.tenant?.id);
    const firstAdmin = store.users.find((entry) => entry.id === credential?.userId);
    assert.ok(firstAdmin);

    const directLoginBeforeLiveResponse = await fetch(
      `${baseUrl}/auth/backoffice-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: "tenant-b-admin",
          password: "tenant-b-password"
        })
      }
    );
    assert.equal(directLoginBeforeLiveResponse.status, 409);

    const staleTenantToken = store.createBackofficeSession(
      firstAdmin,
      "admin",
      payload.data?.tenant?.id
    );
    const staleSessionResponse = await fetch(
      `${baseUrl}/auth/backoffice-session`,
      {
        headers: {
          authorization: `Bearer ${staleTenantToken}`
        }
      }
    );
    assert.equal(staleSessionResponse.status, 401);
    assert.equal(store.sessions.has(staleTenantToken), false);

    const publicAppBeforeLiveResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "x-forwarded-host": "tenant-b.example.test",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: "18800000002",
        code: "123456"
      })
    });
    assert.equal(publicAppBeforeLiveResponse.status, 404);

    const afterProvisioning = {
      tenants: store.platformTenants.length,
      users: store.users.length,
      credentials: store.backofficeCredentials.length
    };
    const duplicateHostnameResponse = await fetch(
      `${baseUrl}/platform/tenants`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          code: "tenant-b-alias",
          name: "重复域名实例",
          instanceUrl: "https://tenant-b.example.test/alternate",
          firstAdmin: {
            name: "重复域名管理员",
            phone: "18800000023",
            username: "tenant-b-alias-admin",
            password: "tenant-b-alias-password"
          }
        })
      }
    );
    assert.equal(duplicateHostnameResponse.status, 409);
    assert.deepEqual(
      {
        tenants: store.platformTenants.length,
        users: store.users.length,
        credentials: store.backofficeCredentials.length
      },
      afterProvisioning
    );
  } finally {
    await app.close();
  }
});

test("多实例歧义人员会被隔离，不会拖垮服务商总览或正常实例人员页", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const adminToken = createDefaultAdminToken(store);
    const defaultTenant = store.platformTenants[0];
    assert.ok(defaultTenant);
    store.platformTenants.push({
      ...defaultTenant,
      id: "tenant-quarantine-target",
      code: "tenant-quarantine-target",
      name: "歧义隔离测试实例",
      instanceUrl: "https://tenant-quarantine-target.example.test"
    });
    store.users.push({
      id: "ambiguous-quarantined-user",
      role: "merchant",
      phone: "18800000096",
      name: "缺失归属隔离人员",
      status: "active",
      tags: [],
      mobileProfileCompleted: true
    });

    const overviewResponse = await fetch(`${baseUrl}/platform/overview`, {
      headers: {
        authorization: `Bearer ${providerToken}`
      }
    });
    const usersResponse = await fetch(`${baseUrl}/users`, {
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    const usersPayload = (await usersResponse.json()) as {
      data?: Array<{ id?: string }>;
    };

    assert.equal(overviewResponse.status, 200);
    assert.equal(usersResponse.status, 200);
    assert.equal(
      usersPayload.data?.some(
        (entry) => entry.id === "ambiguous-quarantined-user"
      ),
      false
    );
  } finally {
    await app.close();
  }
});

test("每个客户实例始终保留至少一名启用的实例管理员", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-admin-continuity",
        name: "管理员连续性实例",
        firstAdmin: {
          name: "连续性首管理员",
          phone: "18800000031",
          username: "tenant-admin-continuity-owner",
          password: "tenant-admin-continuity-password"
        }
      })
    });
    const createPayload = (await createResponse.json()) as {
      data?: {
        tenant?: { id?: string };
        firstAdmin?: { userId?: string };
      };
    };
    const tenantId = createPayload.data?.tenant?.id;
    const firstAdminUserId = createPayload.data?.firstAdmin?.userId;
    assert.equal(createResponse.status, 201);
    assert.ok(tenantId);
    assert.ok(firstAdminUserId);

    const firstAdminCredential = store.findBackofficeCredentialByUserId(
      firstAdminUserId,
      "admin"
    );
    assert.ok(firstAdminCredential);
    const moveCredentialResponse = await fetch(`${baseUrl}/auth/backoffice-credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        userId: firstAdminUserId,
        username: firstAdminCredential.username,
        role: "admin",
        tenantId: store.getDefaultTenantId()
      })
    });
    assert.equal(moveCredentialResponse.status, 403);
    assert.equal(firstAdminCredential.tenantId, tenantId);

    const enterResponse = await fetch(`${baseUrl}/platform/tenants/${tenantId}/enter`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`
      }
    });
    const enterPayload = (await enterResponse.json()) as {
      data?: { token?: string };
    };
    const tenantProviderToken = enterPayload.data?.token;
    assert.equal(enterResponse.status, 201);
    assert.ok(tenantProviderToken);

    const placeholderAdminResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenantProviderToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "admin",
        phone: "18800000032",
        name: "无后台凭据的占位管理员"
      })
    });
    assert.equal(placeholderAdminResponse.status, 201);

    const request = (method: "PATCH" | "DELETE", body?: Record<string, unknown>) =>
      fetch(`${baseUrl}/users/${firstAdminUserId}`, {
        method,
        headers: {
          authorization: `Bearer ${tenantProviderToken}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });

    const deactivateResponse = await request("PATCH", { status: "inactive" });
    const demoteResponse = await request("PATCH", { role: "merchant" });
    const deleteResponse = await request("DELETE");

    assert.equal(deactivateResponse.status, 400);
    assert.equal(demoteResponse.status, 400);
    assert.equal(deleteResponse.status, 400);
    const firstAdmin = store.users.find((entry) => entry.id === firstAdminUserId);
    assert.equal(firstAdmin?.role, "admin");
    assert.equal(firstAdmin?.status, "active");
  } finally {
    await app.close();
  }
});

test("撤销人员角色变更不能让实例失去可登录管理员", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const tenantId = store.getDefaultTenantId();
    const enterResponse = await fetch(`${baseUrl}/platform/tenants/${tenantId}/enter`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`
      }
    });
    const enterPayload = (await enterResponse.json()) as {
      data?: { token?: string };
    };
    const tenantProviderToken = enterPayload.data?.token;
    assert.equal(enterResponse.status, 201);
    assert.ok(tenantProviderToken);

    const headers = {
      authorization: `Bearer ${tenantProviderToken}`,
      "content-type": "application/json"
    };
    const originalAdmin = store.users.find(
      (entry) =>
        entry.role === "admin" &&
        entry.status === "active" &&
        !store.isHiddenBackofficeUser(entry) &&
        store.findBackofficeCredentialByUserId(entry.id, "admin")?.tenantId === tenantId
    );
    assert.ok(originalAdmin);

    const createResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: "merchant",
        phone: "18800000033",
        name: "撤销守卫候选管理员"
      })
    });
    const createPayload = (await createResponse.json()) as {
      data?: { id?: string };
    };
    const candidateUserId = createPayload.data?.id;
    assert.equal(createResponse.status, 201);
    assert.ok(candidateUserId);

    const promoteResponse = await fetch(`${baseUrl}/users/${candidateUserId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "admin" })
    });
    assert.equal(promoteResponse.status, 200);
    const promoteLog = store.logs.find(
      (entry) =>
        entry.type === "update-user" &&
        entry.primarySubject?.type === "user" &&
        entry.primarySubject.id === candidateUserId
    );
    assert.ok(promoteLog);

    const credentialResponse = await fetch(`${baseUrl}/auth/backoffice-credentials`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: candidateUserId,
        username: "undo-continuity-admin",
        password: "undo-continuity-password",
        role: "admin",
        tenantId
      })
    });
    assert.equal(credentialResponse.status, 201);

    const deactivateResponse = await fetch(`${baseUrl}/users/${originalAdmin.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "inactive" })
    });
    assert.equal(deactivateResponse.status, 200);

    const undoResponse = await fetch(
      `${baseUrl}/operation-logs/${encodeURIComponent(promoteLog.id)}/undo`,
      {
        method: "POST",
        headers
      }
    );
    assert.equal(undoResponse.status, 400);
    assert.equal(
      store.users.find((entry) => entry.id === candidateUserId)?.role,
      "admin"
    );
    assert.equal(
      store.users.find((entry) => entry.id === originalAdmin.id)?.status,
      "inactive"
    );
  } finally {
    await app.close();
  }
});

test("实例创建持久化失败时租户、首管理员、凭据和日志全部回滚", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const token = createProviderToken(store);
    const before = {
      tenants: structuredClone(store.platformTenants),
      users: structuredClone(store.users),
      credentials: structuredClone(store.backofficeCredentials),
      logs: structuredClone(store.logs)
    };
    const originalPersist = store.persist.bind(store);
    store.persist = () => {
      throw new Error("injected persistence failure");
    };

    const response = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-rollback",
        name: "回滚验证实例",
        instanceUrl: "https://tenant-rollback.example.test",
        firstAdmin: {
          name: "回滚验证管理员",
          phone: "18800000003",
          username: "tenant-rollback-admin",
          password: "tenant-rollback-password"
        }
      })
    });

    store.persist = originalPersist;

    assert.equal(response.status, 500);
    assert.deepEqual(store.platformTenants, before.tenants);
    assert.deepEqual(store.users, before.users);
    assert.deepEqual(store.backofficeCredentials, before.credentials);
    assert.deepEqual(store.logs, before.logs);
  } finally {
    await app.close();
  }
});

test("服务商可维护模拟客户实例资料和状态，普通实例管理员不能修改", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const tenant = store.platformTenants[0];
    assert.ok(tenant);

    const response = await fetch(
      `${baseUrl}/platform/tenants/${encodeURIComponent(tenant.id)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${providerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "已维护客户实例",
          status: "paused",
          instanceUrl: "https://managed-tenant.example.test",
          contactName: "实例负责人",
          contactPhone: "18800000011",
          planName: "标准服务"
        })
      }
    );
    const payload = (await response.json()) as {
      code?: number;
      data?: { name?: string; status?: string; instanceUrl?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.code, 200);
    assert.equal(payload.data?.name, "已维护客户实例");
    assert.equal(payload.data?.status, "paused");
    assert.equal(payload.data?.instanceUrl, "https://managed-tenant.example.test");
    assert.equal(store.platformTenants[0]?.status, "paused");
    assert.ok(
      store.logs.some(
        (entry) =>
          entry.type === "update-platform-tenant" &&
          entry.metadata?.tenantId === tenant.id &&
          entry.metadata?.status === "paused"
      )
    );

    const defaultAdminToken = createDefaultAdminToken(store);
    const forbiddenResponse = await fetch(
      `${baseUrl}/platform/tenants/${encodeURIComponent(tenant.id)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${defaultAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "不应修改",
          status: "active"
        })
      }
    );
    assert.equal(forbiddenResponse.status, 403);
    assert.equal(store.platformTenants[0]?.name, "已维护客户实例");
  } finally {
    await app.close();
  }
});

test("服务商平台会话只能访问平台能力，未进入实例时不能读取业务数据", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const token = createProviderToken(store);
    const sessionResponse = await fetch(`${baseUrl}/auth/backoffice-session`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    const sessionPayload = (await sessionResponse.json()) as {
      data?: {
        user?: {
          scope?: string;
          tenantId?: string;
          tenantServiceMode?: string;
          permissions?: string[];
        };
      };
    };

    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionPayload.data?.user?.scope, "provider");
    assert.equal(sessionPayload.data?.user?.tenantId, undefined);
    assert.deepEqual(sessionPayload.data?.user?.permissions, [
      "platform-overview:view",
      "platform-tenants:view",
      "platform-tenants:manage",
      "system-audit:view",
      "system-audit:export"
    ]);

    const devicesResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    const overviewResponse = await fetch(`${baseUrl}/platform/overview`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    const overviewPayload = (await overviewResponse.json()) as {
      data?: { provisioningMode?: string };
    };

    assert.equal(devicesResponse.status, 403);
    assert.equal(overviewResponse.status, 200);
    assert.equal(overviewPayload.data?.provisioningMode, "online");
  } finally {
    await app.close();
  }
});

test("全局系统审计只允许服务商平台会话读取和导出", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const tenantAdminToken = createDefaultAdminToken(store);
    const request = (path: string, token: string) =>
      fetch(`${baseUrl}${path}`, {
        headers: {
          authorization: `Bearer ${token}`
        }
      });

    const tenantListResponse = await request(
      "/operation-logs/system-audit",
      tenantAdminToken
    );
    const tenantExportResponse = await request(
      "/operation-logs/export/system-file",
      tenantAdminToken
    );
    const providerListResponse = await request(
      "/operation-logs/system-audit",
      providerToken
    );
    const providerExportResponse = await request(
      "/operation-logs/export/system-file",
      providerToken
    );

    assert.equal(tenantListResponse.status, 403);
    assert.equal(tenantExportResponse.status, 403);
    assert.equal(providerListResponse.status, 200);
    assert.equal(providerExportResponse.status, 200);
  } finally {
    await app.close();
  }
});

test("服务商进入和退出当前实例时切换互斥会话作用域并撤销旧 token", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const tenantId = store.getDefaultTenantId();
    const enterResponse = await fetch(
      `${baseUrl}/platform/tenants/${encodeURIComponent(tenantId)}/enter`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${providerToken}`
        }
      }
    );
    const enterPayload = (await enterResponse.json()) as {
      data?: {
        token?: string;
        user?: {
          scope?: string;
          tenantId?: string;
          tenantServiceMode?: string;
          permissions?: string[];
        };
      };
    };
    const tenantToken = enterPayload.data?.token;

    assert.equal(enterResponse.status, 201);
    assert.ok(tenantToken);
    assert.notEqual(tenantToken, providerToken);
    assert.equal(enterPayload.data?.user?.scope, "tenant");
    assert.equal(enterPayload.data?.user?.tenantId, tenantId);
    assert.equal(enterPayload.data?.user?.tenantServiceMode, "simulation");
    assert.equal(enterPayload.data?.user?.permissions?.includes("devices:view"), true);
    assert.equal(
      enterPayload.data?.user?.permissions?.includes("platform-overview:view"),
      false
    );
    assert.equal(store.sessions.has(providerToken), false);

    const tenantDevicesResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${tenantToken}`
      }
    });
    const tenantPlatformResponse = await fetch(`${baseUrl}/platform/overview`, {
      headers: {
        authorization: `Bearer ${tenantToken}`
      }
    });

    assert.equal(tenantDevicesResponse.status, 200);
    assert.equal(tenantPlatformResponse.status, 403);

    const exitResponse = await fetch(`${baseUrl}/platform/exit-instance`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenantToken}`
      }
    });
    const exitPayload = (await exitResponse.json()) as {
      data?: {
        token?: string;
        user?: {
          scope?: string;
          tenantId?: string;
          tenantServiceMode?: string;
          permissions?: string[];
        };
      };
    };
    const nextProviderToken = exitPayload.data?.token;

    assert.equal(exitResponse.status, 201);
    assert.ok(nextProviderToken);
    assert.equal(exitPayload.data?.user?.scope, "provider");
    assert.equal(exitPayload.data?.user?.tenantId, undefined);
    assert.equal(exitPayload.data?.user?.tenantServiceMode, undefined);
    assert.deepEqual(exitPayload.data?.user?.permissions, [
      "platform-overview:view",
      "platform-tenants:view",
      "platform-tenants:manage",
      "system-audit:view",
      "system-audit:export"
    ]);
    assert.equal(store.sessions.has(tenantToken), false);

    const providerPlatformResponse = await fetch(`${baseUrl}/platform/overview`, {
      headers: {
        authorization: `Bearer ${nextProviderToken}`
      }
    });
    const providerDevicesResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${nextProviderToken}`
      }
    });

    assert.equal(providerPlatformResponse.status, 200);
    assert.equal(providerDevicesResponse.status, 403);
  } finally {
    await app.close();
  }
});

test("服务商进入新实例后只获得隔离启动权限且看不到默认实例数据", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-isolated",
        name: "隔离启动实例",
        instanceUrl: "https://tenant-isolated.example.test",
        firstAdmin: {
          name: "隔离实例首管理员",
          phone: "18800000004",
          username: "tenant-isolated-admin",
          password: "tenant-isolated-password"
        }
      })
    });
    const createPayload = (await createResponse.json()) as {
      data?: {
        tenant?: { id?: string };
        firstAdmin?: { userId?: string };
      };
    };
    const tenantId = createPayload.data?.tenant?.id;
    const firstAdminUserId = createPayload.data?.firstAdmin?.userId;
    const defaultMerchant = store.users.find(
      (entry) =>
        store.getUserTenantId(entry) === store.getDefaultTenantId() &&
        entry.role === "merchant" &&
        entry.status === "active"
    );
    const defaultMerchantCredential = defaultMerchant
      ? store.findBackofficeCredentialByUserId(defaultMerchant.id, "merchant")
      : undefined;
    assert.equal(createResponse.status, 201);
    assert.ok(tenantId);
    assert.ok(firstAdminUserId);
    assert.ok(defaultMerchant);
    assert.ok(defaultMerchantCredential);
    const originalDefaultMerchantCredential = structuredClone(
      defaultMerchantCredential
    );

    const enterResponse = await fetch(
      `${baseUrl}/platform/tenants/${encodeURIComponent(tenantId)}/enter`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${providerToken}`
        }
      }
    );
    const enterPayload = (await enterResponse.json()) as {
      data?: {
        token?: string;
        user?: {
          scope?: string;
          tenantId?: string;
          permissions?: string[];
        };
      };
    };
    const tenantToken = enterPayload.data?.token;

    assert.equal(enterResponse.status, 201);
    assert.ok(tenantToken);
    assert.equal(enterPayload.data?.user?.scope, "tenant");
    assert.equal(enterPayload.data?.user?.tenantId, tenantId);
    assert.deepEqual(enterPayload.data?.user?.permissions, [
      "devices:view",
      "devices:manage",
      "devices:operate",
      "users:view",
      "users:manage",
      "users:review",
      "verification-codes:manage",
      "backoffice-credentials:manage"
    ]);

    const usersResponse = await fetch(`${baseUrl}/users`, {
      headers: {
        authorization: `Bearer ${tenantToken}`
      }
    });
    const usersPayload = (await usersResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    const devicesResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${tenantToken}`
      }
    });
    const devicesPayload = (await devicesResponse.json()) as {
      data?: Array<{ deviceCode?: string }>;
    };
    const credentialsResponse = await fetch(
      `${baseUrl}/auth/backoffice-credentials`,
      {
        headers: {
          authorization: `Bearer ${tenantToken}`
        }
      }
    );
    const credentialsPayload = (await credentialsResponse.json()) as {
      data?: Array<{ userId?: string; tenantId?: string }>;
    };
    const resetOtherTenantResponse = await fetch(
      `${baseUrl}/auth/backoffice-password-reset-as-super-admin`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenantToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          userId: defaultMerchant.id,
          role: "merchant",
          newPassword: "cross-tenant-reset-attempt",
          reason: "验证进入实例后不能跨租户重置密码"
        })
      }
    );

    assert.equal(usersResponse.status, 200);
    assert.deepEqual(
      usersPayload.data?.map((entry) => entry.id),
      [firstAdminUserId]
    );
    assert.equal(devicesResponse.status, 200);
    assert.deepEqual(devicesPayload.data, []);
    assert.equal(credentialsResponse.status, 200);
    assert.deepEqual(credentialsPayload.data, [
      {
        ...credentialsPayload.data?.[0],
        userId: firstAdminUserId,
        tenantId
      }
    ]);
    assert.equal(resetOtherTenantResponse.status, 403);
    assert.deepEqual(
      store.findBackofficeCredentialByUserId(defaultMerchant.id, "merchant"),
      originalDefaultMerchantCredential
    );
  } finally {
    await app.close();
  }
});

test("非默认实例的商家和补货员只能读取各自已分配柜机", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const firstAdminUsername = `tenant-assigned-view-admin-${randomUUID().slice(0, 8)}`;
    const firstAdminPassword = randomUUID();
    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-assigned-view",
        name: "分配柜机验证实例",
        instanceUrl: "https://tenant-assigned-view.example.test",
        firstAdmin: {
          name: "分配柜机实例管理员",
          phone: "18800000025",
          username: firstAdminUsername,
          password: firstAdminPassword
        }
      })
    });
    const createTenantPayload = (await createTenantResponse.json()) as {
      data?: { tenant?: { id?: string } };
    };
    const tenantId = createTenantPayload.data?.tenant?.id;
    assert.equal(createTenantResponse.status, 201);
    assert.ok(tenantId);

    const adminLoginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: firstAdminUsername, password: firstAdminPassword })
    });
    const adminLoginPayload = (await adminLoginResponse.json()) as {
      data?: { token?: string };
    };
    const tenantAdminToken = adminLoginPayload.data?.token;
    assert.equal(adminLoginResponse.status, 201);
    assert.ok(tenantAdminToken);

    const createDevice = async (deviceCode: string, name: string) => {
      const response = await fetch(`${baseUrl}/devices`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenantAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ deviceCode, name, location: "分配柜机验证点" })
      });
      const payload = (await response.json()) as {
        data?: { deviceCode?: string; tenantId?: string };
      };
      assert.equal(response.status, 201);
      assert.equal(payload.data?.deviceCode, deviceCode);
      assert.equal(payload.data?.tenantId, tenantId);
    };

    const assignedDeviceCode = "TENANT-ASSIGNED-VIEW-1";
    const unassignedDeviceCode = "TENANT-ASSIGNED-VIEW-2";
    await createDevice(assignedDeviceCode, "已分配验证柜机");
    await createDevice(unassignedDeviceCode, "未分配验证柜机");

    const defaultDevice = store.devices.find(
      (entry) => store.getDeviceTenantId(entry) === store.getDefaultTenantId()
    );
    assert.ok(defaultDevice);

    const createAssignedRoleToken = async (
      role: "merchant" | "restocker",
      phone: string
    ) => {
      const userResponse = await fetch(`${baseUrl}/users`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenantAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          role,
          phone,
          name: role === "merchant" ? "实例商户柜机查看者" : "实例补货员柜机查看者"
        })
      });
      const userPayload = (await userResponse.json()) as { data?: { id?: string; tenantId?: string } };
      const userId = userPayload.data?.id;
      assert.equal(userResponse.status, 201);
      assert.ok(userId);
      assert.equal(userPayload.data?.tenantId, tenantId);

      const assignmentResponse = await fetch(
        `${baseUrl}/users/${encodeURIComponent(userId)}/device-assignment`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${tenantAdminToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ deviceCodes: [assignedDeviceCode] })
        }
      );
      assert.equal(assignmentResponse.status, 200);

      const username = `tenant-assigned-view-${role}-${randomUUID().slice(0, 8)}`;
      const password = randomUUID();
      const credentialResponse = await fetch(`${baseUrl}/auth/backoffice-credentials`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenantAdminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ userId, username, password, role })
      });
      assert.equal(credentialResponse.status, 201);

      const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const loginPayload = (await loginResponse.json()) as {
        data?: { token?: string; user?: { backofficeRole?: string; tenantId?: string } };
      };
      assert.equal(loginResponse.status, 201);
      assert.equal(loginPayload.data?.user?.backofficeRole, role);
      assert.equal(loginPayload.data?.user?.tenantId, tenantId);
      assert.ok(loginPayload.data?.token);
      return loginPayload.data!.token!;
    };

    const merchantToken = await createAssignedRoleToken("merchant", "18800000026");
    const restockerToken = await createAssignedRoleToken("restocker", "18800000027");

    for (const token of [merchantToken, restockerToken]) {
      const deviceResponses: Response[] = await Promise.all([
        fetch(`${baseUrl}/devices/${encodeURIComponent(assignedDeviceCode)}`, {
          headers: { authorization: `Bearer ${token}` }
        }),
        fetch(`${baseUrl}/devices/${encodeURIComponent(unassignedDeviceCode)}`, {
          headers: { authorization: `Bearer ${token}` }
        }),
        fetch(`${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}`, {
          headers: { authorization: `Bearer ${token}` }
        })
      ]);
      const [assignedResponse, unassignedResponse, defaultResponse] = deviceResponses;
      assert.ok(assignedResponse);
      assert.ok(unassignedResponse);
      assert.ok(defaultResponse);
      const assignedPayload = (await assignedResponse.json()) as {
        data?: { deviceCode?: string; tenantId?: string };
      };
      assert.equal(assignedResponse.status, 200);
      assert.equal(assignedPayload.data?.deviceCode, assignedDeviceCode);
      assert.equal(assignedPayload.data?.tenantId, tenantId);
      assert.equal(unassignedResponse.status, 403);
      assert.equal(defaultResponse.status, 403);
    }
  } finally {
    await app.close();
  }
});

test("新实例首管理员可登录并创建仅归属本实例的人员和柜机", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-bootstrap",
        name: "启动闭环实例",
        instanceUrl: "https://tenant-bootstrap.example.test",
        firstAdmin: {
          name: "启动闭环首管理员",
          phone: "18800000005",
          username: "tenant-bootstrap-admin",
          password: "tenant-bootstrap-password"
        }
      })
    });
    const createPayload = (await createResponse.json()) as {
      data?: {
        tenant?: { id?: string };
      };
    };
    const tenantId = createPayload.data?.tenant?.id;
    assert.equal(createResponse.status, 201);
    assert.ok(tenantId);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-bootstrap-admin",
        password: "tenant-bootstrap-password"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: {
        token?: string;
        user?: { tenantId?: string; permissions?: string[] };
      };
    };
    const adminToken = loginPayload.data?.token;
    assert.equal(loginResponse.status, 201);
    assert.ok(adminToken);
    assert.equal(loginPayload.data?.user?.tenantId, tenantId);

    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "restocker",
        phone: "18800000006",
        name: "新实例补货员"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string; tenantId?: string };
    };
    assert.equal(createUserResponse.status, 201);
    assert.equal(createUserPayload.data?.tenantId, tenantId);

    const createDeviceResponse = await fetch(`${baseUrl}/devices`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceCode: "TENANT-BOOTSTRAP-DEVICE",
        name: "新实例测试柜机",
        location: "新实例测试点"
      })
    });
    const createDevicePayload = (await createDeviceResponse.json()) as {
      data?: { deviceCode?: string; tenantId?: string };
    };
    assert.equal(createDeviceResponse.status, 201);
    assert.equal(createDevicePayload.data?.tenantId, tenantId);

    const usersResponse = await fetch(`${baseUrl}/users`, {
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    const usersPayload = (await usersResponse.json()) as {
      data?: Array<{ id?: string; tenantId?: string }>;
    };
    const devicesResponse = await fetch(`${baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    const devicesPayload = (await devicesResponse.json()) as {
      data?: Array<{ deviceCode?: string; tenantId?: string }>;
    };

    assert.equal(usersResponse.status, 200);
    assert.equal(usersPayload.data?.length, 2);
    assert.ok(usersPayload.data?.every((entry) => entry.tenantId === tenantId));
    assert.equal(devicesResponse.status, 200);
    assert.deepEqual(devicesPayload.data, [
      {
        ...devicesPayload.data?.[0],
        deviceCode: "TENANT-BOOTSTRAP-DEVICE",
        tenantId
      }
    ]);

    const overviewResponse = await fetch(`${baseUrl}/platform/overview`, {
      headers: {
        authorization: `Bearer ${providerToken}`
      }
    });
    const overviewPayload = (await overviewResponse.json()) as {
      data?: {
        totals?: { devices?: number };
        tenants?: Array<{
          tenant?: { id?: string };
          metrics?: { devices?: number };
        }>;
      };
    };
    const tenantOverview = overviewPayload.data?.tenants?.find(
      (entry) => entry.tenant?.id === tenantId
    );
    const defaultOverview = overviewPayload.data?.tenants?.find(
      (entry) => entry.tenant?.id === store.getDefaultTenantId()
    );

    assert.equal(overviewResponse.status, 200);
    assert.equal(tenantOverview?.metrics?.devices, 1);
    assert.equal(
      defaultOverview?.metrics?.devices,
      store.devices.filter(
        (entry) => store.getDeviceTenantId(entry) === store.getDefaultTenantId()
      ).length
    );
    assert.equal(overviewPayload.data?.totals?.devices, store.devices.length);
  } finally {
    await app.close();
  }
});

test("新实例管理员不能通过已知用户 ID、柜机编号或凭证接口越权操作默认实例", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const defaultTenantId = store.getDefaultTenantId();
    const defaultUser = store.users.find(
      (entry) =>
        store.getUserTenantId(entry) === defaultTenantId &&
        entry.role === "merchant" &&
        entry.status === "active"
    );
    const defaultDevice = store.devices.find(
      (entry) => store.getDeviceTenantId(entry) === defaultTenantId
    );
    const defaultCredential = defaultUser
      ? store.findBackofficeCredentialByUserId(defaultUser.id, "merchant")
      : undefined;
    assert.ok(defaultUser);
    assert.ok(defaultDevice);
    assert.ok(defaultCredential);

    const originalUser = structuredClone(defaultUser);
    const originalDevice = structuredClone(defaultDevice);
    const originalCredential = structuredClone(defaultCredential);
    const providerToken = createProviderToken(store);
    const createResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-cross-boundary",
        name: "越权边界实例",
        instanceUrl: "https://tenant-cross-boundary.example.test",
        firstAdmin: {
          name: "越权边界首管理员",
          phone: "18800000007",
          username: "tenant-cross-boundary-admin",
          password: "tenant-cross-boundary-password"
        }
      })
    });
    assert.equal(createResponse.status, 201);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-cross-boundary-admin",
        password: "tenant-cross-boundary-password"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: { token?: string };
    };
    const adminToken = loginPayload.data?.token;
    assert.equal(loginResponse.status, 201);
    assert.ok(adminToken);

    const authorizedHeaders = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    };
    const gatewayCalls = {
      goods: 0,
      refresh: 0,
      remoteOpen: 0
    };
    const smartVmGateway = app.get(SmartVmGateway);
    Object.defineProperties(smartVmGateway, {
      getGoodsInfo: {
        configurable: true,
        value: async () => {
          gatewayCalls.goods += 1;
          return [];
        }
      },
      getRouterStatus: {
        configurable: true,
        value: async () => {
          gatewayCalls.refresh += 1;
          return undefined;
        }
      },
      openDoor: {
        configurable: true,
        value: async () => {
          gatewayCalls.remoteOpen += 1;
          throw new Error("跨实例请求不应到达柜机网关");
        }
      }
    });
    const detailUserResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(defaultUser.id)}`,
      { headers: authorizedHeaders }
    );
    const unrelatedModuleResponses = await Promise.all([
      fetch(`${baseUrl}/access-rules`, { headers: authorizedHeaders }),
      fetch(`${baseUrl}/registration-applications`, {
        headers: authorizedHeaders
      }),
      fetch(`${baseUrl}/special-access-policies`, {
        headers: authorizedHeaders
      }),
      fetch(`${baseUrl}/reservations`, { headers: authorizedHeaders }),
      fetch(`${baseUrl}/reservations/settings`, {
        headers: authorizedHeaders
      }),
      fetch(`${baseUrl}/cabinet-events/open/pre-settlement`, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify({
          phone: "18800000007",
          deviceCode: defaultDevice.deviceCode,
          doorNum: "1"
        })
      })
    ]);
    const updateUserResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(defaultUser.id)}`,
      {
        method: "PATCH",
        headers: authorizedHeaders,
        body: JSON.stringify({ name: "不应跨实例改名" })
      }
    );
    const assignDeviceResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(defaultUser.id)}/device-assignment`,
      {
        method: "PATCH",
        headers: authorizedHeaders,
        body: JSON.stringify({ deviceCodes: [defaultDevice.deviceCode] })
      }
    );
    const credentialResponse = await fetch(`${baseUrl}/auth/backoffice-credentials`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({
        userId: defaultUser.id,
        username: defaultCredential.username,
        role: "merchant",
        permissions: ["devices:view"]
      })
    });
    const removeUserResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(defaultUser.id)}`,
      {
        method: "DELETE",
        headers: authorizedHeaders
      }
    );
    const detailDeviceResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}`,
      { headers: authorizedHeaders }
    );
    const updateLocationResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}/location`,
      {
        method: "PATCH",
        headers: authorizedHeaders,
        body: JSON.stringify({ location: "不应跨实例改位置" })
      }
    );
    const goodsResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}/goods/query`,
      {
        method: "POST",
        headers: authorizedHeaders
      }
    );
    const refreshResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}/refresh`,
      {
        method: "POST",
        headers: authorizedHeaders
      }
    );
    const remoteOpenResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}/remote-open`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify({
          doorNum: "1",
          reason: "跨实例请求必须在网关调用前拒绝"
        })
      }
    );
    const removeDeviceResponse = await fetch(
      `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}`,
      {
        method: "DELETE",
        headers: authorizedHeaders
      }
    );
    const scopedRegistrationPayload =
      (await unrelatedModuleResponses[1]!.json()) as {
        data?: Array<{ id?: string }>;
      };

    assert.equal(detailUserResponse.status, 404);
    assert.deepEqual(
      unrelatedModuleResponses.map((response) => response.status),
      [403, 200, 403, 403, 403, 403]
    );
    assert.deepEqual(scopedRegistrationPayload.data, []);
    assert.equal(updateUserResponse.status, 404);
    assert.equal(assignDeviceResponse.status, 404);
    assert.equal(credentialResponse.status, 403);
    assert.equal(removeUserResponse.status, 404);
    assert.equal(detailDeviceResponse.status, 403);
    assert.equal(updateLocationResponse.status, 403);
    assert.equal(goodsResponse.status, 403);
    assert.equal(refreshResponse.status, 403);
    assert.equal(remoteOpenResponse.status, 403);
    assert.equal(removeDeviceResponse.status, 403);
    assert.deepEqual(gatewayCalls, {
      goods: 0,
      refresh: 0,
      remoteOpen: 0
    });
    assert.deepEqual(
      store.users.find((entry) => entry.id === originalUser.id),
      originalUser
    );
    assert.deepEqual(
      store.devices.find((entry) => entry.deviceCode === originalDevice.deviceCode),
      originalDevice
    );
    assert.deepEqual(
      store.findBackofficeCredentialByUserId(originalUser.id, "merchant"),
      originalCredential
    );
  } finally {
    await app.close();
  }
});

test("API 重启后新实例首管理员、人员和柜机归属仍可恢复", async () => {
  let runningApi: Awaited<ReturnType<typeof startApiWithDataFile>> | undefined =
    await startApi();

  try {
    const providerToken = createProviderToken(runningApi.store);
    const createResponse = await fetch(`${runningApi.baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-restart",
        name: "重启恢复实例",
        instanceUrl: "https://tenant-restart.example.test",
        firstAdmin: {
          name: "重启恢复首管理员",
          phone: "18800000008",
          username: "tenant-restart-admin",
          password: "tenant-restart-password"
        }
      })
    });
    const createPayload = (await createResponse.json()) as {
      data?: { tenant?: { id?: string } };
    };
    const tenantId = createPayload.data?.tenant?.id;
    assert.equal(createResponse.status, 201);
    assert.ok(tenantId);

    const loginResponse = await fetch(
      `${runningApi.baseUrl}/auth/backoffice-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: "tenant-restart-admin",
          password: "tenant-restart-password"
        })
      }
    );
    const loginPayload = (await loginResponse.json()) as {
      data?: { token?: string };
    };
    const adminToken = loginPayload.data?.token;
    assert.equal(loginResponse.status, 201);
    assert.ok(adminToken);

    const createUserResponse = await fetch(`${runningApi.baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "merchant",
        phone: "18800000009",
        name: "重启恢复商户"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string; tenantId?: string };
    };
    const merchantUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(merchantUserId);
    assert.equal(createUserPayload.data?.tenantId, tenantId);

    const createDeviceResponse = await fetch(`${runningApi.baseUrl}/devices`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceCode: "TENANT-RESTART-DEVICE",
        name: "重启恢复柜机",
        location: "重启恢复测试点"
      })
    });
    assert.equal(createDeviceResponse.status, 201);

    const dataFile = runningApi.dataFile;
    await runningApi.app.close();
    runningApi = undefined;
    runningApi = await startApiWithDataFile(dataFile);

    const restartedLoginResponse = await fetch(
      `${runningApi.baseUrl}/auth/backoffice-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: "tenant-restart-admin",
          password: "tenant-restart-password"
        })
      }
    );
    const restartedLoginPayload = (await restartedLoginResponse.json()) as {
      data?: { token?: string; user?: { tenantId?: string } };
    };
    const restartedToken = restartedLoginPayload.data?.token;
    assert.equal(restartedLoginResponse.status, 201);
    assert.ok(restartedToken);
    assert.equal(restartedLoginPayload.data?.user?.tenantId, tenantId);

    const usersResponse = await fetch(`${runningApi.baseUrl}/users`, {
      headers: {
        authorization: `Bearer ${restartedToken}`
      }
    });
    const usersPayload = (await usersResponse.json()) as {
      data?: Array<{ id?: string; tenantId?: string }>;
    };
    const devicesResponse = await fetch(`${runningApi.baseUrl}/devices`, {
      headers: {
        authorization: `Bearer ${restartedToken}`
      }
    });
    const devicesPayload = (await devicesResponse.json()) as {
      data?: Array<{ deviceCode?: string; tenantId?: string }>;
    };

    assert.equal(usersResponse.status, 200);
    assert.equal(devicesResponse.status, 200);
    assert.ok(
      usersPayload.data?.some(
        (entry) => entry.id === merchantUserId && entry.tenantId === tenantId
      )
    );
    assert.deepEqual(
      devicesPayload.data?.map((entry) => ({
        deviceCode: entry.deviceCode,
        tenantId: entry.tenantId
      })),
      [
        {
          deviceCode: "TENANT-RESTART-DEVICE",
          tenantId
        }
      ]
    );
  } finally {
    await runningApi?.app.close();
  }
});

test("新实例首管理员可完成补货员和商户的账号签发与柜机分配闭环", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-role-flow",
        name: "角色闭环实例",
        instanceUrl: "https://tenant-role-flow.example.test",
        firstAdmin: {
          name: "角色闭环首管理员",
          phone: "18800000010",
          username: "tenant-role-flow-admin",
          password: "tenant-role-flow-password"
        }
      })
    });
    const createTenantPayload = (await createTenantResponse.json()) as {
      data?: { tenant?: { id?: string } };
    };
    const tenantId = createTenantPayload.data?.tenant?.id;
    assert.equal(createTenantResponse.status, 201);
    assert.ok(tenantId);

    const loginAdminResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-role-flow-admin",
        password: "tenant-role-flow-password"
      })
    });
    const loginAdminPayload = (await loginAdminResponse.json()) as {
      data?: { token?: string };
    };
    const adminToken = loginAdminPayload.data?.token;
    assert.equal(loginAdminResponse.status, 201);
    assert.ok(adminToken);
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    };

    const createDeviceResponse = await fetch(`${baseUrl}/devices`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        deviceCode: "TENANT-ROLE-FLOW-DEVICE",
        name: "角色闭环柜机",
        location: "角色闭环测试点"
      })
    });
    assert.equal(createDeviceResponse.status, 201);
    const localDevice = store.devices.find(
      (entry) => entry.deviceCode === "TENANT-ROLE-FLOW-DEVICE"
    );
    const defaultDevice = store.devices.find(
      (entry) => store.getDeviceTenantId(entry) === store.getDefaultTenantId()
    );
    assert.ok(localDevice);
    assert.ok(defaultDevice);
    localDevice.status = "online";
    localDevice.lastSeenAt = new Date().toISOString();
    store.updateDeviceRuntime(localDevice.deviceCode, {
      lastRefreshAt: localDevice.lastSeenAt,
      doorState: "closed",
      openedAfterLastCommand: true
    });

    const createRoleUser = async (
      role: "merchant" | "restocker",
      phone: string,
      name: string
    ) => {
      const response = await fetch(`${baseUrl}/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ role, phone, name })
      });
      const payload = (await response.json()) as {
        data?: { id?: string; tenantId?: string };
      };
      assert.equal(response.status, 201);
      assert.ok(payload.data?.id);
      assert.equal(payload.data?.tenantId, tenantId);
      return payload.data.id;
    };

    const provisionRole = async (
      role: "merchant" | "restocker",
      userId: string,
      username: string,
      password: string,
      permissions?: string[]
    ) => {
      const assignmentResponse = await fetch(
        `${baseUrl}/users/${encodeURIComponent(userId)}/device-assignment`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({
            deviceCodes: [localDevice.deviceCode]
          })
        }
      );
      assert.equal(assignmentResponse.status, 200);

      const credentialResponse = await fetch(
        `${baseUrl}/auth/backoffice-credentials`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({
            userId,
            username,
            password,
            role,
            permissions
          })
        }
      );
      assert.equal(credentialResponse.status, 201);

      const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ username, password })
      });
      const loginPayload = (await loginResponse.json()) as {
        data?: {
          token?: string;
          user?: {
            role?: string;
            backofficeRole?: string;
            tenantId?: string;
            permissions?: string[];
          };
        };
      };
      assert.equal(loginResponse.status, 201);
      assert.ok(loginPayload.data?.token);
      assert.equal(loginPayload.data?.user?.role, role);
      assert.equal(loginPayload.data?.user?.backofficeRole, role);
      assert.equal(loginPayload.data?.user?.tenantId, tenantId);

      return {
        token: loginPayload.data.token,
        permissions: loginPayload.data.user?.permissions
      };
    };

    const restockerUserId = await createRoleUser(
      "restocker",
      "18800000011",
      "角色闭环补货员"
    );
    const restockerSession = await provisionRole(
      "restocker",
      restockerUserId,
      "tenant-role-flow-restocker",
      "tenant-role-flow-restocker-password"
    );
    assert.deepEqual(restockerSession.permissions, [
      "goods:view",
      "devices:view",
      "devices:operate"
    ]);

    const merchantUserId = await createRoleUser(
      "merchant",
      "18800000012",
      "角色闭环商户"
    );
    const merchantSession = await provisionRole(
      "merchant",
      merchantUserId,
      "tenant-role-flow-merchant",
      "tenant-role-flow-merchant-password",
      ["devices:view"]
    );
    assert.deepEqual(merchantSession.permissions, [
      "devices:view"
    ]);

    for (const token of [restockerSession.token, merchantSession.token]) {
      const roleHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      };
      const listResponse = await fetch(`${baseUrl}/devices`, {
        headers: roleHeaders
      });
      const listPayload = (await listResponse.json()) as {
        data?: Array<{ deviceCode?: string; tenantId?: string }>;
      };
      const defaultDetailResponse: Response = await fetch(
        `${baseUrl}/devices/${encodeURIComponent(defaultDevice.deviceCode)}`,
        {
          headers: roleHeaders
        }
      );

      assert.equal(listResponse.status, 200);
      assert.deepEqual(
        listPayload.data?.map((entry) => ({
          deviceCode: entry.deviceCode,
          tenantId: entry.tenantId
        })),
        [
          {
            deviceCode: localDevice.deviceCode,
            tenantId
          }
        ]
      );
      assert.equal(defaultDetailResponse.status, 403);
    }

    const beforeEvents = structuredClone(store.events);
    const restockerPreviewResponse = await fetch(
      `${baseUrl}/cabinet-events/open/pre-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${restockerSession.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone: "18800000011",
          deviceCode: localDevice.deviceCode,
          doorNum: "1",
          hasInboundGoods: true
        })
      }
    );
    const restockerPreviewPayload = (await restockerPreviewResponse.json()) as {
      data?: { role?: string; operationType?: string };
    };

    assert.equal(restockerPreviewResponse.status, 200);
    assert.equal(restockerPreviewPayload.data?.role, "restocker");
    assert.equal(restockerPreviewPayload.data?.operationType, "restock");
    assert.deepEqual(store.events, beforeEvents);
  } finally {
    await app.close();
  }
});

test("人员创建、更新和批量导入都保持手机号全局唯一，失败前完成校验且不留下部分写入", async () => {
  const { app, store } = await startApi();

  try {
    const usersService = app.get(UsersService);
    const existing = store.users.find((entry) => entry.status === "active");
    assert.ok(existing);
    const tenantId = "tenant-phone-identity-test";
    const beforeCreateCount = store.users.length;

    assert.throws(
      () =>
        usersService.createUser(
          {
            role: "special",
            phone: existing.phone,
            name: "跨实例重复手机号"
          },
          undefined,
          tenantId
        ),
      /手机号已绑定/
    );
    assert.equal(store.users.length, beforeCreateCount);

    const tenantUser = usersService.createUser(
      {
        role: "special",
        phone: "18800000012",
        name: "手机号更新边界账号"
      },
      undefined,
      tenantId
    );
    assert.throws(
      () =>
        usersService.updateUser(
          tenantUser.id,
          { phone: existing.phone },
          undefined,
          "admin",
          tenantId
        ),
      /手机号已绑定/
    );
    assert.equal(tenantUser.phone, "18800000012");

    const beforeImport = structuredClone(store.users);
    assert.throws(
      () =>
        usersService.importUsers(
          {
            role: "special",
            entries: [
              { phone: "18800000013", name: "本不应写入的首条" },
              { phone: existing.phone, name: "跨实例重复的第二条" }
            ]
          },
          tenantId
        ),
      /手机号已绑定/
    );
    assert.deepEqual(store.users, beforeImport);

    assert.throws(
      () =>
        usersService.importUsers(
          {
            role: "special",
            entries: [
              { phone: "18800000014", name: "批量内重复一" },
              { phone: "18800000014", name: "批量内重复二" }
            ]
          },
          tenantId
        ),
      /导入数据中存在重复手机号/
    );
    assert.deepEqual(store.users, beforeImport);
  } finally {
    await app.close();
  }
});

test("默认实例管理员不能反向读取、修改或撤销新实例业务数据", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-reverse-boundary",
        name: "反向隔离实例",
        instanceUrl: "https://tenant-reverse-boundary.example.test",
        firstAdmin: {
          name: "反向隔离首管理员",
          phone: "18800000015",
          username: "tenant-reverse-boundary-admin",
          password: "tenant-reverse-boundary-password"
        }
      })
    });
    const createTenantPayload = (await createTenantResponse.json()) as {
      data?: { tenant?: { id?: string } };
    };
    const tenantId = createTenantPayload.data?.tenant?.id;
    assert.equal(createTenantResponse.status, 201);
    assert.ok(tenantId);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-reverse-boundary-admin",
        password: "tenant-reverse-boundary-password"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: { token?: string };
    };
    const tenantAdminToken = loginPayload.data?.token;
    assert.equal(loginResponse.status, 201);
    assert.ok(tenantAdminToken);

    const tenantHeaders = {
      authorization: `Bearer ${tenantAdminToken}`,
      "content-type": "application/json"
    };
    const createUserResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: tenantHeaders,
      body: JSON.stringify({
        role: "special",
        phone: "18800000016",
        name: "反向隔离普通用户"
      })
    });
    const createUserPayload = (await createUserResponse.json()) as {
      data?: { id?: string };
    };
    const tenantUserId = createUserPayload.data?.id;
    assert.equal(createUserResponse.status, 201);
    assert.ok(tenantUserId);

    const createDeviceResponse = await fetch(`${baseUrl}/devices`, {
      method: "POST",
      headers: tenantHeaders,
      body: JSON.stringify({
        deviceCode: "TENANT-REVERSE-DEVICE",
        name: "反向隔离测试柜机",
        location: "反向隔离测试点"
      })
    });
    assert.equal(createDeviceResponse.status, 201);

    const tenantUser = store.users.find((entry) => entry.id === tenantUserId);
    assert.ok(tenantUser);
    const eventId = "event-tenant-reverse-boundary";
    const movementId = "movement-tenant-reverse-boundary";
    const occurredAt = new Date().toISOString();
    store.events.unshift({
      eventId,
      orderNo: "order-tenant-reverse-boundary",
      userId: tenantUser.id,
      phone: tenantUser.phone,
      role: tenantUser.role,
      deviceCode: "TENANT-REVERSE-DEVICE",
      doorNum: "1",
      status: "settled",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      amount: 0,
      goods: []
    });
    store.inventory.unshift({
      id: movementId,
      orderNo: "order-tenant-reverse-boundary",
      eventId,
      userId: tenantUser.id,
      deviceCode: "TENANT-REVERSE-DEVICE",
      goodsId: "goods-1001",
      goodsName: "反向隔离测试物资",
      category: "food",
      quantity: 1,
      unitPrice: 0,
      type: "pickup",
      happenedAt: occurredAt
    });
    const originalTenantUser = structuredClone(tenantUser);
    const foreignLog = store.logOperation({
      category: "user",
      type: "update-user",
      status: "success",
      actor: {
        type: "admin",
        name: "反向隔离实例管理员",
        role: "admin"
      },
      primarySubject: {
        type: "user",
        id: tenantUser.id,
        label: tenantUser.name
      },
      secondarySubject: {
        type: "device",
        id: "TENANT-REVERSE-DEVICE",
        label: "反向隔离测试柜机"
      },
      metadata: {
        tenantId,
        beforeSnapshot: {
          ...structuredClone(tenantUser),
          name: "不应被默认实例管理员恢复的旧名称"
        },
        undoState: "undoable"
      }
    });
    const foreignCallbackLog = store.logCallback("settlement", {
      eventId,
      deviceCode: "TENANT-REVERSE-DEVICE",
      status: "SUCCESS",
      amount: 12.34,
      detail: [{ goodsId: "goods-1001", quantity: 1 }]
    });
    const defaultDevice = store.devices.find(
      (entry) =>
        store.getDeviceTenantId(entry) === store.getDefaultTenantId()
    );
    assert.ok(defaultDevice);
    const ownCallbackLog = store.logCallback("door-status", {
      deviceCode: defaultDevice.deviceCode,
      status: "CLOSED"
    });

    const defaultAdminToken = createDefaultAdminToken(store);
    const defaultHeaders = {
      authorization: `Bearer ${defaultAdminToken}`,
      "content-type": "application/json"
    };
    const [
      eventListResponse,
      eventDetailResponse,
      callbackLogsResponse,
      inventoryResponse,
      logsResponse,
      logDetailResponse,
      logExportResponse,
      manualAdjustmentResponse,
      accessPolicyResponse,
      undoResponse
    ] = await Promise.all([
      fetch(`${baseUrl}/cabinet-events`, { headers: defaultHeaders }),
      fetch(`${baseUrl}/cabinet-events/event/${encodeURIComponent(eventId)}`, {
        headers: defaultHeaders
      }),
      fetch(`${baseUrl}/cabinet-events/callback-logs`, {
        headers: defaultHeaders
      }),
      fetch(`${baseUrl}/inventory-orders`, { headers: defaultHeaders }),
      fetch(`${baseUrl}/operation-logs`, { headers: defaultHeaders }),
      fetch(`${baseUrl}/operation-logs/${encodeURIComponent(foreignLog.id)}`, {
        headers: defaultHeaders
      }),
      fetch(`${baseUrl}/operation-logs/export/file`, { headers: defaultHeaders }),
      fetch(`${baseUrl}/users/${encodeURIComponent(tenantUser.id)}/manual-adjustment`, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({
          deviceCode: "TENANT-REVERSE-DEVICE",
          goodsId: "goods-1001",
          quantity: 1,
          direction: "restock",
          confirmed: true
        })
      }),
      fetch(`${baseUrl}/users/${encodeURIComponent(tenantUser.id)}/access-policies`, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({
          name: "不应跨实例写入的规则",
          weekdays: [1],
          startHour: 9,
          endHour: 18,
          goodsLimits: [{ goodsId: "goods-1001", quantity: 1 }],
          status: "active"
        })
      }),
      fetch(`${baseUrl}/operation-logs/${encodeURIComponent(foreignLog.id)}/undo`, {
        method: "POST",
        headers: defaultHeaders
      })
    ]);
    const eventListPayload = (await eventListResponse.json()) as {
      data?: Array<{ eventId?: string }>;
    };
    const inventoryPayload = (await inventoryResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    const callbackLogsPayload = (await callbackLogsResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    const logsPayload = (await logsResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    const exportBody = await logExportResponse.text();

    assert.equal(eventListResponse.status, 200);
    assert.equal(
      eventListPayload.data?.some((entry) => entry.eventId === eventId),
      false
    );
    assert.equal(eventDetailResponse.status, 404);
    assert.equal(callbackLogsResponse.status, 200);
    assert.equal(
      callbackLogsPayload.data?.some(
        (entry) => entry.id === foreignCallbackLog.id
      ),
      false
    );
    assert.equal(
      callbackLogsPayload.data?.some((entry) => entry.id === ownCallbackLog.id),
      true
    );
    assert.equal(inventoryResponse.status, 200);
    assert.equal(
      inventoryPayload.data?.some((entry) => entry.id === movementId),
      false
    );
    assert.equal(logsResponse.status, 200);
    assert.equal(
      logsPayload.data?.some((entry) => entry.id === foreignLog.id),
      false
    );
    assert.equal(logDetailResponse.status, 404);
    assert.equal(logExportResponse.status, 200);
    assert.equal(exportBody.includes(tenantUser.name), false);
    assert.equal(manualAdjustmentResponse.status, 404);
    assert.equal(accessPolicyResponse.status, 404);
    assert.equal(undoResponse.status, 404);
    assert.equal(
      store.inventory.some(
        (entry) =>
          entry.userId === tenantUser.id &&
          entry.type === "manual-restock" &&
          entry.happenedAt >= occurredAt
      ),
      false
    );
    assert.deepEqual(
      store.users.find((entry) => entry.id === tenantUser.id),
      originalTenantUser
    );
  } finally {
    await app.close();
  }
});

test("实例管理员只能审核本实例申请且审批生成的用户继承实例归属", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-registration-review",
        name: "注册审核实例",
        instanceUrl: "https://tenant-registration-review.example.test",
        firstAdmin: {
          name: "注册审核首管理员",
          phone: "18800000017",
          username: "tenant-registration-review-admin",
          password: "tenant-registration-review-password"
        }
      })
    });
    const createTenantPayload = (await createTenantResponse.json()) as {
      data?: { tenant?: { id?: string } };
    };
    const tenantId = createTenantPayload.data?.tenant?.id;
    assert.equal(createTenantResponse.status, 201);
    assert.ok(tenantId);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-registration-review-admin",
        password: "tenant-registration-review-password"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: { token?: string };
    };
    const tenantAdminToken = loginPayload.data?.token;
    assert.equal(loginResponse.status, 201);
    assert.ok(tenantAdminToken);

    const region = store.regions.find((entry) => entry.status === "active");
    assert.ok(region);
    const now = new Date().toISOString();
    const tenantApplicationId = "application-tenant-registration-review";
    const defaultApplicationId = "application-default-registration-review";
    store.registrationApplications.unshift(
      {
        id: tenantApplicationId,
        tenantId,
        phone: "18800000018",
        requestedRole: "special",
        profile: {
          name: "注册审核实例普通用户",
          regionId: region.id,
          regionName: region.name
        },
        status: "pending",
        createdAt: now,
        updatedAt: now
      },
      {
        id: defaultApplicationId,
        tenantId: store.getDefaultTenantId(),
        phone: "18800000019",
        requestedRole: "merchant",
        profile: {
          name: "默认实例待审核商户",
          merchantName: "默认实例待审核商户",
          contactName: "默认实例联系人",
          address: "默认实例地址"
        },
        status: "pending",
        createdAt: now,
        updatedAt: now
      }
    );

    const tenantHeaders = {
      authorization: `Bearer ${tenantAdminToken}`,
      "content-type": "application/json"
    };
    const defaultHeaders = {
      authorization: `Bearer ${createDefaultAdminToken(store)}`,
      "content-type": "application/json"
    };
    const [
      tenantListResponse,
      tenantDetailResponse,
      tenantCrossDetailResponse,
      defaultListResponse,
      defaultCrossDetailResponse
    ] = await Promise.all([
      fetch(`${baseUrl}/registration-applications`, {
        headers: tenantHeaders
      }),
      fetch(
        `${baseUrl}/registration-applications/${encodeURIComponent(tenantApplicationId)}`,
        { headers: tenantHeaders }
      ),
      fetch(
        `${baseUrl}/registration-applications/${encodeURIComponent(defaultApplicationId)}`,
        { headers: tenantHeaders }
      ),
      fetch(`${baseUrl}/registration-applications`, {
        headers: defaultHeaders
      }),
      fetch(
        `${baseUrl}/registration-applications/${encodeURIComponent(tenantApplicationId)}`,
        { headers: defaultHeaders }
      )
    ]);
    const tenantListPayload = (await tenantListResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    const defaultListPayload = (await defaultListResponse.json()) as {
      data?: Array<{ id?: string }>;
    };

    assert.equal(tenantListResponse.status, 200);
    assert.deepEqual(
      tenantListPayload.data?.map((entry) => entry.id),
      [tenantApplicationId]
    );
    assert.equal(tenantDetailResponse.status, 200);
    assert.equal(tenantCrossDetailResponse.status, 404);
    assert.equal(defaultListResponse.status, 200);
    assert.equal(
      defaultListPayload.data?.some((entry) => entry.id === tenantApplicationId),
      false
    );
    assert.equal(
      defaultListPayload.data?.some((entry) => entry.id === defaultApplicationId),
      true
    );
    assert.equal(defaultCrossDetailResponse.status, 404);

    const reviewResponse = await fetch(
      `${baseUrl}/registration-applications/${encodeURIComponent(tenantApplicationId)}/review`,
      {
        method: "PATCH",
        headers: tenantHeaders,
        body: JSON.stringify({ decision: "approved" })
      }
    );
    const reviewPayload = (await reviewResponse.json()) as {
      data?: { linkedUserId?: string; tenantId?: string; status?: string };
    };
    const linkedUser = store.users.find(
      (entry) => entry.id === reviewPayload.data?.linkedUserId
    );

    assert.equal(reviewResponse.status, 200);
    assert.equal(reviewPayload.data?.tenantId, tenantId);
    assert.equal(reviewPayload.data?.status, "approved");
    assert.ok(linkedUser);
    assert.equal(store.getUserTenantId(linkedUser), tenantId);
  } finally {
    await app.close();
  }
});

test("公开注册按已登记实例域名归属且完整审核登录不串实例", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const tenantHostname = "tenant-public-registration.example.test";
    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-public-registration",
        name: "公开注册实例",
        instanceUrl: `https://${tenantHostname}`,
        firstAdmin: {
          name: "公开注册首管理员",
          phone: "18800000021",
          username: "tenant-public-registration-admin",
          password: "tenant-public-registration-password"
        }
      })
    });
    const createTenantPayload = (await createTenantResponse.json()) as {
      data?: { tenant?: { id?: string } };
    };
    const tenantId = createTenantPayload.data?.tenant?.id;
    assert.equal(createTenantResponse.status, 201);
    assert.ok(tenantId);

    const tenantAdminLoginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-public-registration-admin",
        password: "tenant-public-registration-password"
      })
    });
    const tenantAdminLoginPayload = (await tenantAdminLoginResponse.json()) as {
      data?: { token?: string };
    };
    const tenantAdminToken = tenantAdminLoginPayload.data?.token;
    assert.equal(tenantAdminLoginResponse.status, 201);
    assert.ok(tenantAdminToken);

    const region = store.regions.find((entry) => entry.status === "active");
    assert.ok(region);
    const draftPhone = "18800000024";
    const draftCode = store.issueVerificationCode(draftPhone, "general");
    const draftLoginResponse = await fetch(`${baseUrl}/auth/mobile-login`, {
      method: "POST",
      headers: {
        "x-forwarded-host": tenantHostname,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone: draftPhone,
        code: draftCode,
        requestedRole: "special"
      })
    });
    const draftLoginPayload = (await draftLoginResponse.json()) as {
      data?: { state?: string; draft?: { token?: string } };
    };
    const draftToken = draftLoginPayload.data?.draft?.token;
    assert.equal(draftLoginResponse.status, 201);
    assert.equal(draftLoginPayload.data?.state, "needs_profile");
    assert.ok(draftToken);

    const draftProfileBody = JSON.stringify({
      draftToken,
      requestedRole: "special",
      profile: {
        name: "域名绑定资料续填用户",
        regionId: region.id,
        regionName: region.name
      }
    });
    const crossTenantDraftResponse = await fetch(
      `${baseUrl}/auth/mobile-profile`,
      {
        method: "POST",
        headers: {
          "x-forwarded-host": "vending.5gogogo.top",
          "content-type": "application/json"
        },
        body: draftProfileBody
      }
    );
    assert.equal(crossTenantDraftResponse.status, 401);
    assert.equal(
      store.registrationApplications.some(
        (entry) => entry.phone === draftPhone
      ),
      false
    );

    const ownTenantDraftResponse = await fetch(
      `${baseUrl}/auth/mobile-profile`,
      {
        method: "POST",
        headers: {
          "x-forwarded-host": tenantHostname,
          "content-type": "application/json"
        },
        body: draftProfileBody
      }
    );
    const ownTenantDraftPayload = (await ownTenantDraftResponse.json()) as {
      data?: {
        state?: string;
        application?: { tenantId?: string; phone?: string };
      };
    };
    assert.equal(ownTenantDraftResponse.status, 201);
    assert.equal(ownTenantDraftPayload.data?.state, "pending_review");
    assert.equal(ownTenantDraftPayload.data?.application?.tenantId, tenantId);
    assert.equal(ownTenantDraftPayload.data?.application?.phone, draftPhone);

    const phone = "18800000022";
    const registrationCode = store.issueVerificationCode(phone, "register");
    const registrationResponse = await fetch(`${baseUrl}/registration-applications`, {
      method: "POST",
      headers: {
        "x-forwarded-host": tenantHostname,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone,
        code: registrationCode,
        requestedRole: "special",
        profile: {
          name: "公开注册实例普通用户",
          regionId: region.id,
          regionName: region.name
        }
      })
    });
    const registrationPayload = (await registrationResponse.json()) as {
      data?: { id?: string; tenantId?: string; status?: string };
    };
    const applicationId = registrationPayload.data?.id;
    assert.equal(registrationResponse.status, 201);
    assert.ok(applicationId);
    assert.equal(registrationPayload.data?.tenantId, tenantId);
    assert.equal(registrationPayload.data?.status, "pending");

    const tenantHeaders = {
      authorization: `Bearer ${tenantAdminToken}`,
      "content-type": "application/json"
    };
    const defaultHeaders = {
      authorization: `Bearer ${createDefaultAdminToken(store)}`,
      "content-type": "application/json"
    };
    const [tenantListResponse, defaultListResponse] = await Promise.all([
      fetch(`${baseUrl}/registration-applications`, { headers: tenantHeaders }),
      fetch(`${baseUrl}/registration-applications`, { headers: defaultHeaders })
    ]);
    const tenantListPayload = (await tenantListResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    const defaultListPayload = (await defaultListResponse.json()) as {
      data?: Array<{ id?: string }>;
    };
    assert.equal(
      tenantListPayload.data?.some((entry) => entry.id === applicationId),
      true
    );
    assert.equal(
      defaultListPayload.data?.some((entry) => entry.id === applicationId),
      false
    );

    const updateCode = store.issueVerificationCode(phone, "register");
    const crossTenantUpdateResponse = await fetch(
      `${baseUrl}/registration-applications/${encodeURIComponent(applicationId)}`,
      {
        method: "PATCH",
        headers: {
          "x-forwarded-host": "vending.5gogogo.top",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone,
          code: updateCode,
          requestedRole: "special",
          profile: {
            name: "不应跨实例写入",
            regionId: region.id,
            regionName: region.name
          }
        })
      }
    );
    assert.equal(crossTenantUpdateResponse.status, 404);

    const ownTenantUpdateResponse = await fetch(
      `${baseUrl}/registration-applications/${encodeURIComponent(applicationId)}`,
      {
        method: "PATCH",
        headers: {
          "x-forwarded-host": tenantHostname,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          phone,
          code: updateCode,
          requestedRole: "special",
          profile: {
            name: "公开注册实例更新用户",
            regionId: region.id,
            regionName: region.name
          }
        })
      }
    );
    assert.equal(ownTenantUpdateResponse.status, 200);

    const reviewResponse = await fetch(
      `${baseUrl}/registration-applications/${encodeURIComponent(applicationId)}/review`,
      {
        method: "PATCH",
        headers: tenantHeaders,
        body: JSON.stringify({ decision: "approved" })
      }
    );
    const reviewPayload = (await reviewResponse.json()) as {
      data?: { linkedUserId?: string; tenantId?: string; status?: string };
    };
    const linkedUser = store.users.find(
      (entry) => entry.id === reviewPayload.data?.linkedUserId
    );
    assert.equal(reviewResponse.status, 200);
    assert.equal(reviewPayload.data?.tenantId, tenantId);
    assert.equal(reviewPayload.data?.status, "approved");
    assert.ok(linkedUser);
    assert.equal(store.getUserTenantId(linkedUser), tenantId);

    const crossTenantLookupCode = store.issueVerificationCode(phone, "register");
    const crossTenantLookupResponse = await fetch(
      `${baseUrl}/registration-applications/by-phone?phone=${encodeURIComponent(phone)}&code=${encodeURIComponent(crossTenantLookupCode)}`,
      {
        headers: {
          "x-forwarded-host": "vending.5gogogo.top"
        }
      }
    );
    const crossTenantLookupPayload = (await crossTenantLookupResponse.json()) as {
      data?: { state?: string; application?: { id?: string } };
    };
    assert.equal(crossTenantLookupResponse.status, 200);
    assert.equal(crossTenantLookupPayload.data?.state, "new");
    assert.equal(crossTenantLookupPayload.data?.application, undefined);

    const crossTenantLoginCode = store.issueVerificationCode(
      phone,
      "app-login"
    );
    const crossTenantAppLoginResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "x-forwarded-host": "vending.5gogogo.top",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone,
        code: crossTenantLoginCode
      })
    });
    const crossTenantAppLoginPayload =
      (await crossTenantAppLoginResponse.json()) as {
        data?: { state?: string; token?: string };
      };
    assert.equal(crossTenantAppLoginResponse.status, 201);
    assert.equal(crossTenantAppLoginPayload.data?.state, "not_registered");
    assert.equal(crossTenantAppLoginPayload.data?.token, undefined);

    const loginCode = store.issueVerificationCode(phone, "app-login");
    const appLoginResponse = await fetch(`${baseUrl}/auth/app-login`, {
      method: "POST",
      headers: {
        "x-forwarded-host": tenantHostname,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        phone,
        code: loginCode
      })
    });
    const appLoginPayload = (await appLoginResponse.json()) as {
      data?: { state?: string; token?: string; user?: { id?: string } };
    };
    assert.equal(appLoginResponse.status, 201);
    assert.equal(appLoginPayload.data?.state, "approved");
    assert.equal(appLoginPayload.data?.user?.id, linkedUser.id);
    assert.equal(
      store.sessions.get(appLoginPayload.data?.token ?? "")?.tenantId,
      tenantId
    );
  } finally {
    await app.close();
  }
});

test("实例管理员不能在补货模板列表读取其他实例的商户私有模板", async () => {
  const { app, baseUrl, store } = await startApi();

  try {
    const providerToken = createProviderToken(store);
    const createTenantResponse = await fetch(`${baseUrl}/platform/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${providerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code: "tenant-private-template",
        name: "私有模板实例",
        instanceUrl: "https://tenant-private-template.example.test",
        firstAdmin: {
          name: "私有模板首管理员",
          phone: "18800000020",
          username: "tenant-private-template-admin",
          password: "tenant-private-template-password"
        }
      })
    });
    assert.equal(createTenantResponse.status, 201);

    const loginResponse = await fetch(`${baseUrl}/auth/backoffice-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "tenant-private-template-admin",
        password: "tenant-private-template-password"
      })
    });
    const loginPayload = (await loginResponse.json()) as {
      data?: { token?: string };
    };
    const tenantAdminToken = loginPayload.data?.token;
    assert.equal(loginResponse.status, 201);
    assert.ok(tenantAdminToken);

    const createMerchantResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenantAdminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        role: "merchant",
        phone: "18800000021",
        name: "私有模板实例商户"
      })
    });
    const createMerchantPayload = (await createMerchantResponse.json()) as {
      data?: { id?: string };
    };
    const merchantUserId = createMerchantPayload.data?.id;
    assert.equal(createMerchantResponse.status, 201);
    assert.ok(merchantUserId);

    const now = new Date().toISOString();
    const foreignTemplateId = "template-tenant-private";
    store.merchantGoodsTemplates.unshift({
      id: foreignTemplateId,
      ownerUserId: merchantUserId,
      goodsId: "goods-1001",
      goodsCode: "GOODS-1001",
      goodsName: "其他实例私有补货模板",
      category: "food",
      defaultQuantity: 1,
      defaultShelfLifeDays: 2,
      status: "active",
      createdAt: now,
      updatedAt: now
    });

    const defaultAdminResponse = await fetch(
      `${baseUrl}/merchant-goods-templates`,
      {
        headers: {
          authorization: `Bearer ${createDefaultAdminToken(store)}`
        }
      }
    );
    const defaultAdminPayload = (await defaultAdminResponse.json()) as {
      data?: Array<{ id?: string }>;
    };

    assert.equal(defaultAdminResponse.status, 200);
    assert.equal(
      defaultAdminPayload.data?.some((entry) => entry.id === foreignTemplateId),
      false
    );
  } finally {
    await app.close();
  }
});
