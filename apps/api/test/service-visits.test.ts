import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BadRequestException,
  ForbiddenException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  seedUsers,
  seedDevices,
  seedEvents,
  seedInventory,
  type InventoryMovement,
} from "@vm/shared-types";
import type { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { RoleGuard } from "../src/common/guards/role.guard";
import { AnalyticsController } from "../src/modules/analytics/analytics.controller";
import { buildServiceVisits } from "../src/modules/analytics/service-visits";

const now = new Date("2026-10-31T08:00:00Z");
const movement = (
  id: string,
  options: Partial<InventoryMovement> = {},
): InventoryMovement => ({
  ...seedInventory[0],
  id,
  userId: "person-a",
  deviceCode: "cab-a",
  orderNo: id,
  happenedAt: "2026-10-20T06:00:00Z",
  quantity: 1,
  ...options,
});
function fixture(inventory: InventoryMovement[] = []) {
  return {
    users: [
      {
        ...seedUsers.find((user) => user.role === "special")!,
        id: "person-a",
        name: "测试甲",
        tenantId: "tenant-a",
      },
      {
        ...seedUsers.find((user) => user.role === "special")!,
        id: "person-b",
        name: "测试乙",
        tenantId: "tenant-a",
        status: "disabled",
      },
      {
        ...seedUsers.find((user) => user.role === "special")!,
        id: "person-c",
        name: "其他实例人员",
        tenantId: "tenant-b",
      },
    ],
    devices: [
      { ...seedDevices[0], deviceCode: "cab-a", tenantId: "tenant-a" },
      { ...seedDevices[0], deviceCode: "cab-b", tenantId: "tenant-b" },
    ],
    events: [],
    inventory,
    getUserTenantId: (user: { tenantId?: string }) => user.tenantId,
    getDeviceTenantId: (device: { tenantId?: string }) => device.tenantId,
  } as unknown as InMemoryStoreService;
}

test("一次多件合并为一人次，同人两次领取计两次，人数仍为一人", () => {
  const row = movement("line-a", {
    eventId: "event-a",
    orderNo: "order-a",
    quantity: 2,
  });
  const store = fixture([
    row,
    movement("line-b", { orderNo: "order-a", goodsId: "milk", quantity: 3 }),
    row,
    movement("line-c"),
    movement("restock", { type: "manual-restock" }),
    movement("correction", { type: "manual-deduction" }),
    movement("adjust", { type: "adjustment" }),
  ]);
  const result = buildServiceVisits(store, "tenant-a", {}, now);
  assert.deepEqual(result.summary, {
    visits: 2,
    people: 1,
    units: 6,
    activeDays: 1,
  });
  assert.equal(
    result.people.find((person) => person.userId === "person-b")?.visits,
    0,
  );
  assert.equal(
    result.series.reduce((sum, point) => sum + point.visits, 0),
    2,
  );
});

test("退款、人工补记撤销与重新补记均抵减原事件，不重复增加人次", () => {
  const store = fixture([
    movement("original", { eventId: "event-a", quantity: 5 }),
    movement("partial-refund", {
      eventId: "event-a",
      type: "refund",
      quantity: 2,
    }),
    movement("manual", {
      eventId: "event-b",
      quantity: 4,
      settlementSource: "manual_recovery",
    }),
    movement("reversal", { eventId: "event-b", type: "refund", quantity: 4 }),
    movement("manual-again", { eventId: "event-b", quantity: 2 }),
    movement("fully-returned", { orderNo: "returned", quantity: 3 }),
    movement("full-refund", {
      orderNo: "refund-order",
      sourceOrderNo: "returned",
      type: "refund",
      quantity: 3,
    }),
  ]);
  assert.deepEqual(
    buildServiceVisits(store, "tenant-a", { period: "all" }, now).summary,
    { visits: 2, people: 1, units: 5, activeDays: 1 },
  );
});

test("近月、近年、自然月与自然年使用业务日边界，并补齐零值日期", () => {
  const store = fixture([
    movement("before-30d", { happenedAt: "2026-10-01T19:59:59Z" }),
    movement("start-30d", { happenedAt: "2026-10-01T20:00:00Z" }),
    movement("previous-year", { happenedAt: "2025-10-30T20:00:00Z" }),
    movement("start-365d", { happenedAt: "2025-10-31T20:00:00Z" }),
    movement("future", { happenedAt: "2026-11-01T06:00:00Z" }),
  ]);
  const recent = buildServiceVisits(store, "tenant-a", {}, now);
  assert.equal(recent.startDate, "2026-10-02");
  assert.equal(recent.endDate, "2026-10-31");
  assert.equal(recent.series.length, 30);
  assert.equal(recent.summary.visits, 1);
  assert.equal(recent.previous?.visits, 1);
  const annual = buildServiceVisits(
    store,
    "tenant-a",
    { period: "recent-year" },
    now,
  );
  assert.equal(annual.startDate, "2025-11-01");
  assert.equal(annual.summary.visits, 3);
  assert.equal(
    annual.series.reduce((sum, point) => sum + point.visits, 0),
    3,
  );
  assert.equal(
    buildServiceVisits(
      store,
      "tenant-a",
      { period: "month", month: "2024-02" },
      now,
    ).series.length,
    29,
  );
  assert.equal(
    buildServiceVisits(store, "tenant-a", { period: "year", year: "2025" }, now)
      .series.length,
    12,
  );
  assert.equal(
    buildServiceVisits(store, "tenant-a", { period: "year", year: "2026" }, now)
      .endDate,
    "2026-10-31",
  );
});

test("个人筛选联动累计、趋势和明细，停用人员的历史服务仍保留", () => {
  const store = fixture([
    movement("a"),
    movement("b", { userId: "person-b" }),
    movement("old-b", {
      userId: "person-b",
      happenedAt: "2025-01-10T08:00:00Z",
    }),
  ]);
  const result = buildServiceVisits(
    store,
    "tenant-a",
    { userId: "person-b" },
    now,
  );
  assert.equal(result.summary.visits, 1);
  assert.equal(result.lifetime.visits, 2);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].name, "测试乙");
  assert.deepEqual(result.availableYears, ["2026", "2025"]);
});

test("按服务端实例范围隔离，拒绝跨实例人员和归属冲突流水", () => {
  const store = fixture([
    movement("a"),
    movement("b", { userId: "person-c", deviceCode: "cab-b" }),
    movement("mismatch", { userId: "person-c" }),
    movement("unknown", { userId: "missing", deviceCode: "missing" }),
    movement("wrong-event", { eventId: "foreign-event" }),
  ]);
  store.events.push({
    ...seedEvents[0],
    eventId: "foreign-event",
    userId: "person-c",
    deviceCode: "cab-b",
  });
  const a = buildServiceVisits(store, "tenant-a", { period: "all" }, now);
  assert.equal(a.summary.visits, 1);
  assert.equal(
    a.personOptions.some((person) => person.userId === "person-c"),
    false,
  );
  assert.equal(
    buildServiceVisits(store, "tenant-b", {}, now).summary.visits,
    1,
  );
  assert.throws(
    () => buildServiceVisits(store, "tenant-a", { userId: "person-c" }, now),
    BadRequestException,
  );
  assert.throws(
    () => buildServiceVisits(store, undefined, {}, now),
    ForbiddenException,
  );
});

test("空库返回零值，旧无订单流水披露合并口径，非法筛选返回 400", () => {
  const store = fixture();
  assert.equal(
    buildServiceVisits(store, "tenant-a", {}, now).summary.visits,
    0,
  );
  store.inventory.push(
    movement("legacy-a", { orderNo: undefined }),
    movement("legacy-b", { orderNo: undefined }),
  );
  assert.equal(
    buildServiceVisits(store, "tenant-a", {}, now).legacyVisitCount,
    1,
  );
  for (const query of [
    { month: "2026-13", period: "month" },
    { year: "2027", period: "year" },
    { period: "invalid" },
  ]) {
    assert.throws(
      () => buildServiceVisits(store, "tenant-a", query as never, now),
      BadRequestException,
    );
  }
});

test("接口要求后台统计权限，实例归属来自会话而不是查询参数", () => {
  const store = fixture();
  const session = { backofficeRole: "admin", tenantId: "tenant-a" };
  let permissions: string[] = ["analytics:data-monitor:view"];
  Object.assign(store, {
    getSession: (token?: string) =>
      token === "test-admin" ? session : undefined,
    getBackofficeSessionUser: () => ({
      user: { id: "admin-a", role: "admin", name: "测试管理员" },
    }),
    getSessionUser: () => undefined,
    getBackofficeSessionPermissions: () => permissions,
    getDefaultTenantId: () => "tenant-default",
  });
  const request = {
    headers: { authorization: "Bearer test-admin" },
    query: { tenantId: "tenant-b" },
    authUser: undefined as { tenantId: string } | undefined,
  };
  const context = {
    getHandler: () => AnalyticsController.prototype.serviceVisits,
    getClass: () => AnalyticsController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new RoleGuard(new Reflector(), store);
  assert.equal(guard.canActivate(context), true);
  assert.equal(request.authUser?.tenantId, "tenant-a");
  permissions = [];
  assert.throws(() => guard.canActivate(context), ForbiddenException);
  request.headers.authorization = "";
  assert.throws(() => guard.canActivate(context), ForbiddenException);
});
