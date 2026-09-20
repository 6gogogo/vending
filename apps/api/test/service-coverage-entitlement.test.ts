import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GoodsCatalogItem, GoodsTaxonomyNode, InventoryMovement, UserRecord } from "@vm/shared-types";
import { getActiveWindowEntitlementQuota, summarizeBusinessDayForUser } from "../src/common/policies/special-access-policy.utils";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AnalyticsService } from "../src/modules/analytics/analytics.service";
import { UsersService } from "../src/modules/users/users.service";

const dateKey = "2026-09-20";
const now = "2026-09-20T02:00:00.000Z";
const nodes: GoodsTaxonomyNode[] = [
  { id: "any", name: "任意", parentId: null, status: "active", sortOrder: 0, revision: 1, createdAt: now, updatedAt: now },
  { id: "food", name: "食品", parentId: "any", status: "active", sortOrder: 1, revision: 1, createdAt: now, updatedAt: now }
];
const goods: GoodsCatalogItem[] = [
  { goodsId: "box", goodsCode: "box", name: "爱心盲盒", category: "food", price: 0, imageUrl: "", taxonomyNodeId: "food", status: "active" },
  { goodsId: "tea", goodsCode: "tea", name: "乌龙茶", category: "drink", price: 0, imageUrl: "", taxonomyNodeId: "any", status: "inactive" }
];
const person = (id: string, quantity = 1): UserRecord => ({
  id, name: id, phone: "13800000000", role: "special", status: "active", tags: [], mobileProfileCompleted: true,
  accessPolicies: [{ id: `policy-${id}`, name: "每日任意物资", weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 8, endHour: 22, goodsLimits: [], status: "active", effectiveFromDateKey: dateKey,
    entitlementLimits: [{ id: "limit", targetType: "taxonomy_node", targetId: "any", quantity }] }]
});
const pickup = (user: UserRecord, patch: Partial<InventoryMovement> = {}): InventoryMovement => ({
  id: `movement-${user.id}`, orderNo: `order-${user.id}`, userId: user.id, deviceCode: "test-device",
  goodsId: "box", goodsName: "爱心盲盒", category: "food", type: "pickup", quantity: 1,
  quotaQuantity: 1, unitPrice: 0, happenedAt: now,
  entitlementAllocations: [{ poolId: `policy-${user.id}:${dateKey}:limit`, policyId: `policy-${user.id}`,
    limitId: "limit", targetType: "taxonomy_node", targetId: "any", goodsId: "box", quantity: 1 }],
  ...patch
});
const summary = (user: UserRecord, inventory: InventoryMovement[] = [], day = dateKey) =>
  summarizeBusinessDayForUser(user, [], inventory, goods, day, nodes);

test("分类共享额度按池统计，未领取、部分领取、全部领取与额度核算一致", () => {
  const user = person("registered", 2);
  const before = summary(user);
  assert.equal(before.totalGoods, 2); // 可选两种商品仍只有 2 件额度。
  assert.equal(before.completionStatus, "unserved");
  assert.equal(before.windows[0]?.entitlementUsage?.[0]?.targetName, "任意");
  const movement = pickup(user);
  assert.equal(summary(user, [movement]).completionStatus, "partial");
  const second = pickup(user, { id: "second", orderNo: "second-order" });
  const completed = summary(user, [second, movement]);
  assert.equal(completed.fulfilledGoods, 2);
  assert.equal(completed.completionStatus, "complete");
  assert.equal(getActiveWindowEntitlementQuota(user, [], [second, movement], goods, nodes, now).remainingTotal, 0);
  assert.equal(summary(user, [movement], "2026-09-19").completionStatus, "not_applicable");
});

test("分类移动后的历史精确扣额、跨日退款、未带额度池的旧流水均能正确统计", () => {
  const user = person("history");
  const movement = pickup(user);
  const movedGoods = goods.map((item) => ({ ...item, taxonomyNodeId: undefined }));
  assert.equal(summarizeBusinessDayForUser(user, [], [movement], movedGoods, dateKey, nodes).fulfilledGoods, 1);
  const refund = pickup(user, { id: "refund", type: "refund", happenedAt: "2026-09-21T03:00:00.000Z" });
  assert.equal(summary(user, [refund, movement]).completionStatus, "unserved");
  const legacy = pickup(user, { entitlementAllocations: undefined });
  assert.equal(summary(user, [legacy]).completionStatus, "complete");
  assert.equal(summary(user, [{ ...refund, entitlementAllocations: undefined }, legacy]).fulfilledGoods, 0);
  assert.equal(summary(user, [pickup(user, { quotaQuantity: 0, entitlementAllocations: [] })]).fulfilledGoods, 0);
});

test("多个共享池和重叠时段不会重复计算同一件领取，旧指定商品规则仍兼容", () => {
  const user = person("overlap");
  user.accessPolicies!.push({ ...structuredClone(user.accessPolicies![0]!), id: "second-policy" });
  const result = summary(user, [pickup(user, { entitlementAllocations: undefined })]);
  assert.equal(result.totalGoods, 2);
  assert.equal(result.fulfilledGoods, 1);
  assert.equal(result.completionStatus, "partial");
  user.accessPolicies = [{ ...user.accessPolicies![0]!, entitlementLimits: [],
    goodsLimits: [{ goodsId: "box", goodsName: "爱心盲盒", category: "food", quantity: 1 }] }];
  assert.equal(summary(user, [pickup(user)]).completionStatus, "complete");
});

test("凌晨时段按业务日归属，次日白天的领取不能填入前一天", () => {
  const user = person("early");
  user.accessPolicies![0]!.startHour = 0;
  user.accessPolicies![0]!.endHour = 4;
  const early = pickup(user, { happenedAt: "2026-09-20T18:00:00.000Z", entitlementAllocations: undefined });
  assert.equal(summary(user, [early]).completionStatus, "complete");
  assert.equal(summary(user, [pickup(user, { happenedAt: "2026-09-21T02:00:00.000Z" })]).fulfilledGoods, 0);
});

test("总览、趋势、人员台账和日历统计一致，只计入已注册且启用的领取人", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  const directory = mkdtempSync(join(tmpdir(), "vm-service-coverage-"));
  const previous = process.env.API_DATA_FILE;
  process.env.API_DATA_FILE = join(directory, "store.json");
  try {
    const store = new InMemoryStoreService();
    const complete = person("complete");
    const partial = person("partial", 2);
    const unserved = person("unserved");
    const pending = { ...person("unregistered"), mobileProfileCompleted: false };
    const inactive = { ...person("inactive"), status: "inactive" as const };
    store.users.splice(0, store.users.length, complete, partial, unserved, pending, inactive);
    store.specialAccessPolicies.splice(0);
    store.goodsCatalog.splice(0, store.goodsCatalog.length, ...structuredClone(goods));
    store.goodsTaxonomyNodes.splice(0, store.goodsTaxonomyNodes.length, ...structuredClone(nodes));
    store.inventory.splice(0, store.inventory.length, pickup(complete), pickup(partial));
    store.events.splice(0);
    store.logs.splice(0);
    const analytics = new AnalyticsService(store, { list: () => [] } as never,
      { getOverview: () => ({ lowStockKinds: 0, outOfStockKinds: 0 }) } as never);
    const dashboard = analytics.getDashboard();
    assert.equal(dashboard.serviceOverview.totalUsers, 3);
    assert.deepEqual([dashboard.stats.completeUsers, dashboard.stats.partialUsers, dashboard.stats.unservedUsers], [1, 1, 1]);
    assert.equal(dashboard.serviceOverview.unservedUsers.users[0]?.userId, unserved.id);
    assert.match(dashboard.serviceOverview.completeUsers.users[0]?.detailLines?.[0] ?? "", /任意 1\/1/);
    assert.deepEqual(dashboard.serviceTrend.at(-1), { label: "09-20", completeUsers: 1, partialUsers: 1, unservedUsers: 1, pendingTasks: 0 });
    assert.ok(dashboard.serviceTrend.slice(0, -1).every((point) => point.completeUsers + point.partialUsers + point.unservedUsers === 0));
    const users = new UsersService(store, {} as never, {} as never);
    const detail = users.detail(complete.id, { dateKey, monthKey: "2026-09" });
    assert.equal(detail.user.ledgerStatus, "quota_complete");
    assert.equal(detail.policyCalendar?.selectedDateSummary?.fulfilledGoods, 1);
    assert.equal(detail.policyCalendar?.days.find((day) => day.dateKey === dateKey)?.completionStatus, "complete");
    assert.equal(users.detail(unserved.id).user.ledgerStatus, "quota_unclaimed");
    assert.equal(users.detail(pending.id).user.ledgerStatus, "unregistered");
  } finally {
    if (previous === undefined) delete process.env.API_DATA_FILE; else process.env.API_DATA_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
