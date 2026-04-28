import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  CabinetIntentItem,
  CabinetReservationCreatePayload,
  CabinetReservationRecord,
  GoodsCategory,
  OperationLogActor,
  ReservationSettings,
  UserRecord,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AccessRulesService } from "../access-rules/access-rules.service";

type Actor = { id: string; role: UserRole };

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService
  ) {}

  getSettings() {
    return this.store.reservationSettings;
  }

  updateSettings(
    patch: Partial<Pick<ReservationSettings, "enabled" | "holdMinutes" | "maxTimeouts">>,
    actorUserId?: string
  ) {
    if (patch.holdMinutes !== undefined) {
      const holdMinutes = Math.round(Number(patch.holdMinutes));

      if (!Number.isFinite(holdMinutes) || holdMinutes < 5 || holdMinutes > 24 * 60) {
        throw new BadRequestException("预约保留时间必须在 5 分钟到 24 小时之间。");
      }

      this.store.reservationSettings.holdMinutes = holdMinutes;
    }

    if (patch.maxTimeouts !== undefined) {
      const maxTimeouts = Math.round(Number(patch.maxTimeouts));

      if (!Number.isFinite(maxTimeouts) || maxTimeouts < 1 || maxTimeouts > 20) {
        throw new BadRequestException("预约超时封禁阈值必须在 1 到 20 次之间。");
      }

      this.store.reservationSettings.maxTimeouts = maxTimeouts;
    }

    if (patch.enabled !== undefined) {
      this.store.reservationSettings.enabled = Boolean(patch.enabled);
    }

    this.store.reservationSettings.updatedAt = new Date().toISOString();
    this.store.reservationSettings.updatedByUserId = actorUserId;

    this.store.logOperation({
      category: "admin",
      type: "update-reservation-settings",
      status: "success",
      actor: this.getActorLog(actorUserId, "admin"),
      description: "管理员更新了预约规则。",
      detail: `预约保留 ${this.store.reservationSettings.holdMinutes} 分钟，超时 ${this.store.reservationSettings.maxTimeouts} 次后禁用预约。`,
      metadata: {
        reservationSettings: this.store.reservationSettings,
        undoState: "not_undoable"
      }
    });

    return this.store.reservationSettings;
  }

  list(actor?: Actor) {
    this.expireOverdueReservations();

    if (!actor || actor.role === "admin") {
      return this.store.reservations;
    }

    return this.store.reservations.filter((entry) => entry.userId === actor.id);
  }

  create(payload: CabinetReservationCreatePayload, actor: Actor) {
    this.expireOverdueReservations();

    if (actor.role !== "special") {
      throw new ForbiddenException("只有普通用户可以预约柜机货品。");
    }

    const user = this.getActiveUser(actor.id);
    const settings = this.store.reservationSettings;

    if (!settings.enabled) {
      throw new BadRequestException("预约功能当前未启用。");
    }

    this.assertUserCanUseRelatedFeatures(user.id);
    this.assertReservationAllowed(user);

    const doorNum = payload.doorNum ?? "1";
    const intentItems = this.resolveIntentItems(
      payload.deviceCode,
      payload.intentItems ?? [],
      payload.intentItems?.[0]?.category ?? "daily"
    );

    if (!intentItems.length) {
      throw new BadRequestException("预约前请先选择要保留的货品。");
    }

    this.accessRulesService.assertCanOpenSpecialCabinet(user, intentItems[0]?.category);

    const now = new Date();
    const record: CabinetReservationRecord = {
      id: this.store.createId("reservation"),
      userId: user.id,
      phone: user.phone,
      userName: user.name,
      deviceCode: payload.deviceCode,
      doorNum,
      status: "active",
      items: intentItems,
      reservedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + settings.holdMinutes * 60_000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      timeoutCountAtCreation: user.reservationTimeoutCount ?? 0
    };

    this.store.reservations.unshift(record);
    this.store.logOperation({
      category: "pickup",
      type: "create-reservation",
      status: "success",
      actor: this.getActorLog(user.id, user.role),
      primarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      secondarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      description: `${user.name} 预约了 ${payload.deviceCode} 的货品。`,
      detail: `预约 ${record.id} 将在 ${record.expiresAt} 超时。`,
      metadata: {
        reservationId: record.id,
        deviceCode: record.deviceCode,
        doorNum: record.doorNum,
        items: record.items,
        expiresAt: record.expiresAt,
        undoState: "not_undoable"
      }
    });

    return record;
  }

  cancel(id: string, actor: Actor) {
    this.expireOverdueReservations();
    const reservation = this.findReservation(id);

    if (actor.role !== "admin" && reservation.userId !== actor.id) {
      throw new ForbiddenException("不能取消其他用户的预约。");
    }

    if (reservation.status !== "active") {
      return reservation;
    }

    const now = new Date().toISOString();
    reservation.status = "cancelled";
    reservation.cancelledAt = now;
    reservation.cancelledByUserId = actor.id;
    reservation.updatedAt = now;

    this.store.logOperation({
      category: "pickup",
      type: "cancel-reservation",
      status: "success",
      actor: this.getActorLog(actor.id, actor.role),
      primarySubject: {
        type: "device",
        id: reservation.deviceCode,
        label: reservation.deviceCode
      },
      secondarySubject: {
        type: "user",
        id: reservation.userId,
        label: reservation.userName ?? reservation.phone
      },
      description: `预约 ${reservation.id} 已取消。`,
      metadata: {
        reservationId: reservation.id,
        undoState: "not_undoable"
      }
    });

    return reservation;
  }

  resetUserTimeouts(userId: string, actorUserId?: string) {
    const user = this.store.users.find((entry) => entry.id === userId);

    if (!user) {
      throw new NotFoundException("未找到用户。");
    }

    user.reservationTimeoutCount = 0;
    user.reservationDisabledAt = undefined;
    user.reservationDisabledReason = undefined;

    this.store.logOperation({
      category: "admin",
      type: "reset-reservation-timeouts",
      status: "success",
      actor: this.getActorLog(actorUserId, "admin"),
      secondarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      description: `管理员重置了 ${user.name} 的预约超时记录。`,
      metadata: {
        userId: user.id,
        undoState: "not_undoable"
      }
    });

    return user;
  }

  getReservationForOpen(userId: string, reservationId: string, deviceCode: string) {
    this.expireOverdueReservations();
    const reservation = this.findReservation(reservationId);

    if (reservation.userId !== userId) {
      throw new ForbiddenException("该预约不属于当前用户。");
    }

    if (reservation.deviceCode !== deviceCode) {
      throw new BadRequestException("预约柜机与当前开柜柜机不一致。");
    }

    if (reservation.status !== "active") {
      throw new BadRequestException("该预约已失效，不能继续使用。");
    }

    if (Date.parse(reservation.expiresAt) <= Date.now()) {
      this.expireReservation(reservation, new Date());
      throw new BadRequestException("该预约已超时，请重新预约。");
    }

    return reservation;
  }

  markFulfilled(reservationId: string | undefined, eventId: string) {
    if (!reservationId) {
      return;
    }

    const reservation = this.store.reservations.find((entry) => entry.id === reservationId);

    if (!reservation || reservation.status !== "active") {
      return;
    }

    const now = new Date().toISOString();
    reservation.status = "fulfilled";
    reservation.fulfilledAt = now;
    reservation.fulfilledEventId = eventId;
    reservation.updatedAt = now;
  }

  assertUserCanUseRelatedFeatures(userId: string) {
    const blockingEvent = this.findBlockingBillingEvent(userId);

    if (!blockingEvent) {
      return;
    }

    throw new BadRequestException(
      `订单 ${blockingEvent.orderNo} 仍有待完成结算或待管理员确认的费用，请处理后再继续使用。`
    );
  }

  findBlockingBillingEvent(userId: string) {
    const blockingStatuses = new Set(["payable", "supplement_pending", "mismatch", "blocked"]);

    return this.store.events.find((event) => {
      if (
        event.userId !== userId ||
        event.role !== "special" ||
        event.billingResolvedAt ||
        event.paymentNotifyStatus === "success"
      ) {
        return false;
      }

      if (event.billingStatus && blockingStatuses.has(event.billingStatus)) {
        return true;
      }

      return Boolean(
        event.adjustments?.some(
          (adjustment) => adjustment.amount > 0 && adjustment.paymentNotifyStatus !== "success"
        )
      );
    });
  }

  expireOverdueReservations(now = new Date()) {
    for (const reservation of this.store.reservations) {
      if (reservation.status !== "active") {
        continue;
      }

      if (Date.parse(reservation.expiresAt) <= now.getTime()) {
        this.expireReservation(reservation, now);
      }
    }
  }

  private expireReservation(reservation: CabinetReservationRecord, now: Date) {
    if (reservation.status !== "active") {
      return;
    }

    reservation.status = "expired";
    reservation.expiredAt = now.toISOString();
    reservation.updatedAt = now.toISOString();

    const user = this.store.users.find((entry) => entry.id === reservation.userId);

    if (user) {
      user.reservationTimeoutCount = (user.reservationTimeoutCount ?? 0) + 1;

      if (user.reservationTimeoutCount >= this.store.reservationSettings.maxTimeouts) {
        user.reservationDisabledAt = now.toISOString();
        user.reservationDisabledReason = `预约超时已达到 ${this.store.reservationSettings.maxTimeouts} 次。`;
      }
    }

    this.store.logOperation({
      category: "pickup",
      type: "expire-reservation",
      status: "warning",
      actor: {
        type: "system",
        name: "预约系统"
      },
      primarySubject: {
        type: "device",
        id: reservation.deviceCode,
        label: reservation.deviceCode
      },
      secondarySubject: {
        type: "user",
        id: reservation.userId,
        label: reservation.userName ?? reservation.phone
      },
      description: `预约 ${reservation.id} 已超时。`,
      detail: user?.reservationDisabledAt
        ? `该用户预约超时 ${user.reservationTimeoutCount} 次，预约功能已禁用。`
        : `该用户当前预约超时 ${user?.reservationTimeoutCount ?? 0} 次。`,
      metadata: {
        reservationId: reservation.id,
        expiresAt: reservation.expiresAt,
        undoState: "not_undoable"
      }
    });
  }

  private assertReservationAllowed(user: UserRecord) {
    const maxTimeouts = this.store.reservationSettings.maxTimeouts;
    const timeoutCount = user.reservationTimeoutCount ?? 0;

    if (user.reservationDisabledAt || timeoutCount >= maxTimeouts) {
      throw new BadRequestException(`预约超时已达到 ${maxTimeouts} 次，预约功能已被禁用。`);
    }
  }

  private getActiveUser(userId: string) {
    const user = this.store.users.find((entry) => entry.id === userId && entry.status === "active");

    if (!user) {
      throw new BadRequestException("当前用户不存在或已停用。");
    }

    return user;
  }

  private findReservation(id: string) {
    const reservation = this.store.reservations.find((entry) => entry.id === id);

    if (!reservation) {
      throw new NotFoundException("未找到预约记录。");
    }

    return reservation;
  }

  private resolveIntentItems(
    deviceCode: string,
    intentItems: CabinetReservationCreatePayload["intentItems"],
    fallbackCategory: GoodsCategory = "daily"
  ): CabinetIntentItem[] {
    this.store.syncDeviceStocksFromBatches(deviceCode);
    const resolved = new Map<string, CabinetIntentItem>();

    for (const item of intentItems) {
      const quantity = Math.floor(Number(item.quantity));

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException("预约商品数量必须大于 0。");
      }

      const deviceGoods = this.store.devices
        .find((device) => device.deviceCode === deviceCode)
        ?.doors.flatMap((door) => door.goods)
        .find((goods) => goods.goodsId === item.goodsId);
      const catalogGoods = this.store.goodsCatalog.find((goods) => goods.goodsId === item.goodsId);
      const existing = resolved.get(item.goodsId);
      const goodsName = item.goodsName || deviceGoods?.name || catalogGoods?.name || item.goodsId;
      const category = item.category || deviceGoods?.category || catalogGoods?.category || fallbackCategory;
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      const stock = this.getReservableStock(deviceCode, item.goodsId);

      if (stock < nextQuantity) {
        throw new BadRequestException(`${goodsName} 当前库存不足，最多可预约 ${Math.max(0, stock)} 件。`);
      }

      resolved.set(item.goodsId, {
        goodsId: item.goodsId,
        goodsName,
        category,
        quantity: nextQuantity
      });
    }

    return Array.from(resolved.values());
  }

  private getReservableStock(deviceCode: string, goodsId: string) {
    const reservedQuantity = this.store.reservations
      .filter((reservation) => reservation.status === "active" && reservation.deviceCode === deviceCode)
      .flatMap((reservation) => reservation.items)
      .filter((item) => item.goodsId === goodsId)
      .reduce((sum, item) => sum + item.quantity, 0);

    return Math.max(0, this.store.getCurrentStock(deviceCode, goodsId) - reservedQuantity);
  }

  private getActorLog(userId: string | undefined, fallbackRole: UserRole | "admin"): OperationLogActor {
    const user = userId ? this.store.users.find((entry) => entry.id === userId) : undefined;
    const role = user?.role ?? (fallbackRole === "admin" ? "admin" : fallbackRole);

    return user
      ? {
          type: role,
          id: user.id,
          name: user.name,
          role
        }
      : {
          type: fallbackRole === "admin" ? "admin" : fallbackRole,
          name: fallbackRole === "admin" ? "管理员" : "用户"
        };
  }
}
