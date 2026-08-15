import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { allocateEntitlements } from "../src/common/policies/entitlement-allocation";
import { GoodsTaxonomyService } from "../src/modules/goods/goods-taxonomy.service";
import { SpecialAccessPoliciesService } from "../src/modules/special-access-policies/special-access-policies.service";

const temporaryDirectories: string[] = [];
const originalDataFile = process.env.API_DATA_FILE;

const createHarness = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-goods-taxonomy-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  const store = new InMemoryStoreService();
  store.goodsTaxonomyNodes.splice(0);
  for (const goods of store.goodsCatalog) {
    delete goods.taxonomyNodeId;
    delete goods.taxonomyPath;
  }
  return { store, service: new GoodsTaxonomyService(store) };
};

after(() => {
  if (originalDataFile === undefined) delete process.env.API_DATA_FILE;
  else process.env.API_DATA_FILE = originalDataFile;
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test("分类树拒绝循环、同级重名和超过八层", () => {
  const { service } = createHarness();
  assert.throws(
    () => service.createNode({ name: "全部物资", parentId: null }),
    /根节点名称必须为“任意”/
  );
  const root = service.createNode({ name: "任意", parentId: null });
  const diet = service.createNode({ name: "饮食", parentId: root.id });
  const food = service.createNode({ name: "食品", parentId: diet.id });

  assert.throws(
    () => service.createNode({ name: "食品", parentId: diet.id }),
    /同一上级分类下已存在同名节点/
  );

  let parent = food;
  for (let level = 4; level <= 8; level += 1) {
    parent = service.createNode({ name: `第${level}层`, parentId: parent.id });
  }
  assert.throws(
    () => service.createNode({ name: "第九层", parentId: parent.id }),
    /最多支持 8 层/
  );

  const preview = service.previewChange(diet.id, { parentId: food.id });
  assert.equal(preview.allowed, false);
  assert.match(preview.blockReason ?? "", /循环/);
  const renameRoot = service.previewChange(root.id, { name: "全部物资" });
  assert.equal(renameRoot.allowed, false);
  assert.match(renameRoot.blockReason ?? "", /根节点名称必须为“任意”/);
});

test("货品批量归属后返回完整路径且一个货品仅有一个直接节点", () => {
  const { store, service } = createHarness();
  const root = service.createNode({ name: "任意", parentId: null });
  const diet = service.createNode({ name: "饮食", parentId: root.id });
  const food = service.createNode({ name: "食品", parentId: diet.id });

  const assigned = service.assignGoods({
    taxonomyNodeId: food.id,
    goodsIds: [store.goodsCatalog[0]!.goodsId],
    expectedRevision: service.getTreeRevision()
  });

  assert.equal(assigned.updated.length, 1);
  assert.deepEqual(assigned.updated[0]?.taxonomyPath?.map((entry) => entry.name), [
    "任意",
    "饮食",
    "食品"
  ]);
  assert.equal(store.goodsCatalog[0]?.taxonomyNodeId, food.id);
});

test("分类移动要求匹配预览 revision，并自动取消受影响预约", () => {
  const { store, service } = createHarness();
  const root = service.createNode({ name: "任意", parentId: null });
  const diet = service.createNode({ name: "饮食", parentId: root.id });
  const food = service.createNode({ name: "食品", parentId: diet.id });
  const daily = service.createNode({ name: "日用品", parentId: root.id });
  const goods = store.goodsCatalog[0]!;
  service.assignGoods({
    taxonomyNodeId: food.id,
    goodsIds: [goods.goodsId],
    expectedRevision: service.getTreeRevision()
  });
  const reservation = store.reservations[0] ?? {
    id: "reservation-taxonomy",
    userId: store.users.find((entry) => entry.role === "special")!.id,
    phone: "",
    deviceCode: store.devices[0]!.deviceCode,
    doorNum: "1",
    status: "active" as const,
    inventoryReservationMode: "goods_quantity" as const,
    batchAllocationTiming: "on_open" as const,
    items: [{ goodsId: goods.goodsId, goodsName: goods.name, category: goods.category, quantity: 1 }],
    reservedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.reservations.push(reservation);

  const preview = service.previewChange(food.id, { parentId: daily.id });
  assert.deepEqual(preview.affectedGoodsIds, [goods.goodsId]);
  assert.deepEqual(preview.affectedReservationIds, [reservation.id]);

  assert.throws(
    () => service.applyChange(food.id, { parentId: daily.id, expectedRevision: preview.expectedRevision + 1 }),
    /分类树已发生变化/
  );

  const result = service.applyChange(food.id, {
    parentId: daily.id,
    expectedRevision: preview.expectedRevision
  });
  assert.equal(result.node.parentId, daily.id);
  assert.equal(reservation.status, "cancelled");
  assert.equal(reservation.cancellationReason, "货品分类或领取规则调整，系统已自动取消预约。");
});

test("货品改归属要求匹配 revision，并取消锁定该货品的有效预约", () => {
  const { store, service } = createHarness();
  const root = service.createNode({ name: "任意", parentId: null });
  const food = service.createNode({ name: "食品", parentId: root.id });
  const daily = service.createNode({ name: "日用品", parentId: root.id });
  const goods = store.goodsCatalog[0]!;
  service.assignGoods({
    taxonomyNodeId: food.id,
    goodsIds: [goods.goodsId],
    expectedRevision: service.getTreeRevision()
  });
  const reservation = {
    id: "reservation-goods-assignment",
    userId: store.users.find((entry) => entry.role === "special")!.id,
    phone: "",
    deviceCode: store.devices[0]!.deviceCode,
    doorNum: "1",
    status: "active" as const,
    inventoryReservationMode: "goods_quantity" as const,
    batchAllocationTiming: "on_open" as const,
    items: [{ goodsId: goods.goodsId, goodsName: goods.name, category: goods.category, quantity: 1 }],
    reservedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.reservations.push(reservation);
  const preview = service.previewGoodsAssignment({
    taxonomyNodeId: daily.id,
    goodsIds: [goods.goodsId]
  });
  assert.deepEqual(preview.affectedReservationIds, [reservation.id]);
  assert.throws(
    () => service.assignGoods({
      taxonomyNodeId: daily.id,
      goodsIds: [goods.goodsId],
      expectedRevision: preview.expectedRevision - 1
    }),
    /分类树已发生变化/
  );
  const changed = service.assignGoods({
    taxonomyNodeId: daily.id,
    goodsIds: [goods.goodsId],
    expectedRevision: preview.expectedRevision
  });
  assert.equal(goods.taxonomyNodeId, daily.id);
  assert.equal(reservation.status, "cancelled");
  assert.deepEqual(changed.cancelledReservationIds, [reservation.id]);
  assert.equal(service.getTreeRevision(), preview.expectedRevision + 1);
});

test("货品改归属预览只报告旧新祖先链差异覆盖的分类额度", () => {
  const { store, service } = createHarness();
  const root = service.createNode({ name: "任意", parentId: null });
  const diet = service.createNode({ name: "饮食", parentId: root.id });
  const food = service.createNode({ name: "食品", parentId: diet.id });
  const drink = service.createNode({ name: "饮料", parentId: diet.id });
  const daily = service.createNode({ name: "日用品", parentId: root.id });
  const goods = store.goodsCatalog[0]!;
  service.assignGoods({
    taxonomyNodeId: food.id,
    goodsIds: [goods.goodsId],
    expectedRevision: service.getTreeRevision()
  });
  const user = store.users.find((entry) => entry.role === "special")!;
  const makePolicy = (id: string, targetId: string) => ({
    id,
    name: id,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0,
    endHour: 24,
    goodsLimits: [],
    entitlementLimits: [
      { id: `${id}-limit`, targetType: "taxonomy_node" as const, targetId, quantity: 1 }
    ],
    status: "active" as const
  });
  store.specialAccessPolicies.push(
    { ...makePolicy("policy-root", root.id), applicableUserIds: [user.id] },
    { ...makePolicy("policy-food", food.id), applicableUserIds: [user.id] },
    { ...makePolicy("policy-drink", drink.id), applicableUserIds: [user.id] },
    { ...makePolicy("policy-daily", daily.id), applicableUserIds: [user.id] }
  );

  const preview = service.previewGoodsAssignment({
    taxonomyNodeId: drink.id,
    goodsIds: [goods.goodsId]
  });

  assert.deepEqual(preview.affectedPolicyIds, ["policy-drink", "policy-food"]);
  assert.deepEqual(preview.affectedUserIds, [user.id]);
});

test("停用上级分类后其后代货品不可分配但额度查询不会崩溃", () => {
  const { store, service } = createHarness();
  const root = service.createNode({ name: "任意", parentId: null });
  const diet = service.createNode({ name: "饮食", parentId: root.id });
  const food = service.createNode({ name: "食品", parentId: diet.id });
  const goods = store.goodsCatalog[0]!;
  service.assignGoods({
    taxonomyNodeId: food.id,
    goodsIds: [goods.goodsId],
    expectedRevision: service.getTreeRevision()
  });
  const preview = service.previewChange(diet.id, { status: "inactive" });
  service.applyChange(diet.id, {
    status: "inactive",
    expectedRevision: preview.expectedRevision
  });
  const result = allocateEntitlements({
    nodes: store.goodsTaxonomyNodes,
    goods: store.goodsCatalog,
    pools: [{
      poolId: "pool-root",
      policyId: "policy",
      limitId: "limit",
      targetType: "taxonomy_node",
      targetId: root.id,
      remaining: 2
    }],
    requests: [{ goodsId: goods.goodsId, quantity: 1 }]
  });
  assert.equal(result.fulfilled, false);
  assert.deepEqual(result.shortages, [{ goodsId: goods.goodsId, quantity: 1 }]);
});

test("领取策略可直接配置分类节点额度并拒绝无效目标", () => {
  const { store, service: taxonomy } = createHarness();
  const root = taxonomy.createNode({ name: "任意", parentId: null });
  const food = taxonomy.createNode({ name: "食品", parentId: root.id });
  const service = new SpecialAccessPoliciesService(store);
  const common = {
    name: "食品与任意额度",
    weekdays: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 17,
    goodsLimits: [],
    applicableUserIds: [],
    status: "active" as const
  };

  const created = service.create({
    ...common,
    entitlementLimits: [
      { id: "food-limit", targetType: "taxonomy_node", targetId: food.id, quantity: 1 },
      { id: "any-limit", targetType: "taxonomy_node", targetId: root.id, quantity: 3 }
    ]
  });
  assert.equal(created.entitlementLimits?.length, 2);

  assert.throws(
    () => service.create({
      ...common,
      entitlementLimits: [
        { id: "missing-limit", targetType: "taxonomy_node", targetId: "missing", quantity: 1 }
      ]
    }),
    /不存在或已停用/
  );
});
