import { Inject, Injectable } from "@nestjs/common";

import type { DashboardSnapshot, GoodsCategory, TrendPoint } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AlertsService) private readonly alertsService: AlertsService
  ) {}

  getDashboard(): DashboardSnapshot {
    const openAlerts = this.alertsService.list("open").slice(0, 5);
    const demandByCategory = (["food", "drink", "daily"] as GoodsCategory[]).map((category) => ({
      category,
      count: this.store.inventory
        .filter((entry) => entry.type === "pickup" && entry.category === category)
        .reduce((sum, entry) => sum + entry.quantity, 0)
    }));

    return {
      stats: {
        activeSpecialUsers: this.store.users.filter(
          (user) => user.role === "special" && user.status === "active"
        ).length,
        activeMerchants: this.store.users.filter(
          (user) => user.role === "merchant" && user.status === "active"
        ).length,
        todayOpenEvents: this.store.events.filter(
          (event) => new Date(event.createdAt).toDateString() === new Date().toDateString()
        ).length,
        pendingAlerts: openAlerts.length,
        donatedUnits: this.store.inventory
          .filter((entry) => entry.type === "donation")
          .reduce((sum, entry) => sum + entry.quantity, 0),
        pickedUnits: this.store.inventory
          .filter((entry) => entry.type === "pickup")
          .reduce((sum, entry) => sum + entry.quantity, 0)
      },
      demandByCategory,
      weeklyTrend: this.buildWeeklyTrend(),
      openAlerts
    };
  }

  getPersonaPlaceholders() {
    return this.store.users
      .filter((user) => user.role === "special")
      .map((user) => ({
        userId: user.id,
        name: user.name,
        tags: user.tags,
        mostNeededCategory:
          this.store.inventory.find((entry) => entry.userId === user.id && entry.type === "pickup")
            ?.category ?? "food"
      }));
  }

  getLayoutSuggestions() {
    return this.store.devices.map((device) => ({
      deviceCode: device.deviceCode,
      location: device.location,
      recommendation:
        device.status === "online"
          ? "建议保持当前点位启用状态，并根据近期领取情况动态调整食品与饮料配比。"
          : "建议先排查设备在线状态，再决定后续投放计划。"
    }));
  }

  private buildWeeklyTrend(): TrendPoint[] {
    const points: TrendPoint[] = [];

    for (let index = 6; index >= 0; index -= 1) {
      const day = new Date();
      day.setDate(day.getDate() - index);
      const key = day.toDateString();

      points.push({
        label: day.toISOString().slice(5, 10),
        pickups: this.store.inventory
          .filter((entry) => entry.type === "pickup" && new Date(entry.happenedAt).toDateString() === key)
          .reduce((sum, entry) => sum + entry.quantity, 0),
        donations: this.store.inventory
          .filter((entry) => entry.type === "donation" && new Date(entry.happenedAt).toDateString() === key)
          .reduce((sum, entry) => sum + entry.quantity, 0)
      });
    }

    return points;
  }
}
