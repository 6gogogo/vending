import { Inject, Injectable } from "@nestjs/common";

import type {
  DataMonitorDailySummary,
  DataMonitorMetricBar,
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
      summary: `已领取 ${entry.summary.fulfilledGoods}/${entry.summary.totalGoods} 件应领物资`
    });

    const completeUsers = usersWithPolicies
      .filter((entry) => entry.summary.completionStatus === "complete")
      .map(mapPerson);
    const partialUsers = usersWithPolicies
      .filter((entry) => entry.summary.completionStatus === "partial")
      .map(mapPerson);
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

  getDataMonitor(query?: { month?: string; date?: string }): DataMonitorSnapshot {
    const currentMonth = query?.month ?? getBusinessDayKey(new Date()).slice(0, 7);
    const selectedDateKey = query?.date ?? `${currentMonth}-01`;
    const dayActivity = this.buildDayActivityMap();

    return {
      monthKey: currentMonth,
      selectedDateKey,
      days: this.buildMonthCalendar(currentMonth, dayActivity),
      selectedDateSummary: this.buildDataMonitorDailySummary(selectedDateKey)
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

  private buildDataMonitorDailySummary(dateKey: string): DataMonitorDailySummary {
    const inventory = this.store.inventory.filter(
      (entry) => getBusinessDayKey(entry.happenedAt) === dateKey
    );
    const events = this.store.events.filter((entry) => getBusinessDayKey(entry.createdAt) === dateKey);
    const logs = this.store.logs.filter((entry) => getBusinessDayKey(entry.occurredAt) === dateKey);
    const tasks = this.store.alerts.filter((entry) => getBusinessDayKey(entry.createdAt) === dateKey);
    const transfers = this.store.inventoryTransfers.filter(
      (entry) => getBusinessDayKey(entry.happenedAt) === dateKey
    );
    const stocktakes = this.store.stocktakes.filter(
      (entry) => getBusinessDayKey(entry.createdAt) === dateKey
    );

    const pickupInventory = inventory.filter((entry) => entry.type === "pickup");
    const restockInventory = inventory.filter(
      (entry) => entry.type === "donation" || entry.type === "manual-restock"
    );
    const adjustmentInventory = inventory.filter(
      (entry) =>
        entry.type === "adjustment" ||
        entry.type === "manual-deduction" ||
        entry.type === "refund"
    );

    const servedUsers = new Set(
      pickupInventory.map((entry) => entry.userId).filter((entry): entry is string => Boolean(entry))
    ).size;
    const pickupUnits = pickupInventory.reduce((sum, entry) => sum + entry.quantity, 0);
    const restockUnits =
      restockInventory.reduce((sum, entry) => sum + entry.quantity, 0) +
      transfers.reduce((sum, entry) => sum + entry.quantity, 0);
    const adjustmentUnits = adjustmentInventory.reduce((sum, entry) => sum + entry.quantity, 0);
    const eventCount = events.length;
    const taskCount = tasks.length;
    const logCount = logs.length + stocktakes.length;

    const metricBars: DataMonitorMetricBar[] = [
      { key: "servedUsers", label: "服务人数", value: servedUsers, unit: "人" },
      { key: "pickupUnits", label: "领取件数", value: pickupUnits, unit: "件" },
      { key: "restockUnits", label: "补货与调拨", value: restockUnits, unit: "件" },
      { key: "adjustmentUnits", label: "补扣与退款", value: adjustmentUnits, unit: "件" },
      { key: "eventCount", label: "开柜事件", value: eventCount, unit: "次" },
      { key: "taskCount", label: "新增待办", value: taskCount, unit: "项" },
      { key: "logCount", label: "日志数量", value: logCount, unit: "条" }
    ];

    const topGoods = Array.from(
      inventory.reduce((map, entry) => {
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
      inventory.reduce((map, entry) => {
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
        } else if (entry.type === "donation" || entry.type === "manual-restock") {
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
      businessDateKey: dateKey,
      servedUsers,
      pickupUnits,
      restockUnits,
      adjustmentUnits,
      eventCount,
      taskCount,
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
