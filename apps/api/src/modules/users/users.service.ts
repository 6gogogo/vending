import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  AccessQuota,
  InventoryMovement,
  SpecialAccessPolicyGoodsLimit,
  UserAccessPolicy,
  UserLedgerStatus,
  UserManagementDetail,
  UserRecord,
  UserRole
} from "@vm/shared-types";

import {
  buildCalendarMonthDays,
  getEffectivePoliciesForUser,
  summarizeBusinessDayForUser
} from "../../common/policies/special-access-policy.utils";
import { addDaysToDateKey, getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { DevicesService } from "../devices/devices.service";

interface ImportUsersPayload {
  role: Extract<UserRole, "special" | "merchant">;
  entries: Array<Partial<UserRecord> & Pick<UserRecord, "phone" | "name">>;
}

interface BatchUpdatePayload {
  userIds: string[];
  patch: {
    status?: UserRecord["status"];
    tags?: string[];
    neighborhood?: string;
    regionId?: string;
    regionName?: string;
    quota?: AccessQuota;
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(DevicesService) private readonly devicesService: DevicesService
  ) {}

  list(role?: UserRole) {
    const users = role
      ? this.store.users.filter((user) => user.role === role)
      : this.store.users;

    return users.map((user) => this.decorateUser(user));
  }

  findByPhone(phone: string) {
    return this.store.users.find((user) => user.phone === phone && user.status === "active");
  }

  findById(userId: string) {
    const user = this.store.users.find((entry) => entry.id === userId);

    if (!user) {
      throw new NotFoundException("未找到对应用户。");
    }

    return user;
  }

  detail(
    userId: string,
    options?: {
      monthKey?: string;
      dateKey?: string;
    }
  ): UserManagementDetail {
    const user = this.findById(userId);
    const recentRecords = this.store.inventory
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.happenedAt.localeCompare(left.happenedAt))
      .slice(0, 20);
    const recentEvents = this.store.events
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12);
    const recentLogs = this.store.logs
      .filter(
        (entry) =>
          entry.actor.id === userId ||
          entry.primarySubject?.id === userId ||
          entry.secondarySubject?.id === userId
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 20);

    const businessDaySummary =
      user.role === "special"
        ? summarizeBusinessDayForUser(
            user,
            this.store.specialAccessPolicies,
            this.store.inventory,
            this.store.goodsCatalog
          )
        : undefined;
    const monthKey = options?.monthKey ?? getBusinessDayKey(new Date()).slice(0, 7);
    const defaultDateKey = (() => {
      const businessDateKey = getBusinessDayKey(new Date());
      if (businessDateKey.startsWith(monthKey)) {
        return businessDateKey;
      }

      return `${monthKey}-01`;
    })();
    const selectedDateKey = options?.dateKey ?? defaultDateKey;
    const accessPolicies =
      user.role === "special"
        ? getEffectivePoliciesForUser(user, this.store.specialAccessPolicies, "active", selectedDateKey).map((policy) => ({
            id: policy.id,
            name: policy.name,
            weekdays: [...policy.weekdays],
            startHour: policy.startHour,
            endHour: policy.endHour,
            goodsLimits: policy.goodsLimits.map((limit) => ({ ...limit })),
            status: policy.status,
            sourcePolicyId:
              "sourcePolicyId" in policy && typeof policy.sourcePolicyId === "string"
                ? policy.sourcePolicyId
                : undefined,
            effectiveFromDateKey:
              "effectiveFromDateKey" in policy && typeof policy.effectiveFromDateKey === "string"
                ? policy.effectiveFromDateKey
                : undefined,
            effectiveToDateKey:
              "effectiveToDateKey" in policy && typeof policy.effectiveToDateKey === "string"
                ? policy.effectiveToDateKey
                : undefined
          }))
        : undefined;
    const policyCalendar =
      user.role === "special"
        ? {
            monthKey,
            selectedDateKey,
            days: buildCalendarMonthDays(monthKey).map((day) => {
              const summary = summarizeBusinessDayForUser(
                user,
                this.store.specialAccessPolicies,
                this.store.inventory,
                this.store.goodsCatalog,
                day.dateKey
              );

              return {
                dateKey: day.dateKey,
                day: day.day,
                inCurrentMonth: day.inCurrentMonth,
                completionStatus: summary.completionStatus,
                hasPickup: summary.fulfilledGoods > 0,
                hasAdjustment: this.store.inventory.some(
                  (entry) =>
                    entry.userId === user.id &&
                    ["manual-restock", "manual-deduction", "adjustment"].includes(entry.type) &&
                    getBusinessDayKey(entry.happenedAt) === day.dateKey
                )
              };
            }),
            selectedDateSummary: (() => {
              const summary = summarizeBusinessDayForUser(
                user,
                this.store.specialAccessPolicies,
                this.store.inventory,
                this.store.goodsCatalog,
                selectedDateKey
              );

              if (summary.fulfilledGoods <= 0) {
                return undefined;
              }

              return {
                businessDateKey: summary.businessDateKey,
                completionStatus: summary.completionStatus,
                fulfilledGoods: summary.fulfilledGoods,
                totalGoods: summary.totalGoods,
                windows: summary.windows
              };
            })()
          }
        : undefined;
    const relatedTasks = this.store.alerts
      .filter(
        (entry) =>
          entry.targetUserId === user.id &&
          entry.status === "open"
      )
      .slice(0, 12);

    const lastActiveAt = [recentRecords[0]?.happenedAt, recentEvents[0]?.updatedAt, recentLogs[0]?.occurredAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);

    return {
      user: this.decorateUser(user),
      stats:
        user.role === "special"
          ? {
              pickupCount: recentRecords
                .filter((entry) => entry.type === "pickup")
                .reduce((sum, entry) => sum + entry.quantity, 0),
              donationCount: recentRecords
                .filter((entry) => entry.type === "donation" || entry.type === "manual-restock")
                .reduce((sum, entry) => sum + entry.quantity, 0),
              adjustmentCount: recentRecords
                .filter(
                  (entry) => entry.type === "adjustment" || entry.type === "manual-deduction"
                )
                .reduce((sum, entry) => sum + entry.quantity, 0),
              lastActiveAt
            }
          : undefined,
      recentRecords,
      recentEvents,
      recentLogs,
      relatedTasks,
      applicablePolicies: undefined,
      accessPolicies,
      businessDaySummary,
      policyCalendar
    };
  }

  createUser(payload: {
    role: UserRole;
    phone: string;
    name: string;
    status?: UserRecord["status"];
    neighborhood?: string;
    regionId?: string;
    regionName?: string;
    tags?: string[];
    quota?: AccessQuota;
  }, actorUserId?: string) {
    const region = this.resolveRegion(payload.regionId, payload.regionName ?? payload.neighborhood);
    const created: UserRecord = {
      id: this.store.createId(payload.role),
      role: payload.role,
      phone: payload.phone,
      name: payload.name,
      status: payload.status ?? "active",
      neighborhood: region.regionName,
      regionId: region.regionId,
      regionName: region.regionName,
      tags: payload.tags ?? [],
      quota: payload.role === "special" ? payload.quota : undefined,
      mobileProfileCompleted: false
    };

    this.store.users.unshift(created);
    this.store.logOperation({
      category: "user",
      type: "create-user",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: created.id,
        label: created.name
      },
      metadata: {
        undoState: "not_undoable"
      }
    });

    return created;
  }

  updateUser(
    userId: string,
    payload: {
      phone?: string;
      name?: string;
      status?: UserRecord["status"];
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
      quota?: AccessQuota;
    },
    actorUserId?: string
  ) {
    const user = this.findById(userId);
    const before = structuredClone(user);

    if (payload.phone !== undefined) {
      user.phone = payload.phone;
    }

    if (payload.name !== undefined) {
      user.name = payload.name;
    }

    if (payload.status !== undefined) {
      user.status = payload.status;
    }

    if (payload.regionId !== undefined || payload.regionName !== undefined || payload.neighborhood !== undefined) {
      const region = this.resolveRegion(payload.regionId, payload.regionName ?? payload.neighborhood);
      user.regionId = region.regionId;
      user.regionName = region.regionName;
      user.neighborhood = region.regionName;
    }

    if (payload.tags !== undefined) {
      user.tags = payload.tags;
    }

    if (payload.quota && user.role === "special") {
      user.quota = payload.quota;
    }

    this.store.logOperation({
      category: "user",
      type: "update-user",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        undoState: "undoable",
        beforeSnapshot: before,
        afterSnapshot: structuredClone(user)
      }
    });

    return user;
  }

  removeUser(userId: string, actorUserId?: string) {
    const user = this.findById(userId);

    if (user.id === actorUserId) {
      throw new BadRequestException("不能删除当前登录账号。");
    }

    if (
      user.role === "admin" &&
      this.store.users.filter((entry) => entry.role === "admin" && entry.status === "active").length <= 1
    ) {
      throw new BadRequestException("至少需要保留一个启用的管理员账号。");
    }

    const targetIndex = this.store.users.findIndex((entry) => entry.id === userId);

    if (targetIndex < 0) {
      throw new NotFoundException("未找到对应用户。");
    }

    const [removed] = this.store.users.splice(targetIndex, 1);

    for (const policy of this.store.specialAccessPolicies) {
      policy.applicableUserIds = policy.applicableUserIds.filter((id) => id !== removed.id);
    }

    for (let index = this.store.alerts.length - 1; index >= 0; index -= 1) {
      if (this.store.alerts[index].targetUserId === removed.id) {
        this.store.alerts.splice(index, 1);
      }
    }

    for (let index = this.store.merchantGoodsTemplates.length - 1; index >= 0; index -= 1) {
      if (this.store.merchantGoodsTemplates[index].ownerUserId === removed.id) {
        this.store.merchantGoodsTemplates.splice(index, 1);
      }
    }

    for (let index = this.store.adminCredentials.length - 1; index >= 0; index -= 1) {
      if (this.store.adminCredentials[index].userId === removed.id) {
        this.store.adminCredentials.splice(index, 1);
      }
    }

    for (const [token, session] of this.store.sessions.entries()) {
      if (session.userId === removed.id) {
        this.store.sessions.delete(token);
      }
    }

    for (const application of this.store.registrationApplications) {
      if (application.linkedUserId !== removed.id) {
        continue;
      }

      application.linkedUserId = undefined;
      application.status = "rejected";
      application.reviewReason = "该人员已由管理员从台账中删除，可重新提交注册资料。";
      application.updatedAt = new Date().toISOString();
    }

    this.store.logOperation({
      category: "user",
      type: "remove-user",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: removed.id,
        label: removed.name
      },
      description: `管理员删除了人员 ${removed.name}。`,
      detail: `人员 ${removed.name}（${removed.phone}）已从当前人员台账中删除，历史日志、库存记录和柜机事件保留。`,
      metadata: {
        userId: removed.id,
        userName: removed.name,
        phone: removed.phone,
        role: removed.role,
        undoState: "not_undoable"
      }
    });

    return {
      id: removed.id,
      name: removed.name
    };
  }

  importUsers(payload: ImportUsersPayload) {
    const imported = payload.entries.map((entry) => {
      const existing = this.store.users.find((user) => user.phone === entry.phone);

      if (existing) {
        Object.assign(existing, entry, {
          role: payload.role,
          status: "active"
        });
        return existing;
      }

      const created: UserRecord = {
        id: this.store.createId(payload.role),
        role: payload.role,
        phone: entry.phone,
        name: entry.name,
        status: "active",
        tags: entry.tags ?? [],
        neighborhood: entry.regionName ?? entry.neighborhood,
        regionId: entry.regionId,
        regionName: entry.regionName ?? entry.neighborhood,
        quota: entry.quota,
        merchantProfile: entry.merchantProfile,
        mobileProfileCompleted: false
      };

      this.store.users.push(created);
      return created;
    });

    this.store.logOperation({
      category: "user",
      type: "import-users",
      status: "success",
      actor: this.getAdminActor(),
      metadata: {
        role: payload.role,
        count: imported.length
      }
    });

    return {
      count: imported.length,
      imported
    };
  }

  batchUpdate(payload: BatchUpdatePayload, actorUserId?: string) {
    const updated = payload.userIds.map((userId) => {
      const user = this.findById(userId);
      const before = structuredClone(user);

      if (payload.patch.status !== undefined) {
        user.status = payload.patch.status;
      }

      if (payload.patch.tags) {
        user.tags = payload.patch.tags;
      }

      if (
        payload.patch.regionId !== undefined ||
        payload.patch.regionName !== undefined ||
        payload.patch.neighborhood !== undefined
      ) {
        const region = this.resolveRegion(
          payload.patch.regionId,
          payload.patch.regionName ?? payload.patch.neighborhood
        );
        user.regionId = region.regionId;
        user.regionName = region.regionName;
        user.neighborhood = region.regionName;
      }

      if (payload.patch.quota && user.role === "special") {
        user.quota = payload.patch.quota;
      }

      this.store.logOperation({
        category: "user",
        type: "batch-update-user",
        status: "success",
        actor: this.getAdminActor(actorUserId),
        primarySubject: {
          type: "user",
          id: user.id,
          label: user.name
        },
        metadata: {
          ...(payload.patch as Record<string, unknown>),
          undoState: "undoable",
          beforeSnapshot: before,
          afterSnapshot: structuredClone(user)
        }
      });

      return user;
    });

    return {
      count: updated.length,
      updated
    };
  }

  saveAccessPolicy(
    userId: string,
    payload: {
      id?: string;
      name: string;
      weekdays: number[];
      startHour: number;
      endHour: number;
      goodsLimits: Array<{
        goodsId: string;
        quantity: number;
      }>;
      status: UserAccessPolicy["status"];
      sourcePolicyId?: string;
    },
    actorUserId?: string
  ) {
    const user = this.findById(userId);

    if (user.role !== "special") {
      throw new BadRequestException("只有普通用户支持设置取货策略。");
    }

    if (payload.endHour <= payload.startHour) {
      throw new BadRequestException("结束时间必须晚于开始时间。");
    }

    const normalizedLimits: SpecialAccessPolicyGoodsLimit[] = payload.goodsLimits
      .filter((item) => item.goodsId && item.quantity > 0)
      .map((item) => {
        const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === item.goodsId);

        if (!goods) {
          throw new NotFoundException(`未找到货品 ${item.goodsId}。`);
        }

        return {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          quantity: item.quantity
        };
      });

    if (!normalizedLimits.length) {
      throw new BadRequestException("请至少设置一种货品。");
    }

    const targetPolicies = user.accessPolicies ?? [];
    user.accessPolicies = targetPolicies;
    const businessDateKey = getBusinessDayKey(new Date());
    const nextBusinessDateKey = addDaysToDateKey(businessDateKey, 1);

    if (payload.id) {
      const existing = targetPolicies.find((entry) => entry.id === payload.id);

      if (!existing) {
        throw new NotFoundException("未找到对应的个人取货设定。");
      }

      existing.status = "inactive";
      existing.effectiveToDateKey = businessDateKey;
      existing.updatedAt = new Date().toISOString();

      const created: UserAccessPolicy = {
        id: this.store.createId("user-policy"),
        name: payload.name.trim(),
        weekdays: Array.from(new Set(payload.weekdays)).sort((left, right) => left - right),
        startHour: payload.startHour,
        endHour: payload.endHour,
        goodsLimits: normalizedLimits,
        status: payload.status,
        sourcePolicyId: payload.sourcePolicyId,
        effectiveFromDateKey: nextBusinessDateKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      targetPolicies.unshift(created);

      this.store.logOperation({
        category: "policy",
        type: "update-user-access-policy",
        status: "success",
        actor: this.getAdminActor(actorUserId),
        primarySubject: {
          type: "user",
          id: user.id,
          label: user.name
        },
        metadata: {
          policyId: created.id,
          policyName: created.name,
          undoState: "not_undoable"
        }
      });

      return created;
    }

    const created: UserAccessPolicy = {
      id: this.store.createId("user-policy"),
      name: payload.name.trim(),
      weekdays: Array.from(new Set(payload.weekdays)).sort((left, right) => left - right),
      startHour: payload.startHour,
      endHour: payload.endHour,
      goodsLimits: normalizedLimits,
      status: payload.status,
      sourcePolicyId: payload.sourcePolicyId,
      effectiveFromDateKey: businessDateKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    targetPolicies.unshift(created);
    this.store.logOperation({
      category: "policy",
      type: "create-user-access-policy",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        policyId: created.id,
        policyName: created.name,
        undoState: "not_undoable"
      }
    });

    return created;
  }

  deleteAccessPolicy(userId: string, policyId: string, actorUserId?: string) {
    const user = this.findById(userId);

    if (user.role !== "special") {
      throw new BadRequestException("只有普通用户支持删除取货策略。");
    }

    const targetPolicies = user.accessPolicies ?? [];
    user.accessPolicies = targetPolicies;

    const existing = targetPolicies.find((entry) => entry.id === policyId);

    if (!existing) {
      throw new NotFoundException("未找到对应的个人取货设定。");
    }

    existing.status = "inactive";
    existing.effectiveToDateKey = getBusinessDayKey(new Date());
    existing.updatedAt = new Date().toISOString();

    this.store.logOperation({
      category: "policy",
      type: "delete-user-access-policy",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        policyId: existing.id,
        policyName: existing.name,
        undoState: "not_undoable"
      }
    });

    return existing;
  }

  applyAccessPolicyNow(userId: string, policyId: string, actorUserId?: string) {
    const user = this.findById(userId);

    if (user.role !== "special") {
      throw new BadRequestException("只有普通用户支持立即生效。");
    }

    const targetPolicies = user.accessPolicies ?? [];
    user.accessPolicies = targetPolicies;

    const target = targetPolicies.find((entry) => entry.id === policyId);

    if (!target) {
      throw new NotFoundException("未找到对应的个人取货设定。");
    }

    const businessDateKey = getBusinessDayKey(new Date());
    const previousBusinessDateKey = addDaysToDateKey(businessDateKey, -1);
    const now = new Date().toISOString();

    if ((target.effectiveFromDateKey ?? businessDateKey) <= businessDateKey) {
      return target;
    }

    for (const entry of targetPolicies) {
      if (entry.id === target.id || entry.status !== "active") {
        continue;
      }

      const effectiveFromDateKey = entry.effectiveFromDateKey ?? "0000-01-01";
      const effectiveToDateKey = entry.effectiveToDateKey ?? "9999-12-31";

      if (effectiveFromDateKey > businessDateKey || effectiveToDateKey < businessDateKey) {
        continue;
      }

      const isSameSourceVersion =
        Boolean(target.sourcePolicyId) && entry.sourcePolicyId === target.sourcePolicyId;
      const hasSameName = entry.name === target.name;
      const hasSameWindow =
        entry.startHour === target.startHour &&
        entry.endHour === target.endHour &&
        entry.weekdays.length === target.weekdays.length &&
        entry.weekdays.every((weekday, index) => weekday === target.weekdays[index]);
      const sharesGoods = entry.goodsLimits.some((limit) =>
        target.goodsLimits.some((targetLimit) => targetLimit.goodsId === limit.goodsId)
      );

      if (isSameSourceVersion || hasSameName || (hasSameWindow && sharesGoods)) {
        entry.status = "inactive";
        entry.effectiveToDateKey = previousBusinessDateKey;
        entry.updatedAt = now;
      }
    }

    target.status = "active";
    target.effectiveFromDateKey = businessDateKey;
    target.updatedAt = now;

    this.store.logOperation({
      category: "policy",
      type: "apply-user-access-policy-now",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        policyId: target.id,
        policyName: target.name,
        undoState: "not_undoable"
      }
    });

    return target;
  }

  manualAdjustment(
    userId: string,
    payload: {
      deviceCode: string;
      goodsId: string;
      relatedEventId?: string;
      relatedOrderNo?: string;
      goodsName?: string;
      category?: InventoryMovement["category"];
      quantity: number;
      unitPrice?: number;
      direction: "restock" | "deduct";
      note?: string;
    },
    actorUserId?: string
  ) {
    const user = this.findById(userId);
    const localGoods = this.devicesService.findGoods(payload.deviceCode, payload.goodsId);
    const movement: InventoryMovement = {
      id: this.store.createId("movement"),
      sourceOrderNo: payload.relatedOrderNo,
      eventId: payload.relatedEventId,
      userId: user.id,
      deviceCode: payload.deviceCode,
      goodsId: payload.goodsId,
      goodsName: payload.goodsName ?? localGoods?.name ?? payload.goodsId,
      category: payload.category ?? localGoods?.category ?? "daily",
      quantity: payload.quantity,
      unitPrice: payload.unitPrice ?? 0,
      type: payload.direction === "restock" ? "manual-restock" : "manual-deduction",
      happenedAt: new Date().toISOString()
    };

    this.store.inventory.unshift(movement);
    let createdBatchId: string | undefined;
    let consumedBatches: Array<{ batchId: string; quantity: number }> = [];

    if (payload.direction === "restock") {
      const catalogItem = this.store.ensureGoodsCatalogItem({
        goodsCode: localGoods?.goodsCode ?? payload.goodsId,
        goodsId: payload.goodsId,
        name: movement.goodsName,
        category: movement.category,
        price: movement.unitPrice,
        imageUrl:
          localGoods?.imageUrl ??
          this.store.goodsCatalog.find((entry) => entry.goodsId === payload.goodsId)?.imageUrl ??
          "https://dummyimage.com/160x160/d8e8ff/0b1220.png&text=%E7%89%A9%E8%B5%84",
        status: "active"
      });
      this.store.ensureDeviceGoodsEntry(payload.deviceCode, {
        goodsCode: catalogItem.goodsCode,
        goodsId: catalogItem.goodsId,
        name: catalogItem.name,
        category: catalogItem.category,
        price: catalogItem.price,
        imageUrl: catalogItem.imageUrl
      });
      createdBatchId = this.store.createGoodsBatch({
        goodsId: payload.goodsId,
        deviceCode: payload.deviceCode,
        quantity: payload.quantity,
        sourceType: "admin",
        sourceUserId: actorUserId,
        sourceUserName: this.store.users.find((entry) => entry.id === actorUserId)?.name,
        note: payload.note
      }).batchId;
    } else {
      consumedBatches = this.store.consumeGoodsBatches(
        payload.deviceCode,
        payload.goodsId,
        payload.quantity
      ).consumed;
    }

    this.store.logOperation({
      category: "inventory",
      type: payload.direction === "restock" ? "manual-restock" : "manual-deduction",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      secondarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      relatedEventId: payload.relatedEventId,
      relatedOrderNo: payload.relatedOrderNo,
      metadata: {
        direction: payload.direction,
        quantity: payload.quantity,
        goodsId: payload.goodsId,
        goodsName: movement.goodsName,
        note: payload.note ?? "",
        deviceCode: payload.deviceCode,
        platformSync: "local_only",
        platformSyncLabel: "仅本地，未同步平台",
        relatedEventId: payload.relatedEventId,
        relatedOrderNo: payload.relatedOrderNo,
        batchId: createdBatchId,
        consumedBatches,
        undoState: "undoable"
      }
    });

    return movement;
  }

  private decorateUser(user: UserRecord): UserRecord {
    const region = this.store.normalizeUserRegion(user);

    return {
      ...user,
      regionId: region.regionId,
      regionName: region.regionName,
      neighborhood: region.regionName,
      ledgerStatus: this.getLedgerStatus(user)
    };
  }

  private getLedgerStatus(user: UserRecord): UserLedgerStatus {
    if (!user.mobileProfileCompleted) {
      return "unregistered";
    }

    if (user.role !== "special") {
      return "registered";
    }

    const hasAssignedQuota =
      (user.quota?.dailyLimit ?? 0) > 0 ||
      Object.values(user.quota?.categoryLimit ?? {}).some((value) => (value ?? 0) > 0);
    const activePolicies = getEffectivePoliciesForUser(user, this.store.specialAccessPolicies);

    if (activePolicies.length) {
      const summary = summarizeBusinessDayForUser(
        user,
        this.store.specialAccessPolicies,
        this.store.inventory,
        this.store.goodsCatalog
      );

      if (summary.completionStatus === "complete") {
        return "quota_complete";
      }

      if (summary.completionStatus === "partial") {
        return "quota_partial";
      }

      if (summary.completionStatus === "unserved") {
        return "quota_unclaimed";
      }
    }

    if (hasAssignedQuota) {
      const businessDateKey = getBusinessDayKey(new Date());
      const usedCount = this.store.inventory
        .filter(
          (entry) =>
            entry.userId === user.id &&
            entry.type === "pickup" &&
            getBusinessDayKey(entry.happenedAt) === businessDateKey
        )
        .reduce((sum, entry) => sum + entry.quantity, 0);
      const dailyLimit = Math.max(0, user.quota?.dailyLimit ?? 0);

      if (usedCount <= 0) {
        return "quota_unclaimed";
      }

      if (dailyLimit > 0 && usedCount >= dailyLimit) {
        return "quota_complete";
      }

      return "quota_partial";
    }

    return "registered";
  }

  private resolveRegion(regionId?: string, regionName?: string) {
    const matched = this.store.getRegion(regionId);

    if (matched) {
      return {
        regionId: matched.id,
        regionName: matched.name
      };
    }

    const normalizedName = regionName?.trim();

    if (!normalizedName) {
      return {
        regionId: undefined,
        regionName: undefined
      };
    }

    const namedRegion = this.store.regions.find((entry) => entry.name === normalizedName);

    if (namedRegion) {
      return {
        regionId: namedRegion.id,
        regionName: namedRegion.name
      };
    }

    throw new BadRequestException("请选择已配置区域。");
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
