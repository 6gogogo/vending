import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";
import { createEmptyPersistedState } from "../src/common/store/persistence.js";

const withEnvironment = (
  values: Record<string, string | undefined>,
  action: () => void
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
    action();
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

test("真实后台会话以持久化当前租户为准，不依赖模拟 tenant-a", (t) => {
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

  withEnvironment(environment, () => {
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
    state.backofficeCredentials.push({
      userId: "live-admin-user",
      username: "live-admin",
      role: "admin",
      tenantId: environment.VM_DATA_PLANE_ID,
      passwordSalt: "test-salt",
      passwordHash: "test-hash",
      usesDefaultPassword: false,
      passwordUpdatedAt: "2026-01-01T00:00:00.000Z"
    });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "store.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const store = new InMemoryStoreService();
    assert.equal(store.getDefaultTenantId(), environment.VM_DATA_PLANE_ID);
    assert.equal(store.listPlatformTenants().length, 1);
    assert.equal(store.listPlatformTenants()[0]?.instanceUrl, environment.PUBLIC_BASE_URL);

    const token = store.createBackofficeSession(
      store.users[0]!,
      "admin",
      environment.VM_DATA_PLANE_ID
    );
    assert.equal(store.getBackofficeSessionUser(token)?.user.id, "live-admin-user");
  });
});
