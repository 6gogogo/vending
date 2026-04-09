import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { AlertTask } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

const LOW_STOCK_THRESHOLD = 2;

@Injectable()
export class AlertsService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(status?: AlertTask["status"]) {
    this.refreshOperationalTasks();

    const alerts = status
      ? this.store.alerts.filter((alert) => alert.status === status)
      : this.store.alerts;

    return alerts
      .slice()
      .sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "open" ? -1 : 1;
        }

        return left.dueAt.localeCompare(right.dueAt);
      });
  }

  create(payload: Omit<AlertTask, "id" | "createdAt" | "status">) {
    const duplicated = this.store.alerts.find(
      (entry) =>
        entry.status === "open" &&
        entry.type === payload.type &&
        entry.deviceCode === payload.deviceCode &&
        entry.targetUserId === payload.targetUserId &&
        entry.goodsId === payload.goodsId &&
        entry.title === payload.title
    );

    if (duplicated) {
      return duplicated;
    }

    const alert: AlertTask = {
      id: this.store.createId("alert"),
      createdAt: new Date().toISOString(),
      status: "open",
      ...payload
    };

    this.store.alerts.unshift(alert);
    this.store.logOperation({
      category: "alert",
      type: "create-alert",
      status: "warning",
      actor: {
        type: "system",
        name: "系统巡检"
      },
      primarySubject: {
        type: "alert",
        id: alert.id,
        label: alert.title
      },
      secondarySubject: alert.deviceCode
        ? {
            type: "device",
            id: alert.deviceCode,
            label: alert.deviceCode
          }
        : undefined,
      metadata: {
        dueAt: alert.dueAt,
        deviceCode: alert.deviceCode,
        goodsId: alert.goodsId,
        goodsName: alert.goodsName
      }
    });
    return alert;
  }

  resolve(id: string, actorUserId?: string, note?: string) {
    const alert = this.store.alerts.find((entry) => entry.id === id);

    if (!alert) {
      throw new NotFoundException("未找到预警记录。");
    }

    alert.status = "resolved";
    alert.resolvedAt = new Date().toISOString();
    alert.resolvedByUserId = actorUserId;
    alert.resolutionNote = note;
    this.store.logOperation({
      category: "alert",
      type: "resolve-alert",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "alert",
        id: alert.id,
        label: alert.title
      },
      secondarySubject: alert.deviceCode
        ? {
            type: "device",
            id: alert.deviceCode,
            label: alert.deviceCode
          }
        : undefined,
      metadata: {
        note: note ?? ""
      }
    });
    return alert;
  }

  createFeedbackTask(payload: {
    title: string;
    detail: string;
    deviceCode?: string;
    targetUserId?: string;
  }) {
    return this.create({
      type: "user_feedback",
      title: payload.title,
      detail: payload.detail,
      deviceCode: payload.deviceCode,
      targetUserId: payload.targetUserId,
      dueAt: new Date(Date.now() + 30 * 60_000).toISOString()
    });
  }

  refreshOperationalTasks() {
    this.refreshExpiryAlerts();
    this.refreshInventoryAlerts();
    this.refreshDeviceFaultTasks();
    this.refreshLogDrivenTasks();
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
      this.create({
        type: "expiry",
        title: "投放物资即将超期",
        deviceCode: item.deviceCode,
        targetUserId: item.userId,
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        dueAt: item.expiresAt!,
        detail: `商品 ${item.goodsName} 即将超过领取期限，请及时处理。`
      });
    }
  }

  private refreshInventoryAlerts() {
    for (const device of this.store.devices) {
      for (const goods of device.doors.flatMap((door) => door.goods)) {
        const lowStockThreshold = this.store.goodsAlertPolicies
          .filter(
            (policy) =>
              policy.status === "active" && policy.applicableDeviceCodes.includes(device.deviceCode)
          )
          .flatMap((policy) => policy.thresholds)
          .filter((threshold) => threshold.goodsId === goods.goodsId)
          .at(-1)?.lowStockThreshold ?? LOW_STOCK_THRESHOLD;

        if (goods.stock <= 0) {
          this.create({
            type: "inventory",
            title: "柜机缺货提醒",
            deviceCode: device.deviceCode,
            goodsId: goods.goodsId,
            goodsName: goods.name,
            dueAt: new Date().toISOString(),
            detail: `${device.name} 的 ${goods.name} 当前库存为 0，请尽快补货。`
          });
          continue;
        }

        if (goods.stock <= lowStockThreshold) {
          this.create({
            type: "inventory",
            title: "柜机低库存提醒",
            deviceCode: device.deviceCode,
            goodsId: goods.goodsId,
            goodsName: goods.name,
            dueAt: new Date().toISOString(),
            detail: `${device.name} 的 ${goods.name} 当前库存仅剩 ${goods.stock} 件，低于模板阈值 ${lowStockThreshold} 件。`
          });
        }
      }
    }
  }

  private refreshDeviceFaultTasks() {
    for (const event of this.store.events) {
      const pendingDuration = Date.now() - new Date(event.updatedAt).getTime();
      const sourceLog = this.store.logs.find((entry) => entry.relatedEventId === event.eventId);

      if (
        ["created", "opening"].includes(event.status) &&
        pendingDuration > 90 * 1000
      ) {
        this.create({
          type: "device_fault",
          title: "开门无响应",
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: new Date(event.updatedAt).toISOString(),
          detail: `事件 ${event.orderNo} 超过 90 秒未收到成功开门确认。`,
          sourceLogId: sourceLog?.id
        });
      }

      if (event.status === "opened" && pendingDuration > 10 * 60 * 1000) {
        this.create({
          type: "device_fault",
          title: "柜门持续敞开",
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: new Date(event.updatedAt).toISOString(),
          detail: `事件 ${event.orderNo} 开门后超过 10 分钟未收到关门确认。`,
          sourceLogId: sourceLog?.id
        });
      }

      if (event.status === "failed") {
        this.create({
          type: "device_fault",
          title: "开门失败",
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: new Date(event.updatedAt).toISOString(),
          detail: `事件 ${event.orderNo} 返回 FAIL，请人工检查设备。`,
          sourceLogId: sourceLog?.id
        });
      }
    }
  }

  private refreshLogDrivenTasks() {
    for (const log of this.store.logs) {
      if (log.status === "pending" && ["remote-open-device", "open-cabinet"].includes(log.type)) {
        const pendingDuration = Date.now() - new Date(log.occurredAt).getTime();

        if (pendingDuration > 90 * 1000) {
          this.create({
            type: "device_fault",
            title: "开门无响应",
            deviceCode:
              log.primarySubject?.type === "device"
                ? log.primarySubject.id
                : log.secondarySubject?.type === "device"
                  ? log.secondarySubject.id
                  : typeof log.metadata?.deviceCode === "string"
                    ? log.metadata.deviceCode
                    : undefined,
            dueAt: log.occurredAt,
            detail: `${log.description} 超过 90 秒仍未完成，请人工确认设备状态。`,
            sourceLogId: log.id
          });
        }
      }

      if (log.status === "failed" && log.type === "door-status-callback") {
        this.create({
          type: "device_fault",
          title: "开门失败",
          deviceCode:
            log.primarySubject?.type === "device"
              ? log.primarySubject.id
              : typeof log.metadata?.deviceCode === "string"
                ? log.metadata.deviceCode
                : undefined,
          dueAt: log.occurredAt,
          detail: `${log.description}，需要人工检查柜门、电机或通信链路。`,
          sourceLogId: log.id
        });
      }
    }
  }

  private getAdminActor(actorUserId?: string) {
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
