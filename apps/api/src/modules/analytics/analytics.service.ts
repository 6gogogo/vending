import { Inject, Injectable } from "@nestjs/common";

import type {
  DataMonitorDailySummary,
  DataMonitorMetricBar,
  DataMonitorRange,
  DataMonitorRangePoint,
  DataMonitorRegionBreakdown,
  DataMonitorSnapshot,
  DashboardSnapshot,
  TrendPoint
} from "@vm/shared-types";

import {
  summarizeBusinessDayForUser
} from "../../common/policies/special-access-policy.utils";
import { addDaysToDateKey, getBusinessDayKey, getWeekdayForDateKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";
import { GoodsService } from "../goods/goods.service";

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(GoodsService) private readonly goodsService: GoodsService
  ) {}

  getDashboard(): DashboardSnapshot {
    const businessDateKey = getBusinessDayKey(new Date());
    const activeSpecialUsers = this.store.users.filter(
      (user) => user.role === "special" && user.status === "active"
    );
    const usersWithPolicies = activeSpecialUsers
      .map((user) => {
        const summary = summarizeBusinessDayForUser(
          user,
          this.store.specialAccessPolicies,
          this.store.inventory,
          this.store.goodsCatalog,
          businessDateKey
        );

        return {
          user,
          summary
        };
      })
      .filter((entry) => entry.summary.totalGoods > 0);
    // 总览不只统计“做了多少”，还要把今天尚未被服务到的人明确找出来。
    const allPendingTasks = this.alertsService
      .list("open")
      .slice()
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const pendingTasks = allPendingTasks.slice(0, 12);
    const goodsOverview = this.goodsService.getOverview();

    const mapPerson = (entry: (typeof usersWithPolicies)[number]) => ({
      userId: entry.user.id,
      name: entry.user.name,
      phone: entry.user.phone,
      neighborhood: entry.user.neighborhood,
      completionStatus: entry.summary.completionStatus,
      fulfilledGoods: entry.summary.fulfilledGoods,
      totalGoods: entry.summary.totalGoods,
      summary: `已领取 ${entry.summary.fulfilledGoods}/${entry.summary.totalGoods} 件应领物资`,
      detailLines: entry.summary.windows.map((window) => {
        const rangeLabel = `${String(window.startHour).padStart(2, "0")}:00-${String(window.endHour).padStart(2, "0")}:00`;
        const goodsLabel = window.goodsUsage
          .map((usage) => `${usage.goodsName} ${Math.min(usage.usedQuantity, usage.quantityLimit)}/${usage.quantityLimit}`)
          .join("，");

        return `${rangeLabel} ${goodsLabel}`;
      })
    });

    const completeUsers = usersWithPolicies
      .filter((entry) => entry.summary.completionStatus === "complete")
      .map(mapPerson);
    const partialUsers = usersWithPolicies
      .filter((entry) => entry.summary.completionStatus === "partial")
      .map(mapPerson);
    // “未服务人数”是街道最需要优先关注的名单，所以这里单独聚合并保留可展开明细。
    const unservedUsers = usersWithPolicies
      .filter((entry) => entry.summary.completionStatus === "unserved")
      .map(mapPerson);

    return {
      businessDateKey,
      stats: {
        completeUsers: completeUsers.length,
        partialUsers: partialUsers.length,
        unservedUsers: unservedUsers.length,
        pendingTasks: pendingTasks.length,
        lowStockKinds: goodsOverview.lowStockKinds,
        outOfStockKinds: goodsOverview.outOfStockKinds
      },
      weeklyTrend: this.buildWeeklyTrend(),
      taskGradeSummary: {
        fault: allPendingTasks.filter((entry) => entry.grade === "fault").length,
        feedback: allPendingTasks.filter((entry) => entry.grade === "feedback").length,
        warning: allPendingTasks.filter((entry) => entry.grade === "warning").length
      },
      serviceOverview: {
        completeUsers: {
          count: completeUsers.length,
          users: completeUsers
        },
        partialUsers: {
          count: partialUsers.length,
          users: partialUsers
        },
        unservedUsers: {
          count: unservedUsers.length,
          users: unservedUsers
        },
        totalUsers: usersWithPolicies.length
      },
      pendingTasks,
      goodsOverview,
      summaryLogs: [...this.store.logs]
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 14)
    };
  }

  getPersonaPlaceholders() {
    return [
      {
        id: "persona-special-user",
        title: "特殊群体领取人",
        summary: "关注业务日内的时段配额完成情况、待服务名单和领取异常。"
      },
      {
        id: "persona-merchant",
        title: "爱心商户",
        summary: "关注补货、临期处理、缺货提醒和柜机货品同步。"
      },
      {
        id: "persona-admin",
        title: "街道管理员",
        summary: "关注待处理事件、设备故障、人员配置和远程操作记录。"
      }
    ];
  }

  getLayoutSuggestions() {
    return [
      "总览页优先展示今日完全服务、部分服务、未服务和待处理事件四个指标。",
      "待处理事件与货物总览需要固定在首屏，并支持跳转到人员、柜机和日志详情。",
      "日志面板应优先显示动作句式，主体对象通过链接跳转到对应详情页。"
    ];
  }

  getDataMonitor(query?: { month?: string; date?: string; range?: DataMonitorRange }): DataMonitorSnapshot {
    const fallbackDateKey = getBusinessDayKey(new Date());
    const selectedDateKey = query?.date ?? fallbackDateKey;
    const currentMonth = query?.month ?? selectedDateKey.slice(0, 7);
    const range = query?.range ?? "today";
    const dayActivity = this.buildDayActivityMap();
    const rangeDateKeys = this.buildRangeDateKeys(selectedDateKey, range);
    const rangeSeries = rangeDateKeys.map((dateKey) => this.buildRangePoint(dateKey));
    const selectedDateSummary = this.buildDataMonitorDailySummary(selectedDateKey);
    const periodSummary = this.buildDataMonitorAggregateSummary(rangeDateKeys);
    const rangeSummary = this.buildRangeSummary(periodSummary);

    return {
      monthKey: currentMonth,
      selectedDateKey,
      range,
      days: this.buildMonthCalendar(currentMonth, dayActivity),
      selectedDateSummary,
      periodSummary,
      rangeStartDateKey: rangeDateKeys[0] ?? selectedDateKey,
      rangeEndDateKey: rangeDateKeys[rangeDateKeys.length - 1] ?? selectedDateKey,
      rangeSeries,
      rangeSummary,
      regionBreakdown: this.buildRegionBreakdown(rangeDateKeys)
    };
  }

  private buildWeeklyTrend(): TrendPoint[] {
    const points: TrendPoint[] = [];

    for (let index = 6; index >= 0; index -= 1) {
      const day = new Date();
      day.setDate(day.getDate() - index);
      const key = getBusinessDayKey(day);

      points.push({
        label: key.slice(5),
        pickups: this.store.inventory
          .filter((entry) => entry.type === "pickup" && getBusinessDayKey(entry.happenedAt) === key)
          .reduce((sum, entry) => sum + entry.quantity, 0),
        donations: this.store.inventory
          .filter((entry) => entry.type === "donation" && getBusinessDayKey(entry.happenedAt) === key)
          .reduce((sum, entry) => sum + entry.quantity, 0)
      });
    }

    return points;
  }

  private buildDayActivityMap() {
    const counts = new Map<string, number>();
    const increase = (dateKey: string, amount = 1) => {
      counts.set(dateKey, (counts.get(dateKey) ?? 0) + amount);
    };

    this.store.inventory.forEach((entry) => increase(getBusinessDayKey(entry.happenedAt), entry.quantity));
    this.store.events.forEach((entry) => increase(getBusinessDayKey(entry.createdAt)));
    this.store.logs.forEach((entry) => increase(getBusinessDayKey(entry.occurredAt)));
    this.store.alerts.forEach((entry) => increase(getBusinessDayKey(entry.createdAt)));
    this.store.inventoryTransfers.forEach((entry) => increase(getBusinessDayKey(entry.happenedAt), entry.quantity));
    this.store.stocktakes.forEach((entry) => increase(getBusinessDayKey(entry.createdAt), entry.items.length));

    return counts;
  }

  private buildMonthCalendar(monthKey: string, activityMap: Map<string, number>) {
    const [year, month] = monthKey.split("-").map(Number);
    const firstDay = `${year}-${String(month).padStart(2, "0")}-01`;
    const firstWeekday = getWeekdayForDateKey(firstDay);
    const leadingDays = firstWeekday === 0 ? 6 : firstWeekday - 1;
    const calendarStart = addDaysToDateKey(firstDay, -leadingDays);

    return Array.from({ length: 42 }, (_, index) => {
      const dateKey = addDaysToDateKey(calendarStart, index);
      const activityCount = activityMap.get(dateKey) ?? 0;
      const activityLevel: "none" | "light" | "medium" | "high" =
        activityCount <= 0
          ? "none"
          : activityCount <= 3
            ? "light"
            : activityCount <= 8
              ? "medium"
              : "high";

      return {
        dateKey,
        day: Number(dateKey.slice(-2)),
        inCurrentMonth: dateKey.startsWith(monthKey),
        hasData: activityCount > 0,
        activityLevel
      };
    });
  }

  private buildRangeDateKeys(selectedDateKey: string, range: DataMonitorRange) {
    if (range === "today") {
      return [selectedDateKey];
    }

    const offset = range === "3d" ? 1 : 3;
    const startDateKey = addDaysToDateKey(selectedDateKey, -offset);

    return Array.from({ length: offset * 2 + 1 }, (_, index) =>
      addDaysToDateKey(startDateKey, index)
    );
  }

  private buildRangePoint(dateKey: string): DataMonitorRangePoint {
    const summary = this.buildDataMonitorDailySummary(dateKey);

    return {
      dateKey,
      label: dateKey.slice(5),
      servedUsers: summary.servedUsers,
      pickupUnits: summary.pickupUnits,
      restockUnits: summary.restockUnits,
      transferUnits: summary.transferUnits,
      eventCount: summary.eventCount,
      feedbackResolvedCount: summary.feedbackResolvedCount,
      logCount: summary.logCount
    };
  }

  private buildRangeSummary(summary: DataMonitorDailySummary): DataMonitorSnapshot["rangeSummary"] {
    return {
      servedUsers: summary.servedUsers,
      pickupUnits: summary.pickupUnits,
      restockUnits: summary.restockUnits,
      transferUnits: summary.transferUnits,
      eventCount: summary.eventCount,
      feedbackResolvedCount: summary.feedbackResolvedCount,
      logCount: summary.logCount
    };
  }

  private buildRegionBreakdown(dateKeys: string[]): DataMonitorRegionBreakdown[] {
    const dateKeySet = new Set(dateKeys);
    const userMap = new Map(this.store.users.map((entry) => [entry.id, entry]));
    const regionById = new Map(this.store.regions.map((entry) => [entry.id, entry]));
    const regionByName = new Map(this.store.regions.map((entry) => [entry.name, entry]));
    const regions = new Map<
      string,
      {
        regionId?: string;
        regionName: string;
        longitude?: number;
        latitude?: number;
        servedUsers: Set<string>;
        pickupUnits: number;
        pickupTimes: number;
        firstPickupAt?: string;
        lastPickupAt?: string;
        hourCounts: Map<number, number>;
        timeBars: Record<"morning" | "midday" | "afternoon" | "night", number>;
      }
    >();

    const ensureRegion = (regionId: string | undefined, regionName: string) => {
      const key = regionId ?? `name:${regionName}`;
      const existing = regions.get(key);

      if (existing) {
        return existing;
      }

      const matchedRegion =
        (regionId ? regionById.get(regionId) : undefined) ?? regionByName.get(regionName);
      const created = {
        regionId: matchedRegion?.id ?? regionId,
        regionName: matchedRegion?.name ?? regionName,
        longitude: matchedRegion?.longitude,
        latitude: matchedRegion?.latitude,
        servedUsers: new Set<string>(),
        pickupUnits: 0,
        pickupTimes: 0,
        firstPickupAt: undefined as string | undefined,
        lastPickupAt: undefined as string | undefined,
        hourCounts: new Map<number, number>(),
        timeBars: {
          morning: 0,
          midday: 0,
          afternoon: 0,
          night: 0
        }
      };

      regions.set(key, created);
      return created;
    };

    this.store.inventory
      .filter(
        (entry) =>
          (entry.type === "pickup" ||
            entry.type === "adjustment" ||
            entry.type === "manual-deduction") &&
          dateKeySet.has(getBusinessDayKey(entry.happenedAt))
      )
      .forEach((entry) => {
        const user = entry.userId ? userMap.get(entry.userId) : undefined;
        const regionName = user?.regionName ?? user?.neighborhood ?? "未分配区域";
        const regionId = user?.regionId;
        const bucket = ensureRegion(regionId, regionName);
        const hour = new Date(entry.happenedAt).getHours();
        const hourCount = bucket.hourCounts.get(hour) ?? 0;

        if (entry.userId) {
          bucket.servedUsers.add(entry.userId);
        }

        bucket.pickupUnits += entry.quantity;
        bucket.pickupTimes += 1;
        bucket.hourCounts.set(hour, hourCount + entry.quantity);

        if (!bucket.firstPickupAt || entry.happenedAt < bucket.firstPickupAt) {
          bucket.firstPickupAt = entry.happenedAt;
        }

        if (!bucket.lastPickupAt || entry.happenedAt > bucket.lastPickupAt) {
          bucket.lastPickupAt = entry.happenedAt;
        }

        if (hour >= 4 && hour < 10) {
          bucket.timeBars.morning += entry.quantity;
        } else if (hour >= 10 && hour < 14) {
          bucket.timeBars.midday += entry.quantity;
        } else if (hour >= 14 && hour < 18) {
          bucket.timeBars.afternoon += entry.quantity;
        } else {
          bucket.timeBars.night += entry.quantity;
        }
      });

    return Array.from(regions.values())
      .map((entry) => {
        const peakHour = Array.from(entry.hourCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];

        return {
          regionId: entry.regionId,
          regionName: entry.regionName,
          longitude: entry.longitude,
          latitude: entry.latitude,
          servedUsers: entry.servedUsers.size,
          pickupUnits: entry.pickupUnits,
          pickupTimes: entry.pickupTimes,
          firstPickupAt: entry.firstPickupAt,
          lastPickupAt: entry.lastPickupAt,
          peakHourLabel: peakHour === undefined ? undefined : `${String(peakHour).padStart(2, "0")}:00`,
          timeBars: [
            { key: "morning" as const, label: "清晨", value: entry.timeBars.morning },
            { key: "midday" as const, label: "午间", value: entry.timeBars.midday },
            { key: "afternoon" as const, label: "下午", value: entry.timeBars.afternoon },
            { key: "night" as const, label: "夜间", value: entry.timeBars.night }
          ]
        };
      })
      .sort((left, right) => right.pickupUnits - left.pickupUnits || right.servedUsers - left.servedUsers);
  }

  private buildDataMonitorDailySummary(dateKey: string): DataMonitorDailySummary {
    return this.buildDataMonitorAggregateSummary([dateKey], dateKey);
  }

  private buildDataMonitorAggregateSummary(dateKeys: string[], businessDateKey?: string): DataMonitorDailySummary {
    const dateKeySet = new Set(dateKeys);
    const inventory = this.store.inventory.filter(
      (entry) => dateKeySet.has(getBusinessDayKey(entry.happenedAt))
    );
    const events = this.store.events.filter((entry) => dateKeySet.has(getBusinessDayKey(entry.createdAt)));
    const logs = this.store.logs.filter((entry) => dateKeySet.has(getBusinessDayKey(entry.occurredAt)));
    const resolvedFeedbacks = this.store.alerts.filter(
      (entry) =>
        entry.grade === "feedback" &&
        entry.status === "resolved" &&
        entry.resolvedAt &&
        dateKeySet.has(getBusinessDayKey(entry.resolvedAt))
    );
    const transfers = this.store.inventoryTransfers.filter(
      (entry) => dateKeySet.has(getBusinessDayKey(entry.happenedAt))
    );
    const stocktakes = this.store.stocktakes.filter(
      (entry) => dateKeySet.has(getBusinessDayKey(entry.createdAt))
    );

    const pickupInventory = inventory.filter(
      (entry) =>
        entry.type === "pickup" ||
        entry.type === "adjustment" ||
        entry.type === "manual-deduction"
    );
    const restockInventory = inventory.filter(
      (entry) => entry.type === "donation" || entry.type === "manual-restock"
    );
    const servedUsers = new Set(
      pickupInventory.map((entry) => entry.userId).filter((entry): entry is string => Boolean(entry))
    ).size;
    const pickupUnits = pickupInventory.reduce((sum, entry) => sum + entry.quantity, 0);
    const restockUnits = restockInventory.reduce((sum, entry) => sum + entry.quantity, 0);
    const transferUnits = transfers.reduce((sum, entry) => sum + entry.quantity, 0);
    const eventCount = events.length;
    const feedbackResolvedCount = resolvedFeedbacks.length;
    const logCount = logs.length + stocktakes.length;

    const metricBars: DataMonitorMetricBar[] = [
      { key: "servedUsers", label: "服务人数", value: servedUsers, unit: "人" },
      { key: "pickupUnits", label: "领取件数", value: pickupUnits, unit: "件" },
      { key: "restockUnits", label: "补货件数", value: restockUnits, unit: "件" },
      { key: "transferUnits", label: "调拨件数", value: transferUnits, unit: "件" },
      { key: "eventCount", label: "开柜事件", value: eventCount, unit: "次" },
      { key: "feedbackResolvedCount", label: "完成反馈数", value: feedbackResolvedCount, unit: "项" },
      { key: "logCount", label: "日志数量", value: logCount, unit: "条" }
    ];

    const topGoods = Array.from(
      [...inventory, ...transfers.map((entry) => ({
        goodsId: entry.goodsId,
        goodsName: entry.goodsName,
        quantity: entry.quantity
      }))].reduce((map, entry) => {
        const current = map.get(entry.goodsId) ?? {
          goodsId: entry.goodsId,
          goodsName: entry.goodsName,
          quantity: 0
        };
        current.quantity += entry.quantity;
        map.set(entry.goodsId, current);
        return map;
      }, new Map<string, { goodsId: string; goodsName: string; quantity: number }>())
    )
      .map(([, value]) => value)
      .sort((left, right) => right.quantity - left.quantity)
      .slice(0, 8);

    const topDevices = Array.from(
      [...inventory, ...transfers.map((entry) => ({
        deviceCode: entry.toCode,
        type: "transfer" as const,
        quantity: entry.quantity
      }))].reduce((map, entry) => {
        const deviceName =
          this.store.devices.find((device) => device.deviceCode === entry.deviceCode)?.name ??
          entry.deviceCode;
        const current = map.get(entry.deviceCode) ?? {
          deviceCode: entry.deviceCode,
          deviceName,
          pickupUnits: 0,
          restockUnits: 0,
          eventCount: 0
        };

        if (entry.type === "pickup") {
          current.pickupUnits += entry.quantity;
        } else if (
          entry.type === "adjustment" ||
          entry.type === "manual-deduction"
        ) {
          current.pickupUnits += entry.quantity;
        } else if (
          entry.type === "donation" ||
          entry.type === "manual-restock" ||
          entry.type === "transfer"
        ) {
          current.restockUnits += entry.quantity;
        }

        map.set(entry.deviceCode, current);
        return map;
      }, new Map<string, { deviceCode: string; deviceName: string; pickupUnits: number; restockUnits: number; eventCount: number }>())
    ).map(([, value]) => value);

    events.forEach((entry) => {
      const existing = topDevices.find((device) => device.deviceCode === entry.deviceCode);

      if (existing) {
        existing.eventCount += 1;
        return;
      }

      topDevices.push({
        deviceCode: entry.deviceCode,
        deviceName:
          this.store.devices.find((device) => device.deviceCode === entry.deviceCode)?.name ??
          entry.deviceCode,
        pickupUnits: 0,
        restockUnits: 0,
        eventCount: 1
      });
    });

    topDevices.sort(
      (left, right) =>
        right.pickupUnits +
          right.restockUnits +
          right.eventCount -
        (left.pickupUnits + left.restockUnits + left.eventCount)
    );

    return {
      businessDateKey: businessDateKey ?? dateKeys[0] ?? getBusinessDayKey(new Date()),
      servedUsers,
      pickupUnits,
      restockUnits,
      transferUnits,
      eventCount,
      feedbackResolvedCount,
      logCount,
      metricBars,
      topGoods,
      topDevices: topDevices.slice(0, 8),
      recentLogs: logs
        .slice()
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 10)
    };
  }
}
