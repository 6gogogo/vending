import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
import { isReservationOnlyPickup } from "../../common/config/reservation-only-pickup";
import { AccessRulesService } from "../access-rules/access-rules.service";
import {
  allocateActiveEntitlements,
  getActiveWindowEntitlementQuota,
  subtractLockedEntitlements
} from "../../common/policies/special-access-policy.utils";

type Actor = { id: string; role: UserRole; tenantId?: string };

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService
  ) {}

  getSettings() {
    return this.store.reservationSettings;
  }

  updateSettings(
    patch: Partial<Pick<ReservationSettings, "enabled" | "holdMinutes" | "maxTimeouts">>,
    actorUserId?: string
  ) {
    let nextHoldMinutes = this.store.reservationSettings.holdMinutes;
    let nextMaxTimeouts = this.store.reservationSettings.maxTimeouts;
    let nextEnabled = this.store.reservationSettings.enabled;

    if (patch.holdMinutes !== undefined) {
      const holdMinutes = Number(patch.holdMinutes);

      if (
        !Number.isFinite(holdMinutes) ||
        !Number.isInteger(holdMinutes) ||
        holdMinutes < 5 ||
        holdMinutes > 24 * 60
      ) {
        throw new BadRequestException("预约保留时间必须是 5 分钟到 24 小时之间的整数。");
      }

      nextHoldMinutes = holdMinutes;
    }

    if (patch.maxTimeouts !== undefined) {
      const maxTimeouts = Number(patch.maxTimeouts);

      if (
        !Number.isFinite(maxTimeouts) ||
        !Number.isInteger(maxTimeouts) ||
        maxTimeouts < 1 ||
        maxTimeouts > 20
      ) {
        throw new BadRequestException("预约超时封禁阈值必须是 1 到 20 之间的整数。");
      }

      nextMaxTimeouts = maxTimeouts;
    }

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") {
        throw new BadRequestException("预约启用状态必须是布尔值。");
      }

      nextEnabled = patch.enabled;
    }

    const beforeMutation = structuredClone(this.store.reservationSettings);
    const logsBeforeMutation = structuredClone(this.store.logs);

    try {
      Object.assign(this.store.reservationSettings, {
        holdMinutes: nextHoldMinutes,
        maxTimeouts: nextMaxTimeouts,
        enabled: nextEnabled,
        updatedAt: new Date().toISOString(),
        updatedByUserId: actorUserId
      });

      this.store.logOperation({
        category: "admin",
        type: "update-reservation-settings",
        status: "success",
        actor: this.getActorLog(actorUserId, "admin"),
        description: "管理员更新了预约规则。",
        detail: `预约保留 ${this.store.reservationSettings.holdMinutes} 分钟，超时 ${this.store.reservationSettings.maxTimeouts} 次后禁用预约。`,
        metadata: {
          reservationSettings: structuredClone(this.store.reservationSettings),
          undoState: "not_undoable"
        }
      });

      return this.store.reservationSettings;
    } catch (error) {
      Object.assign(this.store.reservationSettings, beforeMutation);
      if (beforeMutation.updatedAt === undefined) {
        delete this.store.reservationSettings.updatedAt;
      }
      if (beforeMutation.updatedByUserId === undefined) {
        delete this.store.reservationSettings.updatedByUserId;
      }
      this.store.logs.splice(0, this.store.logs.length, ...logsBeforeMutation);
      throw error;
    }
  }

  list(actor?: Actor, targetUserId?: string) {
    this.expireOverdueReservations();

    if (!actor) {
      return this.store.reservations;
    }

    if (actor.role === "admin") {
      if (!actor.tenantId) {
        throw new ForbiddenException("当前后台会话未绑定客户实例。");
      }
      return this.store.reservations
        .filter(
          (entry) =>
            this.reservationBelongsToTenant(entry, actor.tenantId!) &&
            (!targetUserId || entry.userId === targetUserId)
        )
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 50);
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

    const doorNum = String(payload.doorNum ?? "1").trim();

    if (!doorNum) {
      throw new BadRequestException("预约柜门编号不能为空。");
    }

    const intentItems = this.resolveIntentItems(
      payload.deviceCode,
      doorNum,
      payload.intentItems ?? [],
      payload.intentItems?.[0]?.category ?? "daily"
    );

    if (!intentItems.length) {
      throw new BadRequestException("预约前请先选择要保留的货品。");
    }

    const quotaSummary = this.accessRulesService.assertCanOpenSpecialCabinet(user);
    let entitlementAllocations: CabinetReservationRecord["entitlementAllocations"];

    if (this.isReservationOnlyPickup()) {
      this.assertReservationFitsFreeQuota(user, intentItems, quotaSummary);
      if (quotaSummary.remainingPools?.length) {
        const quota = getActiveWindowEntitlementQuota(
          user,
          this.store.specialAccessPolicies,
          this.store.inventory,
          this.store.goodsCatalog,
          this.store.goodsTaxonomyNodes,
          new Date()
        );
        const activeReservations = this.store.reservations.filter(
          (reservation) => reservation.userId === user.id && reservation.status === "active"
        );
        // 已创建预约保存的是确定的额度池锁。后续预约只能使用锁定后的剩余额度，
        // 不能按当前规则重新分配旧预约，否则规则变更会把旧锁“搬”到别的池。
        let quotaAfterLocks;
        try {
          quotaAfterLocks = subtractLockedEntitlements(
            quota,
            activeReservations.flatMap((reservation) => reservation.entitlementAllocations ?? [])
          );
        } catch {
          throw new BadRequestException(
            "已有预约锁定的领取额度已发生变化，请先取消对应预约后再创建新预约。"
          );
        }

        // 仅旧版本未保存额度池的预约允许按当前规则补算；已经保存的锁绝不参与重排。
        const legacyActiveReservations = activeReservations.filter(
          (reservation) => !reservation.entitlementAllocations?.length
        );
        const legacyReservedItems = legacyActiveReservations
          .flatMap((reservation) => reservation.items)
          .reduce<Map<string, number>>((result, item) => {
            result.set(item.goodsId, (result.get(item.goodsId) ?? 0) + item.quantity);
            return result;
          }, new Map());
        const planned = new Map(legacyReservedItems);
        for (const item of intentItems) {
          planned.set(item.goodsId, (planned.get(item.goodsId) ?? 0) + item.quantity);
        }
        const allocation = allocateActiveEntitlements(
          quotaAfterLocks,
          this.store.goodsTaxonomyNodes,
          this.store.goodsCatalog,
          [...planned].map(([goodsId, quantity]) => ({ goodsId, quantity }))
        );
        if (!allocation.fulfilled) {
          throw new BadRequestException("预约数量超过当前树状领取额度。");
        }
        const existingReservationQuantity = new Map(legacyReservedItems);
        entitlementAllocations = allocation.allocations.flatMap((line) => {
          const existing = existingReservationQuantity.get(line.goodsId) ?? 0;
          if (existing <= 0) return [{ ...line }];
          const retained = Math.min(existing, line.quantity);
          existingReservationQuantity.set(line.goodsId, existing - retained);
          return line.quantity > retained ? [{ ...line, quantity: line.quantity - retained }] : [];
        });
      }
    }

    const now = new Date();
    const record: CabinetReservationRecord = {
      id: this.store.createId("reservation"),
      userId: user.id,
      phone: user.phone,
      userName: user.name,
      deviceCode: payload.deviceCode,
      doorNum,
      status: "active",
      inventoryReservationMode: "goods_quantity",
      batchAllocationTiming: "on_open",
      items: intentItems,
      entitlementAllocations,
      taxonomyRevision: quotaSummary.taxonomyRevision,
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

  cancel(id: string, actor: Actor, reasonInput?: unknown) {
    this.expireOverdueReservations();
    const reservation = this.findReservation(id);

    let cancellationReason: string | undefined;
    if (actor.role === "admin") {
      if (!actor.tenantId || !this.reservationBelongsToTenant(reservation, actor.tenantId)) {
        throw new NotFoundException("未找到对应预约记录。");
      }
      cancellationReason = typeof reasonInput === "string" ? reasonInput.trim() : "";
      if (cancellationReason.length < 2 || cancellationReason.length > 200) {
        throw new BadRequestException("管理员取消预约时，请填写 2 至 200 字的处理原因。");
      }
    } else if (reservation.userId !== actor.id) {
      throw new ForbiddenException("不能取消其他用户的预约。");
    }

    if (reservation.status !== "active") {
      if (actor.role === "admin") {
        throw new ConflictException("只有当前有效的预约可以由管理员取消。");
      }
      return reservation;
    }

    const now = new Date().toISOString();
    reservation.status = "cancelled";
    reservation.cancelledAt = now;
    reservation.cancelledByUserId = actor.id;
    reservation.cancellationReason = cancellationReason;
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
      description:
        actor.role === "admin"
          ? `管理员取消了 ${reservation.userName ?? reservation.userId} 的预约 ${reservation.id}。`
          : `预约 ${reservation.id} 已由用户取消。`,
      detail: cancellationReason,
      metadata: {
        reservationId: reservation.id,
        reason: cancellationReason,
        undoState: "not_undoable"
      }
    });

    return reservation;
  }

  private reservationBelongsToTenant(
    reservation: CabinetReservationRecord,
    tenantId: string
  ) {
    const user = this.store.users.find((entry) => entry.id === reservation.userId);
    const device = this.store.devices.find(
      (entry) => entry.deviceCode === reservation.deviceCode
    );
    return Boolean(
      user &&
      device &&
      this.store.getUserTenantId(user) === tenantId &&
      this.store.getDeviceTenantId(device) === tenantId
    );
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

  getReservationForOpen(userId: string, reservationId: string, deviceCode: string, doorNum: string) {
    this.expireOverdueReservations();
    const reservation = this.findReservation(reservationId);

    if (reservation.userId !== userId) {
      throw new ForbiddenException("该预约不属于当前用户。");
    }

    if (reservation.deviceCode !== deviceCode) {
      throw new BadRequestException("预约柜机与当前开柜柜机不一致。");
    }

    if (reservation.doorNum !== doorNum) {
      throw new BadRequestException("预约柜门与当前开柜柜门不一致。");
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

    if (this.isReservationOnlyPickup()) {
      throw new BadRequestException(
        `订单 ${blockingEvent.orderNo} 仍有待完成的取货核对，请由管理员处理后再继续预约或开柜。`
      );
    }

    throw new BadRequestException(
      `订单 ${blockingEvent.orderNo} 仍有待完成结算或待管理员确认的费用，请处理后再继续使用。`
    );
  }

  findBlockingBillingEvent(userId: string) {
    const blockingStatuses = new Set([
      "pending",
      "payable",
      "supplement_pending",
      "mismatch",
      "blocked"
    ]);

    return this.store.events.find((event) => {
      if (
        event.userId !== userId ||
        event.role !== "special"
      ) {
        return false;
      }

      const fallbackPhysicalStatus =
        event.status === "created" ||
        event.status === "opening" ||
        event.status === "opened" ||
        event.status === "stuck_open";
      const physicalStateUnresolved =
        event.physicalDoorState !== undefined
          ? event.physicalDoorState !== "closed"
          : fallbackPhysicalStatus;

      if (physicalStateUnresolved) {
        return true;
      }

      if (event.billingResolvedAt || event.paymentNotifyStatus === "success") {
        return false;
      }

      if (
        event.billingStatus &&
        blockingStatuses.has(event.billingStatus) &&
        event.status !== "failed" &&
        event.status !== "refunded"
      ) {
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
    let expiredAny = false;

    for (const reservation of this.store.reservations) {
      if (reservation.status !== "active") {
        continue;
      }

      if (Date.parse(reservation.expiresAt) <= now.getTime()) {
        this.expireReservation(reservation, now);
        expiredAny = true;
      }
    }

    if (expiredAny) {
      // 预约列表属于读取接口，但“到期”本身是业务状态迁移；必须在此处落盘，
      // 不能依赖会跳过 GET 和失败响应的全局持久化拦截器。
      this.store.persist();
    }

    return expiredAny;
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

  private isReservationOnlyPickup() {
    return isReservationOnlyPickup({
      VM_RESERVATION_ONLY_PICKUP: this.configService?.get<string>("VM_RESERVATION_ONLY_PICKUP")
    });
  }

  /**
   * 预约尚未形成库存流水，因此需要将同一用户未履约预约一起计入额度，
   * 否则可以借多次预约把原本应付的物资留到之后领取。
   */
  private assertReservationFitsFreeQuota(
    user: UserRecord,
    intentItems: CabinetIntentItem[],
    quotaSummary: ReturnType<AccessRulesService["getQuotaSummaryForUser"]>
  ) {
    const reservedItems = this.store.reservations
      .filter((reservation) => reservation.userId === user.id && reservation.status === "active")
      .flatMap((reservation) => reservation.items);
    const plannedItems = [...reservedItems, ...intentItems];
    const plannedQuantity = plannedItems.reduce((sum, item) => sum + item.quantity, 0);
    const remainingDaily = Math.max(0, quotaSummary.remainingDaily ?? 0);

    if (plannedQuantity > remainingDaily) {
      throw new BadRequestException(
        `预约数量超过当前可领取额度，今日最多还可预约 ${remainingDaily} 件。`
      );
    }

    const remainingByGoods = (quotaSummary.remainingByGoods ?? {}) as Record<string, number>;
    const remainingByCategory = (quotaSummary.remainingToday ?? {}) as Partial<
      Record<GoodsCategory, number>
    >;
    const useGoodsQuota = Object.keys(remainingByGoods).length > 0;
    const plannedByScope = new Map<string, { quantity: number; label: string }>();

    for (const item of plannedItems) {
      const scope = useGoodsQuota ? item.goodsId : item.category;
      const current = plannedByScope.get(scope);
      plannedByScope.set(scope, {
        quantity: (current?.quantity ?? 0) + item.quantity,
        label: current?.label ?? item.goodsName
      });
    }

    for (const [scope, planned] of plannedByScope) {
      const allowed = Math.max(
        0,
        Number(
          useGoodsQuota
            ? remainingByGoods[scope]
            : remainingByCategory[scope as GoodsCategory]
        ) || 0
      );

      if (planned.quantity > allowed) {
        throw new BadRequestException(
          `${planned.label} 超过当前可领取额度，最多可预约 ${allowed} 件。`
        );
      }
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
    doorNum: string,
    intentItems: CabinetReservationCreatePayload["intentItems"],
    fallbackCategory: GoodsCategory = "daily"
  ): CabinetIntentItem[] {
    this.store.syncDeviceStocksFromBatches(deviceCode);
    const device = this.store.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const door = device.doors.find((entry) => entry.doorNum === doorNum);

    if (!door) {
      throw new NotFoundException("未找到对应柜门。");
    }

    const resolved = new Map<string, CabinetIntentItem>();

    for (const item of intentItems) {
      const goodsId = String(item.goodsId ?? "").trim();
      const quantity = Number(item.quantity);

      if (!goodsId) {
        throw new BadRequestException("预约货品编号不能为空。");
      }

      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
        throw new BadRequestException("预约商品数量必须是正整数。");
      }

      const deviceGoods = door.goods.find((goods) => goods.goodsId === goodsId);

      if (!deviceGoods) {
        throw new BadRequestException(`货品 ${goodsId} 不属于柜门 ${doorNum}，不能预约。`);
      }

      const catalogGoods = this.store.goodsCatalog.find((goods) => goods.goodsId === goodsId);
      const existing = resolved.get(goodsId);
      // 名称和品类只采用后端柜门/目录数据，不能信任客户端可改写字段。
      const goodsName = deviceGoods.name || catalogGoods?.name || goodsId;
      const category = deviceGoods.category || catalogGoods?.category || fallbackCategory;
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      const stock = this.getReservableStock(deviceCode, goodsId);

      if (stock < nextQuantity) {
        throw new BadRequestException(`${goodsName} 当前库存不足，最多可预约 ${Math.max(0, stock)} 件。`);
      }

      resolved.set(goodsId, {
        goodsId,
        goodsName,
        category,
        quantity: nextQuantity
      });
    }

    return Array.from(resolved.values());
  }

  private getReservableStock(deviceCode: string, goodsId: string) {
    return this.store.getReservableStock(deviceCode, goodsId);
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
