import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";
import { createEmptyPersistedState } from "../src/common/store/persistence.js";
import { hashAdminPassword } from "../src/modules/auth/admin-password.utils.js";
import { AuthService } from "../src/modules/auth/auth.service.js";

const withEnvironment = async (
  values: Record<string, string | undefined>,
  action: () => Promise<void> | void
) => {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("旧真实快照补齐人员实例归属后可正常登录，不依赖模拟 tenant-a", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-live-tenant-session-"));
  const root = join(directory, "live-root");
  const environment = {
    VM_DATA_PLANE: "live",
    VM_DATA_ROOT: root,
    VM_DATA_PLANE_ID: "live-session-test",
    VM_PLATFORM_TENANT_NAME: "真实会话测试实例",
    PUBLIC_BASE_URL: "https://live-session.example.test",
    API_DATA_FILE: "",
    SYSTEM_LOG_FILE: "",
    UPLOAD_DIR: "",
    API_BACKUP_DIR: "",
    FINANCIAL_SINGLE_WRITER_LEASE_FILE: "",
    NODE_ENV: "test",
    APP_ENV: undefined
  };
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withEnvironment(environment, async () => {
    const state = createEmptyPersistedState();
    state.initializationSource = "live-bootstrap";
    state.platformTenants.push({
      id: environment.VM_DATA_PLANE_ID,
      code: "current",
      name: environment.VM_PLATFORM_TENANT_NAME,
      status: "active",
      instanceUrl: environment.PUBLIC_BASE_URL,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    state.users.push({
      id: "live-admin-user",
      role: "admin",
      phone: "13900000000",
      name: "真实管理员",
      status: "active",
      tags: [],
      mobileProfileCompleted: false
    });
    const password = "live-admin-password";
    const passwordHash = hashAdminPassword(password);
    state.backofficeCredentials.push({
      userId: "live-admin-user",
      username: "live-admin",
      role: "admin",
      tenantId: environment.VM_DATA_PLANE_ID,
      passwordSalt: passwordHash.salt,
      passwordHash: passwordHash.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: "2026-01-01T00:00:00.000Z"
    });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "store.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const store = new InMemoryStoreService();
    assert.equal(store.getDefaultTenantId(), environment.VM_DATA_PLANE_ID);
    assert.equal(store.listPlatformTenants().length, 1);
    assert.equal(store.listPlatformTenants()[0]?.instanceUrl, environment.PUBLIC_BASE_URL);
    assert.equal(store.users[0]?.tenantId, environment.VM_DATA_PLANE_ID);

    const authService = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      store,
      {} as never,
      { get: () => undefined } as never
    );
    const session = await authService.backofficeLogin(
      "live-admin",
      password
    );
    assert.equal(session.user.id, "live-admin-user");
    assert.equal(session.user.tenantId, environment.VM_DATA_PLANE_ID);
  });
});
