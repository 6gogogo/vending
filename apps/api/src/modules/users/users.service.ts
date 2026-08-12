import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  AccessQuota,
  BackofficeRole,
  BatchConsumptionLine,
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
import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { addDaysToDateKey, getBusinessDayKey } from "../../common/time/business-day";
import {
  InMemoryStoreService,
  RESERVED_BACKOFFICE_USER_TAGS
} from "../../common/store/in-memory-store.service";
import { assertTenantsKeepActiveBackofficeAdmin } from "../../common/store/tenant-admin-continuity";
import { DevicesService } from "../devices/devices.service";

interface ImportUsersPayload {
  role: Extract<UserRole, "special" | "merchant">;
  entries: Array<{
    phone: string;
    name: string;
    neighborhood?: string;
    regionId?: string;
    regionName?: string;
    tags?: string[];
    quota?: AccessQuota;
  }>;
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

interface BatchRemovePayload {
  userIds: string[];
  confirmedCount: number;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService) private readonly inventoryBatchChanges: InventoryBatchChangesService,
    @Inject(DevicesService) private readonly devicesService: DevicesService
  ) {}

  list(
    role?: UserRole,
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ) {
    const users = role
      ? this.store.users.filter((user) => user.role === role)
      : this.store.users;

    return users
      .filter(
        (user) =>
          this.canViewUser(user, viewerBackofficeRole, viewerTenantId) &&
          (!viewerTenantId || this.store.getUserTenantId(user) === viewerTenantId)
      )
      .map((user) => this.decorateUser(user));
  }

  findByPhone(phone: string) {
    const matches = this.store.users.filter(
      (user) => user.phone === phone && user.status === "active"
    );
    return matches.length === 1 ? matches[0] : undefined;
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
    },
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ): UserManagementDetail {
    const user = this.findById(userId);
    this.assertCanViewUser(user, viewerBackofficeRole, viewerTenantId);
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

  createUser(
    payload: {
      role: UserRole;
      phone: string;
      name: string;
      status?: UserRecord["status"];
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
      quota?: AccessQuota;
    },
    actorUserId?: string,
    actorTenantId?: string
  ) {
    const phone = String(payload.phone ?? "").trim();
    this.assertPhoneAvailable(phone);

    if (
      payload.role !== "admin" &&
      payload.role !== "merchant" &&
      payload.role !== "restocker" &&
      payload.role !== "special"
    ) {
      throw new BadRequestException("请选择有效的用户角色。");
    }
    if (
      payload.status !== undefined &&
      payload.status !== "active" &&
      payload.status !== "inactive"
    ) {
      throw new BadRequestException("请选择有效的用户状态。");
    }
    this.assertNoReservedBackofficeTags(payload.tags);

    const region = this.resolveRegion(payload.regionId, payload.regionName ?? payload.neighborhood);
    const created: UserRecord = {
      id: this.store.createId(payload.role),
      tenantId: actorTenantId ?? this.store.getDefaultTenantId(),
      role: payload.role,
      phone,
      name: payload.name,
      status: payload.status ?? "active",
      neighborhood: region.regionName,
      regionId: region.regionId,
      regionName: region.regionName,
      tags: payload.tags ?? [],
      quota: payload.role === "special" ? payload.quota : undefined,
      assignedDeviceCodes: payload.role === "restocker" ? [] : undefined,
      // 此入口由实例管理员显式建档，保存即代表资料已核验，可直接进入对应移动端流程。
      mobileProfileCompleted: true
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

  assignDevices(
    userId: string,
    deviceCodes: string[],
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    if (!Array.isArray(deviceCodes)) {
      throw new BadRequestException("柜机分配必须提交柜机编号列表。");
    }

    const normalizedDeviceCodes = Array.from(
      new Set(
        deviceCodes.map((value) => {
          if (typeof value !== "string" || !value.trim()) {
            throw new BadRequestException("柜机编号不能为空。");
          }

          return value.trim();
        })
      )
    );

    if (normalizedDeviceCodes.length > 100) {
      throw new BadRequestException("单个账号最多分配 100 台柜机。");
    }

    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);

    if (user.role !== "merchant" && user.role !== "restocker") {
      throw new BadRequestException("只有商家或补货员可以分配柜机。");
    }

    const missingDeviceCodes = normalizedDeviceCodes.filter((deviceCode) => {
      const device = this.store.devices.find(
        (entry) => entry.deviceCode === deviceCode
      );

      return (
        !device ||
        (actorTenantId !== undefined &&
          this.store.getDeviceTenantId(device) !== actorTenantId)
      );
    });

    if (missingDeviceCodes.length > 0) {
      throw new BadRequestException(`柜机不存在：${missingDeviceCodes.join("、")}。`);
    }

    const beforeDeviceCodes = this.getAssignedDeviceCodes(user);
    user.assignedDeviceCodes = normalizedDeviceCodes;

    if (user.role === "merchant") {
      user.merchantProfile = user.merchantProfile ?? {
        donationWindowDays: 2,
        defaultDeviceCodes: []
      };
      user.merchantProfile.defaultDeviceCodes = [...normalizedDeviceCodes];
    }

    this.store.logOperation({
      category: "user",
      type: "assign-user-devices",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        beforeDeviceCodes,
        deviceCodes: normalizedDeviceCodes,
        undoState: "not_undoable"
      }
    });

    return this.decorateUser(user);
  }

  updateUser(
    userId: string,
    payload: {
      role?: UserRole;
      phone?: string;
      name?: string;
      status?: UserRecord["status"];
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
      quota?: AccessQuota;
    },
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    this.assertUpdateUserPayload(payload);
    this.assertNoReservedBackofficeTags(payload.tags);
    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);
    this.assertNotControlledProviderUser(user);
    this.assertActorKeepsOwnAccess(
      [{ user, nextRole: payload.role, nextStatus: payload.status }],
      actorUserId
    );
    assertTenantsKeepActiveBackofficeAdmin(this.store, [
      { user, nextRole: payload.role, nextStatus: payload.status }
    ]);
    const before = structuredClone(user);
    const roleWillChange = payload.role !== undefined && payload.role !== user.role;

    if (payload.phone !== undefined) {
      const phone = String(payload.phone).trim();
      this.assertPhoneAvailable(phone, user.id);
      user.phone = phone;
    }

    if (payload.role !== undefined && payload.role !== user.role) {
      user.role = payload.role;
      if (payload.role === "merchant") {
        user.merchantProfile = user.merchantProfile ?? {
          donationWindowDays: 2,
          defaultDeviceCodes: []
        };
      } else {
        user.merchantProfile = undefined;
      }

      user.assignedDeviceCodes =
        payload.role === "merchant" || payload.role === "restocker"
          ? (user.assignedDeviceCodes ?? [])
          : undefined;

      if (payload.role !== "special") {
        user.quota = undefined;
        user.accessPolicies = undefined;
        user.mobileProfileCompleted = true;
      }
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

    if (roleWillChange || (payload.status !== undefined && payload.status !== "active")) {
      this.store.revokeSessionsForUser(user.id);
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

  removeUser(
    userId: string,
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);
    this.assertNotControlledProviderUser(user);
    this.assertCanRemoveUsers([user], actorUserId);

    return this.removeUserRecord(user, actorUserId);
  }

  batchRemove(
    payload: BatchRemovePayload,
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    this.assertBatchRemovePayload(payload);

    if (new Set(payload.userIds).size !== payload.userIds.length) {
      throw new BadRequestException("批量删除不能包含重复用户。");
    }

    const targetUsers = payload.userIds.map((userId) => {
      const user = this.findById(userId);
      this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);
      this.assertNotControlledProviderUser(user);
      return user;
    });
    this.assertCanRemoveUsers(targetUsers, actorUserId);

    const removed = targetUsers.map((user) => this.removeUserRecord(user, actorUserId));
    this.store.logOperation({
      category: "user",
      type: "batch-remove-users",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      description: `管理员批量删除了 ${removed.length} 名人员。`,
      detail: `本次批量删除已按确认人数 ${payload.confirmedCount} 完成，历史日志、库存记录和柜机事件保留。`,
      metadata: {
        count: removed.length,
        confirmedCount: payload.confirmedCount,
        userIds: removed.map((entry) => entry.id),
        userNames: removed.map((entry) => entry.name),
        undoState: "not_undoable"
      }
    });

    return {
      count: removed.length,
      removed
    };
  }

  private removeUserRecord(user: UserRecord, actorUserId?: string) {
    const targetIndex = this.store.users.findIndex((entry) => entry.id === user.id);

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

    for (let index = this.store.adminCredentials.length - 1; index >= 0; index -= 1) {
      if (this.store.adminCredentials[index].userId === removed.id) {
        this.store.adminCredentials.splice(index, 1);
      }
    }

    for (let index = this.store.backofficeCredentials.length - 1; index >= 0; index -= 1) {
      if (this.store.backofficeCredentials[index].userId === removed.id) {
        this.store.backofficeCredentials.splice(index, 1);
      }
    }

    this.store.revokeSessionsForUser(removed.id);

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

  importUsers(payload: ImportUsersPayload, actorTenantId?: string) {
    const body = this.requirePlainObject(payload, "用户导入请求体");
    this.assertOnlyFields(body, ["role", "entries"], "用户导入");
    if (body.role !== "special" && body.role !== "merchant") {
      throw new BadRequestException("用户导入只支持特殊群体或商家角色。");
    }
    const importRole: ImportUsersPayload["role"] = body.role;
    if (
      !Array.isArray(body.entries) ||
      body.entries.length === 0 ||
      body.entries.length > 500
    ) {
      throw new BadRequestException("用户导入明细必须是 1 至 500 项的数组。");
    }

    const tenantId = actorTenantId ?? this.store.getDefaultTenantId();
    const normalizedEntries = body.entries.map((rawEntry) => {
      const entry = this.requirePlainObject(rawEntry, "用户导入明细");
      this.assertOnlyFields(
        entry,
        [
          "phone",
          "name",
          "neighborhood",
          "regionId",
          "regionName",
          "tags",
          "quota"
        ],
        "用户导入明细"
      );
      this.assertStringValue(entry.phone, "手机号", 32);
      this.assertStringValue(entry.name, "用户姓名", 100);
      if (!/^1\d{10}$/u.test((entry.phone as string).trim())) {
        throw new BadRequestException("手机号必须是 11 位中国大陆手机号。");
      }
      for (const [field, label] of [
        ["neighborhood", "所属区域"],
        ["regionId", "区域编号"],
        ["regionName", "区域名称"]
      ] as const) {
        if (entry[field] !== undefined) {
          this.assertStringValue(entry[field], label, 100, true);
        }
      }
      this.assertNoReservedBackofficeTags(entry.tags);
      if (entry.quota !== undefined) {
        this.assertAccessQuota(entry.quota);
      }

      return {
        phone: (entry.phone as string).trim(),
        name: (entry.name as string).trim(),
        neighborhood:
          typeof entry.neighborhood === "string"
            ? entry.neighborhood
            : undefined,
        regionId:
          typeof entry.regionId === "string" ? entry.regionId : undefined,
        regionName:
          typeof entry.regionName === "string"
            ? entry.regionName
            : undefined,
        tags: Array.isArray(entry.tags)
          ? [...(entry.tags as string[])]
          : undefined,
        quota: entry.quota as AccessQuota | undefined
      };
    });
    const incomingPhones = new Set<string>();

    for (const entry of normalizedEntries) {
      if (incomingPhones.has(entry.phone)) {
        throw new BadRequestException("导入数据中存在重复手机号。");
      }
      incomingPhones.add(entry.phone);

      const existing = this.store.users.find(
        (user) => user.phone === entry.phone
      );
      if (existing) {
        let existingTenantId: string | undefined;
        try {
          existingTenantId = this.store.getUserTenantId(existing);
        } catch {
          existingTenantId = undefined;
        }

        if (
          this.store.isControlledProviderUser(existing) ||
          this.store.isHiddenBackofficeUser(existing) ||
          existingTenantId !== tenantId
        ) {
          throw new BadRequestException("该手机号已绑定其他实例账号。");
        }
        if (existing.role !== importRole) {
          throw new BadRequestException("该手机号已绑定其他角色账号。");
        }
      }
    }

    const entriesWithRegions = normalizedEntries.map((entry) => ({
      ...entry,
      resolvedRegion: this.resolveImportRegion(
        entry.regionId,
        entry.regionName ?? entry.neighborhood,
        tenantId
      )
    }));

    const imported = entriesWithRegions.map((entry) => {
      const resolvedRegion = entry.resolvedRegion;
      const existing = this.store.users.find(
        (user) => user.phone === entry.phone
      );

      if (existing) {
        Object.assign(existing, {
          name: entry.name,
          ...(resolvedRegion.regionName !== undefined
            ? { neighborhood: resolvedRegion.regionName }
            : {}),
          ...(resolvedRegion.regionId !== undefined
            ? { regionId: resolvedRegion.regionId }
            : {}),
          ...(resolvedRegion.regionName !== undefined
            ? { regionName: resolvedRegion.regionName }
            : {}),
          ...(entry.tags !== undefined ? { tags: [...entry.tags] } : {}),
          ...(importRole === "special" && entry.quota !== undefined
            ? { quota: structuredClone(entry.quota) }
            : {}),
          status: "active",
          mobileProfileCompleted:
            importRole === "special"
              ? existing.mobileProfileCompleted
              : true
        });
        return existing;
      }

      const created: UserRecord = {
        id: this.store.createId(importRole),
        tenantId,
        role: importRole,
        phone: entry.phone,
        name: entry.name,
        status: "active",
        tags: entry.tags ?? [],
        neighborhood: resolvedRegion.regionName,
        regionId: resolvedRegion.regionId,
        regionName: resolvedRegion.regionName,
        quota: entry.quota,
        mobileProfileCompleted: importRole !== "special"
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
        role: importRole,
        count: imported.length
      }
    });

    return {
      count: imported.length,
      imported
    };
  }

  private assertPhoneAvailable(phone: string, excludedUserId?: string) {
    const existing = this.store.users.find(
      (entry) => entry.phone === phone && entry.id !== excludedUserId
    );

    if (existing) {
      throw new BadRequestException("该手机号已绑定账号，请勿重复使用。");
    }
  }

  batchUpdate(
    payload: BatchUpdatePayload,
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    this.assertBatchUpdatePayload(payload);
    this.assertNoReservedBackofficeTags(payload.patch.tags);
    if (new Set(payload.userIds).size !== payload.userIds.length) {
      throw new BadRequestException("批量更新不能包含重复用户。");
    }
    const targetUsers = payload.userIds.map((userId) => {
      const user = this.findById(userId);
      this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);
      this.assertNotControlledProviderUser(user);
      return user;
    });
    this.assertActorKeepsOwnAccess(
      targetUsers.map((user) => ({ user, nextStatus: payload.patch.status })),
      actorUserId
    );
    assertTenantsKeepActiveBackofficeAdmin(
      this.store,
      targetUsers.map((user) => ({ user, nextStatus: payload.patch.status }))
    );
    const shouldUpdateRegion =
      payload.patch.regionId !== undefined ||
      payload.patch.regionName !== undefined ||
      payload.patch.neighborhood !== undefined;
    const resolvedRegion = shouldUpdateRegion
      ? this.resolveRegion(
          payload.patch.regionId,
          payload.patch.regionName ?? payload.patch.neighborhood
        )
      : undefined;
    const prepared = targetUsers.map((user) => {
      const before = structuredClone(user);
      const after = structuredClone(user);

      if (payload.patch.status !== undefined) {
        after.status = payload.patch.status;
      }

      if (payload.patch.tags !== undefined) {
        after.tags = [...payload.patch.tags];
      }

      if (resolvedRegion) {
        after.regionId = resolvedRegion.regionId;
        after.regionName = resolvedRegion.regionName;
        after.neighborhood = resolvedRegion.regionName;
      }

      if (payload.patch.quota && after.role === "special") {
        after.quota = structuredClone(payload.patch.quota);
      }

      return { user, before, after };
    });
    const sessionsBefore = structuredClone(this.store.sessions);
    const draftSessionsBefore = structuredClone(this.store.draftSessions);
    const logsBefore = structuredClone(this.store.logs);

    try {
      for (const entry of prepared) {
        Object.assign(entry.user, entry.after);

        if (payload.patch.status !== undefined && payload.patch.status !== "active") {
          this.store.revokeSessionsForUser(entry.user.id);
        }

        this.store.logOperation({
          category: "user",
          type: "batch-update-user",
          status: "success",
          actor: this.getAdminActor(actorUserId),
          primarySubject: {
            type: "user",
            id: entry.user.id,
            label: entry.user.name
          },
          metadata: {
            ...(payload.patch as Record<string, unknown>),
            undoState: "undoable",
            beforeSnapshot: entry.before,
            afterSnapshot: structuredClone(entry.after)
          }
        });
      }
    } catch (error) {
      for (const entry of prepared) {
        const mutableUser = entry.user as unknown as Record<string, unknown>;
        for (const key of Object.keys(mutableUser)) {
          delete mutableUser[key];
        }
        Object.assign(mutableUser, structuredClone(entry.before));
      }
      this.store.sessions.clear();
      for (const [token, session] of sessionsBefore) {
        this.store.sessions.set(token, session);
      }
      this.store.draftSessions.clear();
      for (const [token, session] of draftSessionsBefore) {
        this.store.draftSessions.set(token, session);
      }
      this.store.logs.splice(0, this.store.logs.length, ...logsBefore);
      throw error;
    }

    const updated = prepared.map((entry) => entry.user);

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
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);

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

  deleteAccessPolicy(
    userId: string,
    policyId: string,
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);

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

  applyAccessPolicyNow(
    userId: string,
    policyId: string,
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);

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
      confirmed?: boolean;
      batchConsumptions?: Array<{
        batchId: string;
        quantity: number;
      }>;
    },
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    inputSource: "backoffice" | "mobile" = "backoffice",
    actorTenantId?: string
  ) {
    this.assertManualAdjustmentPayload(payload);

    if (payload.confirmed !== true) {
      throw new BadRequestException("补货或补扣前需要先确认操作。");
    }

    if (payload.direction !== "restock" && payload.direction !== "deduct") {
      throw new BadRequestException("请选择有效的库存调整方向。");
    }

    if (!Number.isFinite(payload.quantity) || !Number.isInteger(payload.quantity) || payload.quantity <= 0) {
      throw new BadRequestException("调整数量必须是正整数。");
    }

    const user = this.findById(userId);
    this.assertCanViewUser(user, actorBackofficeRole, actorTenantId);
    const device = this.store.devices.find(
      (entry) => entry.deviceCode === payload.deviceCode
    );

    if (
      !device ||
      (actorTenantId &&
        this.store.getDeviceTenantId(device) !== actorTenantId)
    ) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const localGoods = this.devicesService.findGoods(payload.deviceCode, payload.goodsId);
    const catalogGoods = this.store.goodsCatalog.find((entry) => entry.goodsId === payload.goodsId);
    const isMobileAdmin = inputSource === "mobile";
    const relatedEventId = isMobileAdmin ? undefined : payload.relatedEventId;
    const relatedOrderNo = isMobileAdmin ? undefined : payload.relatedOrderNo;
    const requestedBatchConsumptions = isMobileAdmin ? undefined : payload.batchConsumptions;
    const goodsName = isMobileAdmin
      ? localGoods?.name ?? catalogGoods?.name ?? payload.goodsId
      : payload.goodsName ?? localGoods?.name ?? catalogGoods?.name ?? payload.goodsId;
    const category = isMobileAdmin
      ? localGoods?.category ?? catalogGoods?.category ?? "daily"
      : payload.category ?? localGoods?.category ?? catalogGoods?.category ?? "daily";
    const unitPrice = isMobileAdmin
      ? localGoods?.price ?? catalogGoods?.price ?? 0
      : payload.unitPrice ?? localGoods?.price ?? catalogGoods?.price ?? 0;
    const movementId = this.store.createId("movement");
    const happenedAt = new Date().toISOString();
    const movement: InventoryMovement = {
      id: movementId,
      sourceOrderNo: relatedOrderNo,
      eventId: relatedEventId,
      userId: user.id,
      deviceCode: payload.deviceCode,
      goodsId: payload.goodsId,
      goodsName,
      category,
      quantity: payload.quantity,
      unitPrice,
      type: payload.direction === "restock" ? "manual-restock" : "manual-deduction",
      happenedAt
    };

    let createdBatchId: string | undefined;
    let consumedBatches: BatchConsumptionLine[] = [];

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
      const change = this.inventoryBatchChanges.recordRestockMovement({
        movement,
        deviceGoods: catalogItem,
        batch: {
          sourceType: "admin",
          sourceUserId: actorUserId,
          sourceUserName: this.store.users.find((entry) => entry.id === actorUserId)?.name,
          note: payload.note
        }
      });
      createdBatchId = change.createdBatches[0]?.batchId;
    } else {
      const change = this.inventoryBatchChanges.recordConsumptiveMovement({
        movement,
        requestedBatches: requestedBatchConsumptions,
        allowExpiredBatches: true,
        trace: {
          enabled: false
        }
      });
      consumedBatches = change.consumedBatches;
    }

    const log = this.store.logOperation({
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
      relatedEventId,
      relatedOrderNo,
      metadata: {
        direction: payload.direction,
        quantity: payload.quantity,
        goodsId: payload.goodsId,
        goodsName: movement.goodsName,
        note: payload.note ?? "",
        deviceCode: payload.deviceCode,
        platformSync: "local_only",
        platformSyncLabel: "仅本地，未同步平台",
        relatedEventId,
        relatedOrderNo,
        batchId: createdBatchId,
        consumedBatches,
        confirmation: {
          confirmed: true,
          confirmedAt: happenedAt,
          confirmedByUserId: actorUserId,
          batchSelection:
            payload.direction === "deduct"
              ? requestedBatchConsumptions?.length
                ? "specified"
                : "earliest_expiry"
              : "new_batch"
        },
        undoState: "undoable"
      }
    });

    if (payload.direction === "deduct") {
      const adminUser = actorUserId ? this.store.users.find((entry) => entry.id === actorUserId) : undefined;
      this.inventoryBatchChanges.recordConsumptionTraces({
        movement,
        consumedBatches,
        sourceLogId: log.id,
        consumerUserName: user.name,
        note: payload.note ?? (adminUser ? `管理员 ${adminUser.name} 手工补扣` : "管理员手工补扣")
      });
    }

    return movement;
  }

  private canViewUser(
    user: UserRecord,
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ) {
    if (viewerTenantId && this.store.isHiddenBackofficeUser(user)) {
      return false;
    }

    if (
      viewerTenantId &&
      this.store.getUserTenantId(user) !== viewerTenantId
    ) {
      return false;
    }

    return (
      viewerBackofficeRole === "super_admin" ||
      !this.store.isHiddenBackofficeUser(user)
    );
  }

  private assertCanViewUser(
    user: UserRecord,
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ) {
    if (!this.canViewUser(user, viewerBackofficeRole, viewerTenantId)) {
      throw new NotFoundException("未找到对应用户。");
    }
  }

  private assertActorKeepsOwnAccess(
    changes: Array<{
      user: UserRecord;
      nextRole?: UserRole;
      nextStatus?: UserRecord["status"];
    }>,
    actorUserId?: string
  ) {
    const ownChange = actorUserId
      ? changes.find((entry) => entry.user.id === actorUserId)
      : undefined;

    if (!ownChange) {
      return;
    }
    if (ownChange.nextStatus !== undefined && ownChange.nextStatus !== "active") {
      throw new BadRequestException("不能停用当前登录账号，请由其他管理员处理。");
    }
    if (ownChange.nextRole !== undefined && ownChange.nextRole !== ownChange.user.role) {
      throw new BadRequestException("不能修改当前登录账号的角色，请由其他管理员处理。");
    }
  }

  private assertNotControlledProviderUser(user: UserRecord) {
    if (this.store.isControlledProviderUser(user)) {
      throw new BadRequestException(
        "服务商根账号不能通过客户实例人员接口修改。"
      );
    }
  }

  private assertNoReservedBackofficeTags(tags: unknown) {
    if (tags === undefined) {
      return;
    }

    this.assertStringArray(tags, "用户标签", 50, 50);
    if (
      (tags as string[]).some((tag) =>
        RESERVED_BACKOFFICE_USER_TAGS.has(tag)
      )
    ) {
      throw new BadRequestException(
        "用户标签不能包含服务商身份保留标记。"
      );
    }
  }

  private assertUpdateUserPayload(payload: unknown) {
    const body = this.requirePlainObject(payload, "用户更新请求体");
    this.assertOnlyFields(
      body,
      ["role", "phone", "name", "status", "neighborhood", "regionId", "regionName", "tags", "quota"],
      "用户更新"
    );

    if (!Object.keys(body).length) {
      throw new BadRequestException("用户更新至少需要提交一个字段。");
    }

    if (
      body.role !== undefined &&
      body.role !== "admin" &&
      body.role !== "merchant" &&
      body.role !== "restocker" &&
      body.role !== "special"
    ) {
      throw new BadRequestException("请选择有效的用户角色。");
    }
    if (body.phone !== undefined) {
      this.assertStringValue(body.phone, "手机号", 32);
    }
    if (body.name !== undefined) {
      this.assertStringValue(body.name, "用户姓名", 100);
    }
    if (body.status !== undefined && body.status !== "active" && body.status !== "inactive") {
      throw new BadRequestException("请选择有效的用户状态。");
    }
    for (const [field, label] of [
      ["neighborhood", "所属区域"],
      ["regionId", "区域编号"],
      ["regionName", "区域名称"]
    ] as const) {
      if (body[field] !== undefined) {
        this.assertStringValue(body[field], label, 100, true);
      }
    }
    if (body.tags !== undefined) {
      this.assertStringArray(body.tags, "用户标签", 50, 50);
    }
    if (body.quota !== undefined) {
      this.assertAccessQuota(body.quota);
    }
  }

  private assertBatchUpdatePayload(payload: unknown) {
    const body = this.requirePlainObject(payload, "批量更新请求体");
    this.assertOnlyFields(body, ["userIds", "patch"], "批量更新");

    if (!Array.isArray(body.userIds) || body.userIds.length === 0 || body.userIds.length > 200) {
      throw new BadRequestException("批量更新用户编号必须是 1 至 200 项的数组。");
    }
    for (const userId of body.userIds) {
      this.assertStringValue(userId, "用户编号", 128);
    }

    const patch = this.requirePlainObject(body.patch, "批量更新字段");
    this.assertOnlyFields(
      patch,
      ["status", "tags", "neighborhood", "regionId", "regionName", "quota"],
      "批量更新字段"
    );
    if (!Object.keys(patch).length) {
      throw new BadRequestException("批量更新至少需要提交一个修改字段。");
    }
    if (patch.status !== undefined && patch.status !== "active" && patch.status !== "inactive") {
      throw new BadRequestException("请选择有效的用户状态。");
    }
    if (patch.tags !== undefined) {
      this.assertStringArray(patch.tags, "用户标签", 50, 50);
    }
    for (const [field, label] of [
      ["neighborhood", "所属区域"],
      ["regionId", "区域编号"],
      ["regionName", "区域名称"]
    ] as const) {
      if (patch[field] !== undefined) {
        this.assertStringValue(patch[field], label, 100, true);
      }
    }
    if (patch.quota !== undefined) {
      this.assertAccessQuota(patch.quota);
    }
  }

  private assertBatchRemovePayload(payload: unknown) {
    const body = this.requirePlainObject(payload, "批量删除请求体");
    this.assertOnlyFields(body, ["userIds", "confirmedCount"], "批量删除");

    if (!Array.isArray(body.userIds) || body.userIds.length === 0 || body.userIds.length > 200) {
      throw new BadRequestException("批量删除用户编号必须是 1 至 200 项的数组。");
    }
    for (const userId of body.userIds) {
      this.assertStringValue(userId, "用户编号", 128);
    }

    if (
      typeof body.confirmedCount !== "number" ||
      !Number.isSafeInteger(body.confirmedCount) ||
      body.confirmedCount <= 0
    ) {
      throw new BadRequestException("批量删除确认人数必须是正整数。");
    }
    if (body.confirmedCount !== body.userIds.length) {
      throw new BadRequestException("批量删除确认人数必须与所选人数一致。");
    }
  }

  private assertCanRemoveUsers(users: UserRecord[], actorUserId?: string) {
    if (actorUserId && users.some((user) => user.id === actorUserId)) {
      throw new BadRequestException("不能删除当前登录账号。");
    }

    assertTenantsKeepActiveBackofficeAdmin(
      this.store,
      users.map((user) => ({ user, nextStatus: "inactive" }))
    );
  }

  private assertManualAdjustmentPayload(payload: unknown) {
    const body = this.requirePlainObject(payload, "手工库存调整请求体");
    this.assertOnlyFields(
      body,
      [
        "deviceCode",
        "goodsId",
        "relatedEventId",
        "relatedOrderNo",
        "goodsName",
        "category",
        "quantity",
        "unitPrice",
        "direction",
        "note",
        "confirmed",
        "batchConsumptions"
      ],
      "手工库存调整"
    );

    this.assertStringValue(body.deviceCode, "柜机编号", 128);
    this.assertStringValue(body.goodsId, "货品编号", 128);

    for (const [field, label] of [
      ["relatedEventId", "关联事件编号"],
      ["relatedOrderNo", "关联订单号"]
    ] as const) {
      if (body[field] !== undefined) {
        this.assertStringValue(body[field], label, 128, true);
      }
    }

    if (body.goodsName !== undefined) {
      this.assertStringValue(body.goodsName, "货品名称", 100);
    }
    if (
      body.category !== undefined &&
      body.category !== "food" &&
      body.category !== "drink" &&
      body.category !== "daily"
    ) {
      throw new BadRequestException("请选择有效的货品分类。");
    }
    if (
      typeof body.quantity !== "number" ||
      !Number.isFinite(body.quantity) ||
      !Number.isInteger(body.quantity) ||
      body.quantity <= 0
    ) {
      throw new BadRequestException("调整数量必须是正整数。");
    }
    if (
      body.unitPrice !== undefined &&
      (typeof body.unitPrice !== "number" ||
        !Number.isFinite(body.unitPrice) ||
        body.unitPrice < 0)
    ) {
      throw new BadRequestException("货品单价必须是非负数。");
    }
    if (body.direction !== "restock" && body.direction !== "deduct") {
      throw new BadRequestException("请选择有效的库存调整方向。");
    }
    if (body.note !== undefined) {
      this.assertStringValue(body.note, "调整说明", 500, true);
    }
    if (body.confirmed !== true) {
      throw new BadRequestException("补货或补扣前需要先确认操作。");
    }

    if (body.batchConsumptions !== undefined) {
      if (!Array.isArray(body.batchConsumptions) || body.batchConsumptions.length > 100) {
        throw new BadRequestException("指定批次必须是最多 100 项的数组。");
      }

      for (const item of body.batchConsumptions) {
        const batch = this.requirePlainObject(item, "指定批次");
        this.assertOnlyFields(batch, ["batchId", "quantity"], "指定批次");
        this.assertStringValue(batch.batchId, "批次编号", 128);
        if (
          typeof batch.quantity !== "number" ||
          !Number.isFinite(batch.quantity) ||
          !Number.isInteger(batch.quantity) ||
          batch.quantity <= 0
        ) {
          throw new BadRequestException("指定批次数量必须是正整数。");
        }
      }
    }
  }

  private requirePlainObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(`${label}必须是对象。`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BadRequestException(`${label}必须是普通对象。`);
    }

    return value as Record<string, unknown>;
  }

  private assertOnlyFields(
    value: Record<string, unknown>,
    allowedFields: readonly string[],
    label: string
  ) {
    const allowed = new Set(allowedFields);
    const unexpectedFields = Object.keys(value).filter((field) => !allowed.has(field));

    if (unexpectedFields.length) {
      throw new BadRequestException(`${label}不能提交字段：${unexpectedFields.join("、")}。`);
    }
  }

  private assertStringValue(
    value: unknown,
    label: string,
    maxLength: number,
    allowEmpty = false
  ) {
    if (typeof value !== "string") {
      throw new BadRequestException(`${label}必须是字符串。`);
    }

    const normalized = value.trim();
    if (!allowEmpty && !normalized) {
      throw new BadRequestException(`${label}不能为空。`);
    }
    if ([...value].length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符。`);
    }
  }

  private assertStringArray(value: unknown, label: string, maxItems: number, maxItemLength: number) {
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new BadRequestException(`${label}必须是最多 ${maxItems} 项的字符串数组。`);
    }

    for (const item of value) {
      this.assertStringValue(item, label, maxItemLength);
    }
  }

  private assertAccessQuota(value: unknown) {
    const quota = this.requirePlainObject(value, "用户额度");
    this.assertOnlyFields(quota, ["dailyLimit", "categoryLimit"], "用户额度");

    if (
      typeof quota.dailyLimit !== "number" ||
      !Number.isInteger(quota.dailyLimit) ||
      quota.dailyLimit < 0
    ) {
      throw new BadRequestException("每日额度必须是非负整数。");
    }

    const categoryLimit = this.requirePlainObject(quota.categoryLimit, "分类额度");
    if (Object.keys(categoryLimit).length > 100) {
      throw new BadRequestException("分类额度不能超过 100 项。");
    }
    const allowedCategories = new Set(["food", "drink", "daily"]);
    for (const [category, limit] of Object.entries(categoryLimit)) {
      this.assertStringValue(category, "额度分类", 100);
      if (!allowedCategories.has(category)) {
        throw new BadRequestException(`不支持的额度分类：${category}。`);
      }
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
        throw new BadRequestException("分类额度必须是非负整数。");
      }
    }
  }

  private decorateUser(user: UserRecord): UserRecord {
    const region = this.store.normalizeUserRegion(user);

    return {
      ...user,
      regionId: region.regionId,
      regionName: region.regionName,
      neighborhood: region.regionName,
      assignedDeviceCodes: this.getAssignedDeviceCodes(user),
      ledgerStatus: this.getLedgerStatus(user)
    };
  }

  private getAssignedDeviceCodes(user: UserRecord) {
    return [
      ...(user.assignedDeviceCodes ?? user.merchantProfile?.defaultDeviceCodes ?? [])
    ];
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

  private resolveImportRegion(regionId?: string, regionName?: string, tenantId?: string) {
    const normalizedRegionId = regionId?.trim();
    const normalizedRegionName = regionName?.trim();
    if (!normalizedRegionId && !normalizedRegionName) {
      return { regionId: undefined, regionName: undefined };
    }

    const matchedById = this.store.getRegion(normalizedRegionId);
    const matchedByName = normalizedRegionName
      ? this.store.regions.find(
          (entry) => entry.status === "active" && entry.name === normalizedRegionName
        )
      : undefined;

    if (
      (normalizedRegionId && matchedById?.status !== "active") ||
      (normalizedRegionName && !matchedByName)
    ) {
      throw new BadRequestException(
        tenantId
          ? "导入区域未配置，请先在当前实例新增区域并设置位置。"
          : "导入区域未配置，请先新增区域并设置位置。"
      );
    }

    if (matchedById && matchedByName && matchedById.id !== matchedByName.id) {
      throw new BadRequestException("区域编号与区域名称不一致。");
    }

    const matched =
      matchedById?.status === "active" ? matchedById : matchedByName;
    if (matched) {
      return { regionId: matched.id, regionName: matched.name };
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
