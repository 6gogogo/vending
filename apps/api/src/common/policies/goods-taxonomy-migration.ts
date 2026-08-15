import { createHash } from "node:crypto";

import type {
  GoodsCategory,
  GoodsTaxonomyNode
} from "@vm/shared-types";

import type { PersistedStoreState } from "../store/persistence";

const STANDARD_NODE_DEFINITIONS = [
  { id: "taxonomy:any", name: "任意", parentId: null, sortOrder: 1 },
  { id: "taxonomy:diet", name: "饮食", parentId: "taxonomy:any", sortOrder: 1 },
  { id: "taxonomy:food", name: "食品", parentId: "taxonomy:diet", sortOrder: 1 },
  { id: "taxonomy:drink", name: "饮料", parentId: "taxonomy:diet", sortOrder: 2 },
  { id: "taxonomy:daily", name: "日用品", parentId: "taxonomy:any", sortOrder: 2 }
] as const;

const categoryNodeId: Record<GoodsCategory, string> = {
  food: "taxonomy:food",
  drink: "taxonomy:drink",
  daily: "taxonomy:daily"
};

const stableCustomNodeId = (category: GoodsCategory, name: string) =>
  `taxonomy:custom:${category}:${createHash("sha256").update(name.trim()).digest("hex").slice(0, 12)}`;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export interface GoodsTaxonomyMigrationPreview {
  version: 1;
  sourceInstanceId: string;
  sourceStateHash: string;
  nodes: GoodsTaxonomyNode[];
  assignments: Array<{ goodsId: string; taxonomyNodeId: string }>;
  clearedTemplatePolicyCount: number;
  clearedPersonalPolicyCount: number;
  clearedPersonalQuotaCount: number;
  resetSpecialRuleCount: number;
  cancelledReservationIds: string[];
  retainedSameDayMovementCount: number;
  previewHash: string;
}

const migrationSourceHash = (state: PersistedStoreState) =>
  createHash("sha256")
    .update(
      canonicalJson({
        goodsCatalog: state.goodsCatalog,
        goodsTaxonomyNodes: state.goodsTaxonomyNodes,
        inventory: state.inventory,
        reservations: state.reservations,
        rules: state.rules,
        specialAccessPolicies: state.specialAccessPolicies,
        users: state.users.map((user) => ({
          id: user.id,
          accessPolicies: user.accessPolicies,
          quota: user.quota
        }))
      })
    )
    .digest("hex");

const normalizePreviewTime = (value: string) => `${value.slice(0, 10)}T00:00:00.000Z`;

export const buildGoodsTaxonomyMigrationPreview = (
  state: PersistedStoreState,
  now: string = new Date().toISOString()
): GoodsTaxonomyMigrationPreview => {
  if ((state.goodsTaxonomyNodes ?? []).length > 0) {
    throw new Error("当前实例已经存在货品分类树，拒绝用初始化迁移覆盖。");
  }
  now = normalizePreviewTime(now);
  const nodes: GoodsTaxonomyNode[] = STANDARD_NODE_DEFINITIONS.map((definition) => ({
    ...definition,
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now
  }));
  const customNodeIds = new Map<string, string>();
  const assignments = state.goodsCatalog.map((goods) => {
    const categoryName = goods.categoryName?.trim();
    const standardName = STANDARD_NODE_DEFINITIONS.find(
      (definition) => definition.id === categoryNodeId[goods.category]
    )?.name;
    if (!categoryName || categoryName === standardName) {
      return { goodsId: goods.goodsId, taxonomyNodeId: categoryNodeId[goods.category] };
    }
    const key = `${goods.category}:${categoryName}`;
    let id = customNodeIds.get(key);
    if (!id) {
      id = stableCustomNodeId(goods.category, categoryName);
      customNodeIds.set(key, id);
      nodes.push({
        id,
        name: categoryName,
        parentId: categoryNodeId[goods.category],
        status: "active",
        sortOrder: customNodeIds.size,
        revision: 1,
        createdAt: now,
        updatedAt: now
      });
    }
    return { goodsId: goods.goodsId, taxonomyNodeId: id };
  });
  const businessDay = now.slice(0, 10);
  const payload = {
    version: 1 as const,
    sourceInstanceId: state.instanceId,
    sourceStateHash: migrationSourceHash(state),
    nodes,
    assignments,
    clearedTemplatePolicyCount: state.specialAccessPolicies.length,
    clearedPersonalPolicyCount: state.users.reduce(
      (sum, user) => sum + (user.accessPolicies?.length ?? 0),
      0
    ),
    clearedPersonalQuotaCount: state.users.filter((user) => Boolean(user.quota)).length,
    resetSpecialRuleCount: state.rules.filter((rule) => rule.role === "special").length,
    cancelledReservationIds: state.reservations
      .filter((reservation) => reservation.status === "active")
      .map((reservation) => reservation.id)
      .sort(),
    retainedSameDayMovementCount: state.inventory.filter(
      (movement) => movement.happenedAt.slice(0, 10) === businessDay
    ).length
  };
  return {
    ...payload,
    previewHash: createHash("sha256").update(canonicalJson(payload)).digest("hex")
  };
};

export const applyGoodsTaxonomyMigration = (
  state: PersistedStoreState,
  preview: GoodsTaxonomyMigrationPreview,
  expectedHash: string,
  now: string = new Date().toISOString()
): PersistedStoreState => {
  const previewTime = preview.nodes[0]?.createdAt ?? now;
  const currentPreview = buildGoodsTaxonomyMigrationPreview(state, previewTime);
  if (
    preview.sourceInstanceId !== state.instanceId ||
    expectedHash !== preview.previewHash ||
    currentPreview.previewHash !== preview.previewHash ||
    currentPreview.sourceStateHash !== preview.sourceStateHash
  ) {
    throw new Error("迁移预览已过期或哈希不匹配，拒绝应用。");
  }
  const next = structuredClone(state);
  next.goodsTaxonomyNodes = structuredClone(preview.nodes);
  const assignmentByGoods = new Map(
    preview.assignments.map((entry) => [entry.goodsId, entry.taxonomyNodeId])
  );
  for (const goods of next.goodsCatalog) {
    goods.taxonomyNodeId = assignmentByGoods.get(goods.goodsId);
    delete goods.taxonomyPath;
    goods.updatedAt = now;
  }
  next.specialAccessPolicies = [];
  for (const user of next.users) {
    user.accessPolicies = [];
    delete user.quota;
  }
  for (const rule of next.rules) {
    if (rule.role !== "special") continue;
    rule.dailyLimit = 0;
    rule.categoryLimit = {};
  }
  for (const reservation of next.reservations) {
    if (reservation.status !== "active") continue;
    reservation.status = "cancelled";
    reservation.cancelledAt = now;
    reservation.cancelledByUserId = "system";
    reservation.cancellationReason = "领取分类迁移，系统已取消原预约。";
    reservation.updatedAt = now;
  }
  next.logs.unshift({
    id: `migration-goods-taxonomy-${createHash("sha256")
      .update(`${preview.previewHash}:${now}`)
      .digest("hex")
      .slice(0, 16)}`,
    category: "policy",
    type: "goods-taxonomy-migration",
    status: "success",
    occurredAt: now,
    actor: { type: "system", name: "系统迁移" },
    primarySubject: { type: "goods", id: "goods-taxonomy", label: "商品分类树" },
    detail: `已建立 ${preview.nodes.length} 个分类节点并迁移 ${preview.assignments.length} 个货品；旧领取策略已清空。`,
    description: "商品分类树迁移已按预览哈希应用，历史库存流水保留，活动预约已取消。",
    metadata: {
      previewHash: preview.previewHash,
      sourceStateHash: preview.sourceStateHash,
      clearedTemplatePolicyCount: preview.clearedTemplatePolicyCount,
      clearedPersonalPolicyCount: preview.clearedPersonalPolicyCount,
      cancelledReservationCount: preview.cancelledReservationIds.length
    }
  });
  return next;
};
