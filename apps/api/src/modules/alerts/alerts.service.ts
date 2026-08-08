import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { AlertGrade, AlertTask } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

const RECOVERABLE_CALLBACK_ALERT_TITLES = new Set([
  "预约取货完成状态回写平台失败",
  "公益领取完成状态回写平台失败",
  "付款成功回写平台失败"
]);

@Injectable()
export class AlertsService {
  private readonly feedbackSubmissionHistory = new Map<string, number[]>();

  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(status?: AlertTask["status"], targetUserId?: string) {
    const recoveredCallbackCount = this.resolveRecoveredCallbackFailures();
    this.refreshOperationalTasks();
    this.store.refreshAlertPresentation();
    if (recoveredCallbackCount > 0) {
      this.store.persist();
    }

    const alerts = this.store.alerts.filter((alert) => {
      if (status && alert.status !== status) {
        return false;
      }

      if (targetUserId && alert.targetUserId !== targetUserId) {
        return false;
      }

      return true;
    });

    const statusWeight: Record<AlertTask["status"], number> = {
      open: 0,
      acknowledged: 1,
      resolved: 2
    };

    return alerts
      .slice()
      .sort((left, right) => {
        if (left.status !== right.status) {
          return statusWeight[left.status] - statusWeight[right.status];
        }

        return left.dueAt.localeCompare(right.dueAt);
      });
  }

  resolveRecoveredCallbackFailures(relatedEventId?: string) {
    const resolvedAt = new Date().toISOString();
    let resolvedCount = 0;

    for (const alert of this.store.alerts) {
      if (
        alert.status === "resolved" ||
        alert.type !== "callback" ||
        !alert.relatedEventId ||
        (relatedEventId && alert.relatedEventId !== relatedEventId) ||
        !RECOVERABLE_CALLBACK_ALERT_TITLES.has(alert.title)
      ) {
        continue;
      }

      const orderNo = /(?:^|；)订单 (\S+) 回写平台/.exec(alert.detail)?.[1];
      const event = this.store.events.find(
        (entry) => entry.eventId === alert.relatedEventId
      );
      if (!orderNo || !event) {
        continue;
      }

      const paymentNotifyStatus =
        event.orderNo === orderNo
          ? event.paymentNotifyStatus
          : event.adjustments?.find((entry) => entry.orderNo === orderNo)
              ?.paymentNotifyStatus;
      if (paymentNotifyStatus !== "success") {
        continue;
      }

      alert.status = "resolved";
      alert.resolvedAt = resolvedAt;
      alert.resolutionNote = "平台回写已成功，系统自动关闭历史故障。";
      this.store.decorateAlert(alert);
      this.store.logOperation({
        category: "alert",
        type: "resolve-alert",
        status: "success",
        actor: {
          type: "system",
          name: "平台回写恢复"
        },
        primarySubject: {
          type: "alert",
          id: alert.id,
          label: alert.title
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: orderNo
        },
        description: `订单 ${orderNo} 的平台回写已恢复，历史故障已自动关闭。`,
        relatedEventId: event.eventId,
        relatedOrderNo: orderNo,
        metadata: {
          recoverySource: "payment-notify-success",
          undoState: "not_undoable"
        }
      });
      resolvedCount += 1;
    }

    return resolvedCount;
  }

  create(payload: Omit<AlertTask, "id" | "createdAt" | "status" | "grade"> & { grade?: AlertGrade }) {
    const duplicated = this.findDuplicateTask(payload);

    if (duplicated) {
      return duplicated;
    }

    const alert: AlertTask = {
      id: this.store.createId("alert"),
      createdAt: new Date().toISOString(),
      status: "open",
      grade: payload.grade ?? this.resolveGrade(payload.type),
      ...payload
    };

    this.store.alerts.unshift(alert);
    this.store.decorateAlert(alert);
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
            label: this.getDeviceLabel(alert.deviceCode)
          }
        : undefined,
      metadata: {
        dueAt: alert.dueAt,
        deviceCode: alert.deviceCode,
        goodsId: alert.goodsId,
        goodsName: alert.goodsName,
        grade: alert.grade,
        relatedEventId: alert.relatedEventId,
        undoState: "not_undoable"
      }
    });
    return alert;
  }

  resolve(id: string, actorUserId?: string, note?: string) {
    const alert = this.store.alerts.find((entry) => entry.id === id);

    if (!alert) {
      throw new NotFoundException("未找到预警记录。");
    }

    alert.status = alert.grade === "fault" ? "acknowledged" : "resolved";
    alert.resolvedAt = new Date().toISOString();
    alert.resolvedByUserId = actorUserId;
    alert.resolutionNote = note;
    if (alert.type === "user_feedback" && alert.targetUserId) {
      alert.userNoticeStatus = "pending";
      alert.userNoticeTitle = "反馈处理结果";
      alert.userNoticeContent = this.buildFeedbackUserNotice(alert, note);
      alert.userNotifiedAt = undefined;
    }
    this.store.decorateAlert(alert);
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
            label: this.getDeviceLabel(alert.deviceCode)
          }
        : undefined,
      metadata: {
        note: note ?? "",
        grade: alert.grade,
        action: alert.grade === "fault" ? "acknowledge" : "resolve",
        undoState: "not_undoable"
      }
    });
    return alert;
  }

  private buildFeedbackUserNotice(alert: AlertTask, note?: string) {
    const feedbackType = alert.feedbackType ? `${alert.feedbackType}反馈` : "反馈";
    const adminNote = note?.trim();

    return adminNote
      ? `工作人员已处理你的${feedbackType}：${adminNote}。若问题仍存在，可继续补充反馈。`
      : `工作人员已处理你的${feedbackType}。若问题仍存在，可继续补充反馈。`;
  }

  createFeedbackTask(payload: {
    title?: string;
    detail: string;
    deviceCode?: string;
    targetUserId?: string;
    feedbackType?: "机器故障" | "服务问题" | "其他";
    sourceKey?: string;
  }) {
    const trimmedDetail = payload.detail.trim();

    if (trimmedDetail.length < 5 || trimmedDetail.length > 1_000) {
      throw new BadRequestException("反馈内容需为 5 至 1000 个字符。");
    }

    if (payload.title && payload.title.trim().length > 100) {
      throw new BadRequestException("反馈标题不能超过 100 个字符。");
    }

    if (
      payload.deviceCode &&
      !this.store.devices.some((entry) => entry.deviceCode === payload.deviceCode)
    ) {
      throw new BadRequestException("未找到反馈关联的柜机。");
    }

    this.assertFeedbackSubmissionAllowed(
      payload.sourceKey ?? payload.targetUserId ?? "anonymous",
      Boolean(payload.targetUserId)
    );

    const targetUser = payload.targetUserId
      ? this.store.users.find((entry) => entry.id === payload.targetUserId)
      : undefined;
    const actorLabel = targetUser
      ? `${targetUser.role === "special" ? "用户" : targetUser.role === "merchant" ? "商家" : "管理员"}${targetUser.name}`
      : "访客";
    const previewDetail =
      trimmedDetail.length > 24 ? `${trimmedDetail.slice(0, 24)}...` : trimmedDetail;
    const titleBase = `${actorLabel}反馈${payload.feedbackType ?? "其他"}问题`;

    return this.create({
      type: "user_feedback",
      feedbackSource: "app",
      feedbackType: payload.feedbackType,
      title: payload.title ?? (previewDetail ? `${titleBase}，备注为${previewDetail}` : titleBase),
      detail: [
        `反馈人：${actorLabel}`,
        payload.feedbackType ? `反馈类型：${payload.feedbackType}` : undefined,
        payload.deviceCode ? `关联柜机：${payload.deviceCode}` : undefined,
        trimmedDetail ? `备注：${trimmedDetail}` : undefined
      ]
        .filter(Boolean)
        .join("。"),
      previewDetail,
      deviceCode: payload.deviceCode,
      targetUserId: payload.targetUserId,
      dueAt: new Date(Date.now() + 30 * 60_000).toISOString()
    });
  }

  private assertFeedbackSubmissionAllowed(sourceKey: string, authenticated: boolean) {
    const now = Date.now();
    const windowMs = 10 * 60_000;
    const limit = authenticated ? 5 : 3;
    const recent = (this.feedbackSubmissionHistory.get(sourceKey) ?? []).filter(
      (timestamp) => now - timestamp < windowMs
    );

    if (recent.length >= limit) {
      throw new HttpException("反馈提交过于频繁，请稍后再试。", 429);
    }

    recent.push(now);
    this.feedbackSubmissionHistory.set(sourceKey, recent);
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
    this.store.syncDeviceStocksFromBatches();

    for (const device of this.store.devices) {
      for (const goods of device.doors.flatMap((door) => door.goods)) {
        const setting = this.store.getDeviceGoodsSetting(device.deviceCode, goods.goodsId);
        const currentStock = this.store.getCurrentStock(device.deviceCode, goods.goodsId);

        if (!setting?.enabled) {
          continue;
        }

        // 缺货预警要尽早暴露，避免依赖固定领取窗口的用户白跑一趟。
        if (currentStock <= 0) {
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

        if (setting.lowStockThreshold !== undefined && currentStock < setting.lowStockThreshold) {
          this.create({
            type: "inventory",
            title: "柜机低库存提醒",
            deviceCode: device.deviceCode,
            goodsId: goods.goodsId,
            goodsName: goods.name,
            dueAt: new Date().toISOString(),
            detail: `${device.name} 的 ${goods.name} 当前库存仅剩 ${currentStock} 件，低于阈值 ${setting.lowStockThreshold} 件。`
          });
        }
      }
    }
  }

  private refreshDeviceFaultTasks() {
    for (const event of this.store.events) {
      const pendingDuration = Date.now() - new Date(event.updatedAt).getTime();
      const sourceLog = this.store.logs.find((entry) => entry.relatedEventId === event.eventId);
      const deviceLabel = this.getDeviceLabel(event.deviceCode);

      if (["created", "opening"].includes(event.status) && pendingDuration > 90 * 1000) {
        if (event.status !== "timeout_unopened") {
          event.status = "timeout_unopened";
          event.updatedAt = new Date().toISOString();
        }

        this.create({
          type: "device_fault",
          title: `${deviceLabel}超时未开门`,
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: event.updatedAt,
          detail: `事件 ${event.orderNo} 超过 90 秒未收到成功开门确认。`,
          sourceLogId: sourceLog?.id,
          relatedEventId: event.eventId
        });
      }

      if (event.status === "opened" && pendingDuration > 10 * 60 * 1000) {
        event.status = "stuck_open";
        event.updatedAt = new Date().toISOString();
        this.create({
          type: "device_fault",
          title: `${deviceLabel}柜门持续敞开`,
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: event.updatedAt,
          detail: `事件 ${event.orderNo} 开门后超过 10 分钟未收到关门确认。`,
          sourceLogId: sourceLog?.id,
          relatedEventId: event.eventId
        });
      }

      if (event.status === "failed") {
        this.create({
          type: "device_fault",
          title: `${deviceLabel}开门失败`,
          deviceCode: event.deviceCode,
          targetUserId: event.userId,
          dueAt: event.updatedAt,
          detail: `事件 ${event.orderNo} 返回 FAIL，请人工检查设备。`,
          sourceLogId: sourceLog?.id,
          relatedEventId: event.eventId
        });
      }
    }
  }

  private refreshLogDrivenTasks() {
    for (const log of this.store.logs) {
      if (log.status === "pending" && ["remote-open-device", "open-cabinet"].includes(log.type)) {
        const pendingDuration = Date.now() - new Date(log.occurredAt).getTime();
        const deviceCode =
          log.primarySubject?.type === "device"
            ? log.primarySubject.id
            : log.secondarySubject?.type === "device"
              ? log.secondarySubject.id
              : typeof log.metadata?.deviceCode === "string"
                ? log.metadata.deviceCode
                : undefined;

        if (pendingDuration > 90 * 1000 && !log.relatedEventId) {
          this.create({
            type: "device_fault",
            title: `${this.getDeviceLabel(deviceCode)}开门无响应`,
            deviceCode,
            dueAt: log.occurredAt,
            detail: `${log.description} 超过 90 秒仍未完成，请人工确认设备状态。`,
            sourceLogId: log.id
          });
        }
      }

      if (log.status === "failed" && log.type === "door-status-callback" && !log.relatedEventId) {
        const deviceCode =
          log.primarySubject?.type === "device"
            ? log.primarySubject.id
            : typeof log.metadata?.deviceCode === "string"
              ? log.metadata.deviceCode
              : undefined;
        this.create({
          type: "device_fault",
          title: `${this.getDeviceLabel(deviceCode)}开门失败`,
          deviceCode,
          dueAt: log.occurredAt,
          detail: `${log.description}，需要人工检查柜门、电机或通信链路。`,
          sourceLogId: log.id
        });
      }
    }
  }

  private findDuplicateTask(payload: Omit<AlertTask, "id" | "createdAt" | "status" | "grade">) {
    if (payload.relatedEventId) {
      return this.store.alerts.find(
        (entry) =>
          entry.relatedEventId === payload.relatedEventId &&
          entry.type === payload.type &&
          entry.title === payload.title
      );
    }

    if (payload.sourceLogId) {
      return this.store.alerts.find(
        (entry) =>
          entry.sourceLogId === payload.sourceLogId &&
          entry.type === payload.type &&
          entry.title === payload.title
      );
    }

    return this.store.alerts.find(
      (entry) =>
        entry.status !== "resolved" &&
        entry.type === payload.type &&
        entry.deviceCode === payload.deviceCode &&
        entry.targetUserId === payload.targetUserId &&
        entry.goodsId === payload.goodsId &&
        entry.title === payload.title
    );
  }

  private resolveGrade(type: AlertTask["type"]): AlertGrade {
    if (type === "device_fault" || type === "callback") {
      return "fault";
    }

    if (type === "user_feedback") {
      return "feedback";
    }

    return "warning";
  }

  private getDeviceLabel(deviceCode?: string) {
    if (!deviceCode) {
      return "柜机";
    }

    return this.store.devices.find((entry) => entry.deviceCode === deviceCode)?.name ?? deviceCode;
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
