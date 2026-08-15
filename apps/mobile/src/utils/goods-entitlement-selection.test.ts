import assert from "node:assert/strict";
import test from "node:test";

import type {
  EntitlementPoolSnapshot,
  GoodsTaxonomyNode
} from "@vm/shared-types";

import {
  buildGoodsSelectionPresentation,
  canIncrementGoodsSelection,
  allocateGoodsSelection
} from "./goods-entitlement-selection";

const taxonomyNodes: GoodsTaxonomyNode[] = [
  { id: "any", name: "任意物资", parentId: null, status: "active", sortOrder: 0, revision: 1, createdAt: "", updatedAt: "" },
  { id: "food-and-drink", name: "饮食", parentId: "any", status: "active", sortOrder: 0, revision: 1, createdAt: "", updatedAt: "" },
  { id: "food", name: "食品", parentId: "food-and-drink", status: "active", sortOrder: 0, revision: 1, createdAt: "", updatedAt: "" },
  { id: "drink", name: "饮料", parentId: "food-and-drink", status: "active", sortOrder: 1, revision: 1, createdAt: "", updatedAt: "" }
];

const pools: EntitlementPoolSnapshot[] = [
  { id: "food-limit", poolId: "food-pool", limitId: "food-limit", policyId: "policy", policyName: "今日额度", targetType: "taxonomy_node", targetId: "food", quantity: 1, remaining: 1 },
  { id: "any-limit", poolId: "any-pool", limitId: "any-limit", policyId: "policy", policyName: "今日额度", targetType: "taxonomy_node", targetId: "any", quantity: 2, remaining: 2 }
];

const goods = [
  { goodsId: "sandwich", name: "三明治", category: "food" as const, stock: 6, taxonomyNodeId: "food", taxonomyPath: taxonomyNodes.slice(0, 3) },
  { goodsId: "noodles", name: "泡面", category: "food" as const, stock: 8, taxonomyNodeId: "food", taxonomyPath: taxonomyNodes.slice(0, 3) },
  { goodsId: "water", name: "饮用水", category: "drink" as const, stock: 18, taxonomyNodeId: "drink", taxonomyPath: [taxonomyNodes[0]!, taxonomyNodes[1]!, taxonomyNodes[3]!] }
];

test("树状展示按分类归组，并把根额度作为同一份全局任意额度", () => {
  const result = buildGoodsSelectionPresentation({
    goods,
    pools,
    selectedByGoods: { sandwich: 1, water: 1 }
  });

  assert.equal(result.root?.name, "任意物资");
  assert.deepEqual(result.rows.map((row) => row.name), ["饮食", "食品", "饮料"]);
  assert.deepEqual(result.groups.map((group) => group.name), ["食品", "饮料"]);
  assert.deepEqual(result.groups[0]?.goods.map((item) => item.name), ["三明治", "泡面"]);
  assert.deepEqual(result.groups[0]?.dedicatedProgress, { selected: 1, available: 1 });
  assert.deepEqual(result.groups[1]?.dedicatedProgress, { selected: 0, available: 0 });
  assert.deepEqual(result.sharedProgress, { selected: 1, available: 2 });
});

test("跨分支货品返回顺序混乱时，分类仍按完整父子路径连续展示", () => {
  const result = buildGoodsSelectionPresentation({
    goods: [goods[2]!, goods[0]!, goods[1]!],
    pools,
    selectedByGoods: {}
  });

  assert.deepEqual(result.rows.map((row) => row.name), ["饮食", "食品", "饮料"]);
  assert.deepEqual(result.groups.map((group) => group.name), ["食品", "饮料"]);
});

test("分类展示采用后台排序值，不按分类名称字典序改写运营顺序", () => {
  const daily = {
    id: "daily",
    name: "日用品",
    parentId: "any",
    status: "active" as const,
    sortOrder: 5,
    revision: 1,
    createdAt: "",
    updatedAt: ""
  };
  const result = buildGoodsSelectionPresentation({
    goods: [
      { goodsId: "toothbrush", name: "牙刷", category: "daily", stock: 3, taxonomyNodeId: daily.id, taxonomyPath: [taxonomyNodes[0]!, daily] },
      ...goods
    ],
    pools,
    selectedByGoods: {}
  });

  assert.deepEqual(result.groups.map((group) => group.name), ["食品", "饮料", "日用品"]);
});

test("多层分支采用深度优先顺序，父分类与全部后代保持连续", () => {
  const result = buildGoodsSelectionPresentation({
    goods: [
      {
        goodsId: "berry-water",
        name: "莓果水",
        category: "drink",
        stock: 2,
        taxonomyNodeId: "berry-water",
        taxonomyPath: [
          taxonomyNodes[0]!,
          taxonomyNodes[1]!,
          taxonomyNodes[3]!,
          { id: "fruit-drink", name: "果味饮料", sortOrder: 2 },
          { id: "berry-water", name: "莓果水", sortOrder: 1 }
        ]
      },
      ...goods
    ],
    pools,
    selectedByGoods: {}
  });

  assert.deepEqual(result.rows.map((row) => row.name), ["饮食", "食品", "饮料", "果味饮料", "莓果水"]);
});

test("中间父分类额度显示在父节点，不伪装成叶子专属或全局任意额度", () => {
  const result = buildGoodsSelectionPresentation({
    goods,
    pools: [
      { id: "diet-limit", poolId: "diet-pool", limitId: "diet-limit", policyId: "policy", policyName: "今日额度", targetType: "taxonomy_node", targetId: "food-and-drink", quantity: 2, remaining: 2 }
    ],
    selectedByGoods: { water: 1 }
  });

  assert.deepEqual(result.rows.find((row) => row.id === "food-and-drink")?.directProgress, {
    selected: 1,
    available: 2
  });
  assert.deepEqual(result.groups.find((group) => group.id === "drink")?.dedicatedProgress, {
    selected: 0,
    available: 0
  });
  assert.deepEqual(result.sharedProgress, { selected: 0, available: 0 });
});

test("达到专属加全局任意额度上限后，其他分类不能继续选择", () => {
  const selectedByGoods = { sandwich: 1, noodles: 2 };

  assert.equal(canIncrementGoodsSelection({ goods, pools, selectedByGoods }, "water"), false);
  assert.equal(canIncrementGoodsSelection({ goods, pools, selectedByGoods }, "noodles"), false);
});

test("同一全局额度不会因分类重复展示而被重复计算", () => {
  const selectedByGoods = { sandwich: 1, water: 1 };
  const result = buildGoodsSelectionPresentation({ goods, pools, selectedByGoods });

  assert.deepEqual(result.sharedProgress, { selected: 1, available: 2 });
  assert.equal(canIncrementGoodsSelection({ goods, pools, selectedByGoods }, "noodles"), true);
  assert.equal(
    canIncrementGoodsSelection(
      { goods, pools, selectedByGoods: { ...selectedByGoods, noodles: 1 } },
      "water"
    ),
    false
  );
});

test("宽额度先占用后可重新安排到更具体额度，结果不受货品顺序影响", () => {
  const constrainedPools: EntitlementPoolSnapshot[] = [
    { id: "food-limit", poolId: "z-food", limitId: "food-limit", policyId: "policy", policyName: "今日额度", targetType: "taxonomy_node", targetId: "food", quantity: 1, remaining: 1 },
    { id: "any-limit", poolId: "a-any", limitId: "any-limit", policyId: "policy", policyName: "今日额度", targetType: "taxonomy_node", targetId: "any", quantity: 1, remaining: 1 }
  ];

  const forward = allocateGoodsSelection({
    goods,
    pools: constrainedPools,
    selectedByGoods: { sandwich: 1, water: 1 }
  });
  const reversed = allocateGoodsSelection({
    goods: [...goods].reverse(),
    pools: constrainedPools,
    selectedByGoods: { sandwich: 1, water: 1 }
  });

  assert.equal(forward.fulfilled, true);
  assert.equal(reversed.fulfilled, true);
  assert.deepEqual(
    forward.allocations.map((line) => [line.goodsId, line.poolId, line.quantity]).sort(),
    reversed.allocations.map((line) => [line.goodsId, line.poolId, line.quantity]).sort()
  );
});

test("同一目标存在多个额度池时，已选数量按实际池分配统计而不重复放大", () => {
  const result = buildGoodsSelectionPresentation({
    goods,
    pools: [
      { id: "any-first", poolId: "any-first", limitId: "any-first", policyId: "policy-a", policyName: "额度甲", targetType: "taxonomy_node", targetId: "any", quantity: 1, remaining: 1 },
      { id: "any-second", poolId: "any-second", limitId: "any-second", policyId: "policy-b", policyName: "额度乙", targetType: "taxonomy_node", targetId: "any", quantity: 2, remaining: 2 }
    ],
    selectedByGoods: { water: 1 }
  });

  assert.deepEqual(result.sharedProgress, { selected: 1, available: 3 });
});

test("额度池为空时不会凭分类路径虚构可选择数量", () => {
  const selectedByGoods = { sandwich: 0 };

  assert.equal(canIncrementGoodsSelection({ goods, pools: [], selectedByGoods }, "sandwich"), false);
  assert.deepEqual(
    buildGoodsSelectionPresentation({ goods, pools: [], selectedByGoods }).sharedProgress,
    { selected: 0, available: 0 }
  );
});
