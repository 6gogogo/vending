import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { AlertTask } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class AlertsService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(status?: AlertTask["status"]) {
    this.refreshExpiryAlerts();

    if (!status) {
      return this.store.alerts;
    }

    return this.store.alerts.filter((alert) => alert.status === status);
  }

  create(payload: Omit<AlertTask, "id" | "createdAt" | "status">) {
    const alert: AlertTask = {
      id: this.store.createId("alert"),
      createdAt: new Date().toISOString(),
      status: "open",
      ...payload
    };

    this.store.alerts.unshift(alert);
    return alert;
  }

  resolve(id: string) {
    const alert = this.store.alerts.find((entry) => entry.id === id);

    if (!alert) {
      throw new NotFoundException("未找到预警记录。");
    }

    alert.status = "resolved";
    return alert;
  }

  refreshExpiryAlerts() {
    const upcomingInventory = this.store.inventory.filter(
      (entry) =>
        entry.type === "donation" &&
        entry.expiresAt &&
        new Date(entry.expiresAt).getTime() - Date.now() < 24 * 60 * 60_000 &&
        new Date(entry.expiresAt).getTime() > Date.now()
    );

    for (const item of upcomingInventory) {
      const exists = this.store.alerts.some(
        (alert) =>
          alert.type === "expiry" &&
          alert.deviceCode === item.deviceCode &&
          alert.detail.includes(item.goodsId) &&
          alert.status === "open"
      );

      if (!exists) {
        this.create({
          type: "expiry",
          title: "投放物资即将超期",
          deviceCode: item.deviceCode,
          targetUserId: item.userId,
          dueAt: item.expiresAt!,
          detail: `商品 ${item.goodsId} 即将超过领取期限，请及时处理。`
        });
      }
    }
  }
}
