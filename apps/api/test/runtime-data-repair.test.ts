import assert from "node:assert/strict";
import test from "node:test";

import {
  analyseRuntimeDataRepair,
  applyApprovedRuntimeDataRepair
} from "../src/common/store/runtime-data-repair.js";
import { createEmptyPersistedState } from "../src/common/store/persistence.js";
import { validatePersistedState } from "../src/common/store/persisted-state-integrity.js";

const createRepairFixture = () => {
  const state = createEmptyPersistedState() as unknown as Record<string, unknown>;
  state.users = [
    { id: "repair-user-a", phone: "13800000001", name: "甲", role: "admin", status: "active" },
    { id: "repair-user-b", phone: "13800000002", name: "乙", role: "admin", status: "active" }
  ];
  state.goodsCatalog = [
    { goodsId: "repair-goods-valid", goodsCode: "repair-valid", name: "有效货品", category: "daily" },
    { goodsId: "repair-goods-removable", goodsCode: "repair-removable", name: "", category: "daily" },
    { goodsId: "", goodsCode: "", name: "", category: "daily" }
  ];
  state.inventory = [
    {
      id: "repair-zero-movement",
      userId: "repair-user-a",
      deviceCode: "repair-device",
      goodsId: "repair-goods-valid",
      type: "manual-deduction",
      quantity: 0,
      unitPrice: 0
    }
  ];
  state.merchantGoodsTemplates = [
    { id: "repair-orphan-template", goodsId: "repair-missing-goods" }
  ];
  state.adminCredentials = [
    {
      userId: "repair-user-a",
      username: "repair-admin",
      passwordSalt: "salt-a",
      passwordHash: "hash-a",
      passwordUpdatedAt: "2026-07-22T00:00:00.000Z",
      usesDefaultPassword: false
    },
    {
      userId: "repair-user-b",
      username: "REPAIR-ADMIN",
      passwordSalt: "salt-b",
      passwordHash: "hash-b",
      passwordUpdatedAt: "2026-07-22T00:00:00.000Z",
      usesDefaultPassword: false
    }
  ];
  return state;
};

test("运行数据修复分析只输出计数，并把无法证明安全的候选转为人工阻断", () => {
  const state = createRepairFixture();
  const analysis = analyseRuntimeDataRepair(state);
  const serialized = JSON.stringify(analysis);

  assert.deepEqual(analysis.malformedGoods, { detected: 2, eligible: 1, blocked: 1 });
  assert.deepEqual(analysis.zeroQuantityInventory, { detected: 1, eligible: 1, blocked: 0 });
  assert.deepEqual(analysis.orphanMerchantTemplates, { detected: 1, eligible: 1, blocked: 0 });
  assert.equal(analysis.manualRequiredCredentialDuplicateGroups, 1);
  assert.equal(analysis.canApply, false);
  for (const secretLikeValue of [
    "repair-goods-removable",
    "repair-zero-movement",
    "repair-orphan-template",
    "repair-admin",
    "hash-a"
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secretLikeValue, "i"));
  }
  assert.throws(
    () => applyApprovedRuntimeDataRepair(state),
    /仍存在需人工处理或无法证明安全的运行数据问题/
  );
});

test("运行数据修复只删除无外部引用的候选，并要求修复后完整性通过", () => {
  const state = createRepairFixture();
  (state.goodsCatalog as Array<Record<string, unknown>>).splice(2, 1);
  (state.adminCredentials as Array<Record<string, unknown>>).splice(1, 1);

  const analysis = analyseRuntimeDataRepair(state);
  assert.equal(analysis.canApply, true);

  const repaired = applyApprovedRuntimeDataRepair(state);
  assert.equal(repaired.changed, true);
  assert.equal((repaired.state.goodsCatalog as unknown[]).length, 1);
  assert.equal((repaired.state.inventory as unknown[]).length, 0);
  assert.equal((repaired.state.merchantGoodsTemplates as unknown[]).length, 0);
  assert.deepEqual(validatePersistedState(repaired.state).errors, []);
});

test("任何外部精确引用都会阻止删除候选", () => {
  const state = createRepairFixture();
  (state.goodsCatalog as Array<Record<string, unknown>>).splice(2, 1);
  (state.adminCredentials as Array<Record<string, unknown>>).splice(1, 1);
  state.logs = [
    {
      id: "repair-log",
      detail: "repair-orphan-template"
    }
  ];

  const analysis = analyseRuntimeDataRepair(state);

  assert.deepEqual(analysis.orphanMerchantTemplates, { detected: 1, eligible: 0, blocked: 1 });
  assert.equal(analysis.canApply, false);
});

test("未知元数据对象键中的精确引用同样阻止删除候选", () => {
  const state = createRepairFixture();
  (state.goodsCatalog as Array<Record<string, unknown>>).splice(2, 1);
  (state.adminCredentials as Array<Record<string, unknown>>).splice(1, 1);
  state.logs = [
    {
      id: "repair-log-key-reference",
      metadata: {
        "repair-orphan-template": {}
      }
    }
  ];

  const analysis = analyseRuntimeDataRepair(state);

  assert.deepEqual(analysis.orphanMerchantTemplates, { detected: 1, eligible: 0, blocked: 1 });
  assert.equal(analysis.canApply, false);
});
