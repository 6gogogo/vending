import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateEntitlements,
  type EntitlementAllocationInput
} from "../src/common/policies/entitlement-allocation";
import { allocateActiveEntitlementsPreservingLocks } from "../src/common/policies/special-access-policy.utils";

const nodes: EntitlementAllocationInput["nodes"] = [
  { id: "any", parentId: null },
  { id: "diet", parentId: "any" },
  { id: "food", parentId: "diet" },
  { id: "daily", parentId: "any" }
];

const goods: EntitlementAllocationInput["goods"] = [
  { goodsId: "sandwich", taxonomyNodeId: "food" },
  { goodsId: "toothbrush", taxonomyNodeId: "daily" }
];

test("食品额度优先于任意额度，保留上级额度给其他物资", () => {
  const result = allocateEntitlements({
    nodes,
    goods,
    pools: [
      { poolId: "pool-food", policyId: "policy", limitId: "food-limit", targetType: "taxonomy_node", targetId: "food", remaining: 1 },
      { poolId: "pool-any", policyId: "policy", limitId: "any-limit", targetType: "taxonomy_node", targetId: "any", remaining: 3 }
    ],
    requests: [
      { goodsId: "sandwich", quantity: 1 },
      { goodsId: "toothbrush", quantity: 3 }
    ]
  });

  assert.equal(result.fulfilled, true);
  assert.deepEqual(
    result.allocations.map(({ goodsId, poolId, quantity }) => ({ goodsId, poolId, quantity })),
    [
      { goodsId: "sandwich", poolId: "pool-food", quantity: 1 },
      { goodsId: "toothbrush", poolId: "pool-any", quantity: 3 }
    ]
  );
});

test("食品一件加任意三件最多允许四件食品", () => {
  const common = {
    nodes,
    goods,
    pools: [
      { poolId: "pool-food", policyId: "policy", limitId: "food-limit", targetType: "taxonomy_node" as const, targetId: "food", remaining: 1 },
      { poolId: "pool-any", policyId: "policy", limitId: "any-limit", targetType: "taxonomy_node" as const, targetId: "any", remaining: 3 }
    ]
  };

  assert.equal(
    allocateEntitlements({ ...common, requests: [{ goodsId: "sandwich", quantity: 4 }] }).fulfilled,
    true
  );

  const rejected = allocateEntitlements({
    ...common,
    requests: [{ goodsId: "sandwich", quantity: 5 }]
  });
  assert.equal(rejected.fulfilled, false);
  assert.deepEqual(rejected.shortages, [{ goodsId: "sandwich", quantity: 1 }]);
});

test("分配结果不受货品提交顺序影响", () => {
  const input = {
    nodes,
    goods,
    pools: [
      { poolId: "pool-food", policyId: "policy", limitId: "food-limit", targetType: "taxonomy_node" as const, targetId: "food", remaining: 1 },
      { poolId: "pool-any", policyId: "policy", limitId: "any-limit", targetType: "taxonomy_node" as const, targetId: "any", remaining: 3 }
    ]
  };

  const forward = allocateEntitlements({
    ...input,
    requests: [
      { goodsId: "sandwich", quantity: 1 },
      { goodsId: "toothbrush", quantity: 3 }
    ]
  });
  const reverse = allocateEntitlements({
    ...input,
    requests: [
      { goodsId: "toothbrush", quantity: 3 },
      { goodsId: "sandwich", quantity: 1 }
    ]
  });

  const canonical = (result: typeof forward) =>
    result.allocations
      .map(({ goodsId, poolId, quantity }) => `${goodsId}:${poolId}:${quantity}`)
      .sort();

  assert.equal(forward.fulfilled, true);
  assert.equal(reverse.fulfilled, true);
  assert.deepEqual(canonical(forward), canonical(reverse));
});

test("宽额度不会被可使用窄额度的货品抢占", () => {
  const result = allocateEntitlements({
    nodes,
    goods: [
      { goodsId: "a-sandwich", taxonomyNodeId: "food" },
      { goodsId: "z-toothbrush", taxonomyNodeId: "daily" }
    ],
    pools: [
      {
        poolId: "food-pool",
        policyId: "policy",
        limitId: "food-limit",
        targetType: "taxonomy_node",
        targetId: "food",
        remaining: 1
      },
      {
        poolId: "root-pool",
        policyId: "policy",
        limitId: "root-limit",
        targetType: "taxonomy_node",
        targetId: "any",
        remaining: 1
      }
    ],
    requests: [
      { goodsId: "a-sandwich", quantity: 1 },
      { goodsId: "z-toothbrush", quantity: 1 }
    ]
  });

  assert.equal(result.fulfilled, true);
  assert.deepEqual(
    result.allocations.map((line) => [line.goodsId, line.poolId, line.quantity]),
    [
      ["a-sandwich", "food-pool", 1],
      ["z-toothbrush", "root-pool", 1]
    ]
  );
});

test("实际数量变化时保留同货品已锁额度，只为差额使用当前额度池", () => {
  const result = allocateActiveEntitlementsPreservingLocks(
    {
      activeWindows: [],
      remainingPools: [
        {
          id: "new-food-pool",
          poolId: "new-food-pool",
          policyId: "new-policy",
          policyName: "当前食品策略",
          limitId: "new-limit",
          targetType: "taxonomy_node",
          targetId: "food",
          quantity: 1,
          remaining: 1
        }
      ],
      receivableByGoods: {},
      remainingTotal: 1
    },
    nodes,
    goods,
    [{ goodsId: "sandwich", quantity: 2 }],
    [
      {
        poolId: "old-root-pool",
        policyId: "old-policy",
        limitId: "old-limit",
        targetType: "taxonomy_node",
        targetId: "any",
        goodsId: "sandwich",
        quantity: 1
      }
    ]
  );

  assert.equal(result.fulfilled, true);
  assert.deepEqual(
    result.allocations.map((line) => [line.poolId, line.quantity]),
    [
      ["old-root-pool", 1],
      ["new-food-pool", 1]
    ]
  );
});
