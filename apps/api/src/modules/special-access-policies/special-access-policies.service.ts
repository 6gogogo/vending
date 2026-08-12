import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { EntitlementLimit, SpecialAccessPolicy, UserRole } from "@vm/shared-types";

import { addDaysToDateKey, getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class SpecialAccessPoliciesService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list() {
    return this.store.specialAccessPolicies;
  }

  create(
    payload: Omit<SpecialAccessPolicy, "id">,
    actorUserId?: string
  ) {
    const normalized = this.normalizePolicyPayload(payload);
    const policy: SpecialAccessPolicy = {
      id: this.store.createId("policy"),
      ...normalized
    };

    this.store.specialAccessPolicies.unshift(policy);
    this.store.logOperation({
      category: "policy",
      type: "create-special-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyId: policy.id,
        policyName: policy.name
      }
    });

    return policy;
  }

  update(
    id: string,
    payload: Partial<Omit<SpecialAccessPolicy, "id">>,
    actorUserId?: string
  ) {
    const policy = this.findById(id);
    const normalized = this.normalizePolicyPayload({
      ...policy,
      ...payload
    });

    Object.assign(policy, normalized);
    this.store.logOperation({
      category: "policy",
      type: "update-special-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyId: policy.id,
        policyName: policy.name
      }
    });

    return policy;
  }

  batchAssign(
    payload: {
      userIds: string[];
      policyIds: string[];
      mode: "bind" | "unbind" | "replace";
    },
    actorUserId?: string
  ) {
    if (!payload.userIds.length) {
      throw new BadRequestException("请选择要下发策略的用户。");
    }

    if (!payload.policyIds.length) {
      throw new BadRequestException("请选择要下发的领取策略。");
    }

    const targetPolicies = this.store.specialAccessPolicies.filter((policy) =>
      payload.policyIds.includes(policy.id)
    );
    const targetUsers = this.store.users.filter(
      (user) => payload.userIds.includes(user.id) && user.role === "special"
    );

    if (targetPolicies.length !== payload.policyIds.length) {
      throw new BadRequestException("存在未找到的领取策略。");
    }

    if (!targetUsers.length) {
      throw new BadRequestException("请选择普通用户下发领取策略。");
    }

    const businessDateKey = getBusinessDayKey(new Date());
    const nextBusinessDateKey = addDaysToDateKey(businessDateKey, 1);

    if (payload.mode === "replace") {
      for (const policy of this.store.specialAccessPolicies) {
        policy.applicableUserIds = policy.applicableUserIds.filter(
          (userId) => !payload.userIds.includes(userId)
        );
      }

      for (const user of targetUsers) {
        for (const entry of user.accessPolicies ?? []) {
          entry.status = "inactive";
          entry.effectiveToDateKey = businessDateKey;
          entry.updatedAt = new Date().toISOString();
        }
      }
    }

    for (const policy of targetPolicies) {
      if (payload.mode === "unbind") {
        policy.applicableUserIds = policy.applicableUserIds.filter(
          (userId) => !payload.userIds.includes(userId)
        );

        for (const user of targetUsers) {
          for (const entry of user.accessPolicies ?? []) {
            if (entry.sourcePolicyId === policy.id && entry.status === "active") {
              entry.status = "inactive";
              entry.effectiveToDateKey = businessDateKey;
              entry.updatedAt = new Date().toISOString();
            }
          }
        }
        continue;
      }

      policy.applicableUserIds = Array.from(
        new Set([...policy.applicableUserIds, ...payload.userIds])
      );

      for (const user of targetUsers) {
        const currentPolicies = user.accessPolicies ?? [];
        const now = new Date().toISOString();
        for (const entry of currentPolicies) {
          if (entry.sourcePolicyId === policy.id && entry.status === "active") {
            entry.status = "inactive";
            entry.effectiveToDateKey = businessDateKey;
            entry.updatedAt = now;
          }
        }

        const copiedPolicies = policy.entitlementLimits?.length
          ? [{
              id: this.store.createId("user-policy"),
              name: policy.name,
              weekdays: [...policy.weekdays],
              startHour: policy.startHour,
              endHour: policy.endHour,
              goodsLimits: policy.goodsLimits.map((limit) => ({ ...limit })),
              entitlementLimits: policy.entitlementLimits.map((limit) => ({ ...limit })),
              status: policy.status,
              sourcePolicyId: policy.id,
              effectiveFromDateKey: nextBusinessDateKey,
              createdAt: now,
              updatedAt: now
            }]
          : policy.goodsLimits.map((limit) => ({
              id: this.store.createId("user-policy"),
              name: `${policy.name} · ${limit.goodsName}`,
              weekdays: [...policy.weekdays],
              startHour: policy.startHour,
              endHour: policy.endHour,
              goodsLimits: [{ ...limit }],
              status: policy.status,
              sourcePolicyId: policy.id,
              effectiveFromDateKey: nextBusinessDateKey,
              createdAt: now,
              updatedAt: now
            }));

        currentPolicies.unshift(...copiedPolicies);
        user.accessPolicies = currentPolicies;
      }
    }

    this.store.logOperation({
      category: "policy",
      type: "batch-assign-special-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        userIds: payload.userIds,
        policyIds: payload.policyIds,
        mode: payload.mode
      }
    });

    return this.list();
  }

  private findById(id: string) {
    const policy = this.store.specialAccessPolicies.find((entry) => entry.id === id);

    if (!policy) {
      throw new NotFoundException("未找到对应策略模板。");
    }

    return policy;
  }

  private normalizePolicyPayload(payload: Omit<SpecialAccessPolicy, "id">): Omit<SpecialAccessPolicy, "id"> {
    const name = payload.name?.trim();

    if (!name) {
      throw new BadRequestException("策略名称不能为空。");
    }

    const startHour = Number(payload.startHour);
    const endHour = Number(payload.endHour);

    if (
      !Number.isFinite(startHour) ||
      !Number.isFinite(endHour) ||
      startHour < 0 ||
      endHour > 24 ||
      endHour <= startHour
    ) {
      throw new BadRequestException("结束时间必须晚于开始时间，且时间范围应在 0 到 24 点之间。");
    }

    const weekdays = Array.from(new Set((payload.weekdays ?? []).map((weekday) => Number(weekday))))
      .filter((weekday) => Number.isInteger(weekday))
      .sort((left, right) => left - right);

    if (!weekdays.length || weekdays.some((weekday) => weekday < 0 || weekday > 6)) {
      throw new BadRequestException("请选择有效的可领取星期。");
    }

    if (!payload.goodsLimits?.length && !payload.entitlementLimits?.length) {
      throw new BadRequestException("请至少设置一种可领取物资。");
    }
    if (payload.goodsLimits?.length && payload.entitlementLimits?.length) {
      throw new BadRequestException("旧货品额度与分类额度不能同时提交，请选择一种规则模型。");
    }

    const goodsLimits = (payload.goodsLimits ?? []).map((limit) => {
      const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === limit.goodsId);
      const quantity = Math.floor(Number(limit.quantity));

      if (!goods) {
        throw new NotFoundException(`未找到货品 ${limit.goodsId}。`);
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException("领取物资数量必须大于 0。");
      }

      return {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        quantity
      };
    });
    const entitlementLimits = this.normalizeEntitlementLimits(payload.entitlementLimits ?? []);

    return {
      ...payload,
      name,
      weekdays,
      startHour,
      endHour,
      goodsLimits,
      entitlementLimits,
      applicableUserIds: Array.from(new Set(payload.applicableUserIds ?? [])),
      status: payload.status === "inactive" ? "inactive" : "active"
    };
  }

  private normalizeEntitlementLimits(limits: EntitlementLimit[]) {
    const seenIds = new Set<string>();
    const seenTargets = new Set<string>();
    return limits.map((limit) => {
      const id = String(limit.id ?? "").trim();
      const targetId = String(limit.targetId ?? "").trim();
      const quantity = Number(limit.quantity);
      if (!id || seenIds.has(id)) {
        throw new BadRequestException("分类额度标识不能为空且不能重复。");
      }
      seenIds.add(id);
      if (!targetId || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new BadRequestException("分类额度必须包含有效目标和正整数数量。");
      }
      if (limit.targetType === "taxonomy_node") {
        const node = this.store.goodsTaxonomyNodes.find(
          (entry) => entry.id === targetId && entry.status === "active"
        );
        if (!node) throw new BadRequestException("分类额度目标不存在或已停用。");
      } else if (limit.targetType === "goods") {
        const goods = this.store.goodsCatalog.find(
          (entry) => entry.goodsId === targetId && entry.status !== "inactive"
        );
        if (!goods) throw new BadRequestException("货品额度目标不存在或已停用。");
      } else {
        throw new BadRequestException("不支持的额度目标类型。");
      }
      const targetKey = `${limit.targetType}:${targetId}`;
      if (seenTargets.has(targetKey)) {
        throw new BadRequestException("同一分类或货品只能设置一个额度池。");
      }
      seenTargets.add(targetKey);
      return { id, targetType: limit.targetType, targetId, quantity };
    });
  }

  private getActor(actorUserId?: string) {
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role as UserRole
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
