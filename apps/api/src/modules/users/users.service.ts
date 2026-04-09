import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { AccessQuota, InventoryMovement, UserManagementDetail, UserRecord, UserRole } from "@vm/shared-types";

import {
  summarizeBusinessDayForUser
} from "../../common/policies/special-access-policy.utils";
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
    if (!role) {
      return this.store.users;
    }

    return this.store.users.filter((user) => user.role === role);
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

  detail(userId: string): UserManagementDetail {
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

    const applicablePolicies =
      user.role === "special"
        ? this.store.specialAccessPolicies.filter(
            (policy) =>
              policy.status === "active" && policy.applicableUserIds.includes(user.id)
          )
        : undefined;

    const businessDaySummary =
      user.role === "special"
        ? summarizeBusinessDayForUser(
            user,
            this.store.specialAccessPolicies,
            this.store.inventory,
            this.store.goodsCatalog
          )
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
      user,
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
      applicablePolicies,
      businessDaySummary
    };
  }

  createUser(payload: {
    role: UserRole;
    phone: string;
    name: string;
    status?: UserRecord["status"];
    neighborhood?: string;
    tags?: string[];
    quota?: AccessQuota;
  }, actorUserId?: string) {
    const created: UserRecord = {
      id: this.store.createId(payload.role),
      role: payload.role,
      phone: payload.phone,
      name: payload.name,
      status: payload.status ?? "active",
      neighborhood: payload.neighborhood,
      tags: payload.tags ?? [],
      quota: payload.role === "special" ? payload.quota : undefined
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
      tags?: string[];
      quota?: AccessQuota;
    },
    actorUserId?: string
  ) {
    const user = this.findById(userId);

    if (payload.phone !== undefined) {
      user.phone = payload.phone;
    }

    if (payload.name !== undefined) {
      user.name = payload.name;
    }

    if (payload.status !== undefined) {
      user.status = payload.status;
    }

    if (payload.neighborhood !== undefined) {
      user.neighborhood = payload.neighborhood;
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
      }
    });

    return user;
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
        neighborhood: entry.neighborhood,
        quota: entry.quota,
        merchantProfile: entry.merchantProfile
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

      if (payload.patch.status !== undefined) {
        user.status = payload.patch.status;
      }

      if (payload.patch.tags) {
        user.tags = payload.patch.tags;
      }

      if (payload.patch.neighborhood !== undefined) {
        user.neighborhood = payload.patch.neighborhood;
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
        metadata: payload.patch as Record<string, unknown>
      });

      return user;
    });

    return {
      count: updated.length,
      updated
    };
  }

  manualAdjustment(
    userId: string,
    payload: {
      deviceCode: string;
      goodsId: string;
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
    this.devicesService.adjustStock(
      payload.deviceCode,
      payload.goodsId,
      payload.direction === "restock" ? payload.quantity : -payload.quantity
    );

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
      metadata: {
        direction: payload.direction,
        quantity: payload.quantity,
        goodsId: payload.goodsId,
        goodsName: movement.goodsName,
        note: payload.note ?? ""
      }
    });

    return movement;
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
