import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { InventoryMovement, SpecialAccessPolicy, UserRecord } from "@vm/shared-types";
import { addDaysToDateKey, getBusinessDayKey } from "../src/common/time/business-day";
import { AnalyticsService } from "../src/modules/analytics/analytics.service";

const today = () => getBusinessDayKey(new Date());
const movement = (userId: string, dateKey: string, overrides: Partial<InventoryMovement> = {}): InventoryMovement => ({
  id: `${userId}-${dateKey}`, orderNo: `${userId}-${dateKey}`, userId,
  deviceCode: "cabinet", goodsId: "bread", goodsName: "面包", category: "food",
  quantity: 1, unitPrice: 0, type: "pickup", happenedAt: `${dateKey}T06:00:00Z`, ...overrides
});

function dashboard(userIds: string[], inventory: InventoryMovement[]) {
  const users: UserRecord[] = userIds.map((id) => ({
    id, name: id, phone: "", role: "special", status: "active", tags: [], mobileProfileCompleted: true
  }));
  const policy: SpecialAccessPolicy = {
    id: "daily", name: "每日领取", status: "active", weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 8, endHour: 20, applicableUserIds: userIds,
    goodsLimits: [{ goodsId: "bread", goodsName: "面包", category: "food", quantity: 2 }]
  };
  const service = new AnalyticsService({
    users, inventory, specialAccessPolicies: [policy], goodsCatalog: [], goodsTaxonomyNodes: [], logs: []
  } as never, { list: () => [] } as never,
  { getOverview: () => ({ lowStockKinds: 0, outOfStockKinds: 0 }) } as never);
  return service.getDashboard();
}

test("首页排除从未领取者，保留曾领取但今日未领取者及今日实际领取者", () => {
  const result = dashboard(["never", "returning", "partial", "complete"], [
    movement("returning", addDaysToDateKey(today(), -10)),
    movement("partial", today()),
    movement("complete", today(), { quantity: 2 })
  ]);
  assert.equal(result.serviceOverview.totalUsers, 3);
  assert.deepEqual(result.serviceOverview.unservedUsers.users.map((user) => user.userId), ["returning"]);
  assert.equal(result.stats.partialUsers, 1);
  assert.equal(result.stats.completeUsers, 1);
  assert.equal(result.stats.unservedUsers, 1);
});

test("首次领取前的历史趋势不计未服务，首次领取当天计入已服务", () => {
  const result = dashboard(["first-today", "never"], [movement("first-today", today())]);
  for (const point of result.serviceTrend.slice(0, -1)) {
    assert.equal(point.unservedUsers, 0);
    assert.equal(point.completeUsers + point.partialUsers, 0);
  }
  assert.equal(result.serviceTrend.at(-1)?.partialUsers, 1);
  assert.equal(result.serviceTrend.at(-1)?.unservedUsers, 0);
});

test("全额撤销、零数量和只有投放记录的人不计入领取对象，部分退回仍计入", () => {
  const date = addDaysToDateKey(today(), -10);
  const result = dashboard(["reverted", "zero", "donor", "retained"], [
    movement("reverted", date),
    movement("reverted", date, { id: "undo", type: "refund" }),
    movement("zero", date, { quantity: 0 }),
    movement("donor", date, { type: "donation" }),
    movement("retained", date, { quantity: 2 }),
    movement("retained", date, { id: "partial-refund", type: "refund" })
  ]);
  assert.equal(result.serviceOverview.totalUsers, 1);
  assert.deepEqual(result.serviceOverview.unservedUsers.users.map((user) => user.userId), ["retained"]);
});

test("实际补记的领取计入历史，未来领取记录不提前纳入当前统计", () => {
  const result = dashboard(["adjusted", "future"], [
    movement("adjusted", addDaysToDateKey(today(), -10), { type: "adjustment" }),
    movement("future", addDaysToDateKey(today(), 1))
  ]);
  assert.equal(result.serviceOverview.totalUsers, 1);
  assert.deepEqual(result.serviceOverview.unservedUsers.users.map((user) => user.userId), ["adjusted"]);
});
