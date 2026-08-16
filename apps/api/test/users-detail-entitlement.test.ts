import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { UsersService } from "../src/modules/users/users.service";

test("人员详情的生效策略保留分类额度池", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-user-detail-entitlement-"));
  const previousDataFile = process.env.API_DATA_FILE;
  const previousDeviceBootstrap = process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";

  try {
    const store = new InMemoryStoreService();
    const users = new UsersService(store, {} as never, {} as never);
    const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
    const now = new Date().toISOString();
    const root = {
      id: "taxonomy-user-detail-root",
      name: "任意",
      parentId: null,
      status: "active" as const,
      sortOrder: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    const target = {
      id: "taxonomy-user-detail",
      name: "食品",
      parentId: root.id,
      status: "active" as const,
      sortOrder: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    store.goodsTaxonomyNodes.push(root, target);
    assert.ok(user);

    const created = users.saveAccessPolicy(user.id, {
      name: "分类额度详情回归",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startHour: 8,
      endHour: 24,
      goodsLimits: [],
      entitlementLimits: [
        {
          id: "limit-user-detail",
          targetType: "taxonomy_node",
          targetId: target.id,
          quantity: 3
        }
      ],
      status: "active"
    });

    const detail = users.detail(user.id, {
      dateKey: created.effectiveFromDateKey
    });
    const effectivePolicy = detail.accessPolicies?.find((entry) => entry.id === created.id);

    assert.deepEqual(effectivePolicy?.entitlementLimits, created.entitlementLimits);
    assert.notStrictEqual(effectivePolicy?.entitlementLimits, created.entitlementLimits);
  } finally {
    if (previousDataFile === undefined) {
      delete process.env.API_DATA_FILE;
    } else {
      process.env.API_DATA_FILE = previousDataFile;
    }
    if (previousDeviceBootstrap === undefined) {
      delete process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
    } else {
      process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = previousDeviceBootstrap;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
