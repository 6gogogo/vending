import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type {
  InventoryMovement,
  ServiceVisitQuery,
  ServiceVisitSnapshot,
  ServiceVisitTotals,
} from "@vm/shared-types";
import type { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import {
  addDaysToDateKey,
  getBusinessDayKey,
  getBusinessDayStartHour,
  getBusinessTimezoneOffsetHours,
} from "../../common/time/business-day";

type Visit = {
  userId: string;
  date: string;
  happenedAt: string;
  units: number;
  legacy: boolean;
};
const totals = (visits: Visit[]): ServiceVisitTotals => ({
  visits: visits.length,
  people: new Set(visits.map((visit) => visit.userId)).size,
  units: visits.reduce((sum, visit) => sum + visit.units, 0),
  activeDays: new Set(visits.map((visit) => visit.date)).size,
});
const inRange = (visits: Visit[], start: string, end: string) =>
  visits.filter((visit) => visit.date >= start && visit.date <= end);

/** 以实际领取流水为准；同次领取的商品行合并，退款及人工补记撤销抵减原领取。 */
export function buildServiceVisits(
  store: InMemoryStoreService,
  tenantId: string | undefined,
  query: ServiceVisitQuery = {},
  now = new Date(),
): ServiceVisitSnapshot {
  if (!tenantId) throw new ForbiddenException("请先进入客户实例查看服务人次。");
  const today = getBusinessDayKey(now);
  const period = query.period ?? "recent-month";
  if (
    !["all", "year", "month", "recent-month", "recent-year"].includes(period)
  ) {
    throw new BadRequestException("请选择有效的统计周期。");
  }
  const year = query.year ?? today.slice(0, 4);
  const month = query.month ?? today.slice(0, 7);
  if (
    period === "year" &&
    (!/^\d{4}$/.test(year) || year < "2000" || year > today.slice(0, 4))
  ) {
    throw new BadRequestException("请选择 2000 年至当前年份之间的年度。");
  }
  if (
    period === "month" &&
    (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      month < "2000-01" ||
      month > today.slice(0, 7))
  ) {
    throw new BadRequestException("请选择 2000 年至当前月份之间的月份。");
  }
  const users = new Map(store.users.map((user) => [user.id, user]));
  const devices = new Map(
    store.devices.map((device) => [device.deviceCode, device]),
  );
  const events = new Map(store.events.map((event) => [event.eventId, event]));
  const orderKey = (userId: string, deviceCode: string, orderNo: string) =>
    JSON.stringify([userId, deviceCode, orderNo]);
  const eventByOrder = new Map(
    store.events.map((event) => [
      orderKey(event.userId, event.deviceCode, event.orderNo),
      event.eventId,
    ]),
  );
  // 旧商品行可能没有 eventId，与同一订单的新商品行归并到同一开柜事件。
  for (const row of store.inventory) {
    if (row.eventId && row.orderNo)
      eventByOrder.set(
        orderKey(row.userId, row.deviceCode, row.orderNo),
        row.eventId,
      );
  }
  const groups = new Map<string, Visit>();
  const seen = new Set<string>();
  const belongsToTenant = (row: InventoryMovement) => {
    const user = users.get(row.userId);
    const device = devices.get(row.deviceCode);
    const event = row.eventId ? events.get(row.eventId) : undefined;
    const eventDevice = event ? devices.get(event.deviceCode) : undefined;
    const owners = [
      ...(user ? [store.getUserTenantId(user)] : []),
      ...(device ? [store.getDeviceTenantId(device)] : []),
      ...(eventDevice ? [store.getDeviceTenantId(eventDevice)] : []),
    ];
    return (
      row.userId &&
      owners.length > 0 &&
      owners.every((owner) => owner === tenantId) &&
      (!event ||
        (event.userId === row.userId && event.deviceCode === row.deviceCode))
    );
  };
  for (const row of store.inventory) {
    if (
      (row.type !== "pickup" && row.type !== "refund") ||
      row.quantity <= 0 ||
      seen.has(row.id) ||
      !belongsToTenant(row)
    )
      continue;
    seen.add(row.id);
    const sourceOrder = row.sourceOrderNo ?? row.orderNo;
    const eventId =
      row.eventId ??
      (sourceOrder
        ? eventByOrder.get(orderKey(row.userId, row.deviceCode, sourceOrder))
        : undefined);
    const identity = eventId
      ? `event:${eventId}`
      : sourceOrder
        ? `order:${sourceOrder}`
        : `time:${row.happenedAt}`;
    const key = orderKey(row.userId, row.deviceCode, identity);
    const current = groups.get(key) ?? {
      userId: row.userId,
      date: "",
      happenedAt: "",
      units: 0,
      legacy: !eventId && !sourceOrder,
    };
    current.units += row.type === "pickup" ? row.quantity : -row.quantity;
    if (
      row.type === "pickup" &&
      (!current.happenedAt || row.happenedAt < current.happenedAt)
    ) {
      current.happenedAt = row.happenedAt;
      current.date = getBusinessDayKey(row.happenedAt);
    }
    groups.set(key, current);
  }
  const allVisits = [...groups.values()].filter(
    (visit) => visit.units > 0 && visit.date && visit.date <= today,
  );
  const personIds = new Set([
    ...store.users
      .filter(
        (user) =>
          user.role === "special" && store.getUserTenantId(user) === tenantId,
      )
      .map((user) => user.id),
    ...allVisits.map((visit) => visit.userId),
  ]);
  if (query.userId && !personIds.has(query.userId))
    throw new BadRequestException("所选人员不在当前实例统计范围内。");
  const visits = allVisits.filter(
    (visit) => !query.userId || visit.userId === query.userId,
  );
  const firstDate = allVisits.reduce(
    (first, visit) => (visit.date < first ? visit.date : first),
    today,
  );
  let startDate: string;
  let endDate = today;
  switch (period) {
    case "year":
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31` < today ? `${year}-12-31` : today;
      break;
    case "month":
      startDate = `${month}-01`;
      endDate = addDaysToDateKey(`${month}-01`, 32).slice(0, 7) + "-01";
      endDate = addDaysToDateKey(endDate, -1);
      if (endDate > today) endDate = today;
      break;
    case "recent-month":
      startDate = addDaysToDateKey(today, -29);
      break;
    case "recent-year":
      startDate = addDaysToDateKey(today, -364);
      break;
    default:
      startDate = firstDate;
  }
  const selected = inRange(visits, startDate, endDate);
  const days =
    Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  const grain =
    period === "month" || period === "recent-month"
      ? "day"
      : days > 1096
        ? "year"
        : "month";
  const buckets = new Map<string, Visit[]>();
  for (const visit of selected) {
    const key =
      grain === "day"
        ? visit.date
        : visit.date.slice(0, grain === "month" ? 7 : 4);
    const bucket = buckets.get(key) ?? [];
    bucket.push(visit);
    buckets.set(key, bucket);
  }
  const keys: string[] = [];
  if (grain === "day") {
    for (let index = 0; index < days; index++)
      keys.push(addDaysToDateKey(startDate, index));
  } else if (grain === "year") {
    for (
      let value = Number(startDate.slice(0, 4));
      value <= Number(endDate.slice(0, 4));
      value++
    )
      keys.push(String(value));
  } else {
    for (
      let key = startDate.slice(0, 7);
      key <= endDate.slice(0, 7);
      key = addDaysToDateKey(`${key}-01`, 32).slice(0, 7)
    )
      keys.push(key);
  }
  const personalVisits = new Map<string, Visit[]>();
  const lifetimeCounts = new Map<string, number>();
  for (const visit of selected) {
    const bucket = personalVisits.get(visit.userId) ?? [];
    bucket.push(visit);
    personalVisits.set(visit.userId, bucket);
  }
  for (const visit of visits)
    lifetimeCounts.set(
      visit.userId,
      (lifetimeCounts.get(visit.userId) ?? 0) + 1,
    );
  const people = [...personIds]
    .filter((id) => !query.userId || id === query.userId)
    .map((userId) => {
      const personal = personalVisits.get(userId) ?? [];
      const summary = totals(personal);
      const user = users.get(userId);
      return {
        userId,
        name: user?.name ?? "历史领取人员",
        neighborhood: user?.neighborhood ?? "未分配社区",
        visits: personal.length,
        lifetimeVisits: lifetimeCounts.get(userId) ?? 0,
        units: summary.units,
        activeDays: summary.activeDays,
        lastPickupAt: personal.reduce<string | undefined>(
          (last, visit) =>
            !last || visit.happenedAt > last ? visit.happenedAt : last,
          undefined,
        ),
      };
    })
    .sort(
      (a, b) =>
        b.visits - a.visits ||
        b.lifetimeVisits - a.lifetimeVisits ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
  const previousEnd = addDaysToDateKey(startDate, -1);
  const previousStart = addDaysToDateKey(startDate, -days);
  return {
    period,
    startDate,
    endDate,
    today,
    generatedAt: now.toISOString(),
    grain,
    businessDayStartHour: getBusinessDayStartHour(),
    timezoneOffsetHours: getBusinessTimezoneOffsetHours(),
    summary: totals(selected),
    lifetime: totals(visits),
    previous:
      period === "all"
        ? undefined
        : {
            ...totals(inRange(visits, previousStart, previousEnd)),
            startDate: previousStart,
            endDate: previousEnd,
          },
    series: keys.map((key) => ({
      key,
      label:
        grain === "day"
          ? key.slice(5).replace("-", "/")
          : grain === "month"
            ? key.replace("-", "/")
            : `${key}年`,
      ...totals(buckets.get(key) ?? []),
    })),
    people,
    personOptions: [...personIds]
      .map((userId) => ({
        userId,
        name: users.get(userId)?.name ?? "历史领取人员",
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    availableYears: Array.from(
      { length: Number(today.slice(0, 4)) - Number(firstDate.slice(0, 4)) + 1 },
      (_, index) => String(Number(today.slice(0, 4)) - index),
    ),
    legacyVisitCount: selected.filter((visit) => visit.legacy).length,
  };
}
