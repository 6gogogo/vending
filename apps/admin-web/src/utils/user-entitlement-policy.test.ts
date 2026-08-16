import assert from "node:assert/strict";
import test from "node:test";

import { reactive } from "vue";

import {
  cloneEntitlementLimits,
  createUserEntitlementLimit
} from "./user-entitlement-policy";

test("分类额度可从 Vue 响应式数据安全复制，且副本互不影响", () => {
  const source = reactive([
    {
      id: "limit-food",
      targetType: "taxonomy_node" as const,
      targetId: "taxonomy-food",
      quantity: 3
    }
  ]);

  const cloned = cloneEntitlementLimits(source);

  assert.deepEqual(cloned, [
    {
      id: "limit-food",
      targetType: "taxonomy_node",
      targetId: "taxonomy-food",
      quantity: 3
    }
  ]);
  assert.notStrictEqual(cloned, source);
  assert.notStrictEqual(cloned[0], source[0]);

  cloned[0]!.quantity = 4;
  assert.equal(source[0]!.quantity, 3);
});

test("初次打开分类额度表单时即生成可提交的额度 ID", () => {
  const limit = createUserEntitlementLimit("taxonomy-root", () => "limit-new");

  assert.deepEqual(limit, {
    id: "limit-new",
    targetType: "taxonomy_node",
    targetId: "taxonomy-root",
    quantity: 1
  });
});
