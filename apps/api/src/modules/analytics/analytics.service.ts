import { Inject, Injectable } from "@nestjs/common";

import type { DashboardSnapshot, TrendPoint } from "@vm/shared-types";

import {
  summarizeBusinessDayForUser
} from "../../common/policies/special-access-policy.utils";
import { getBusinessDayKey } from "../../common/time/business-day";
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
}
