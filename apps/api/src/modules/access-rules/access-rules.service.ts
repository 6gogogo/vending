import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import type { GoodsCategory, UserRecord } from "@vm/shared-types";

import { getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import {
  getActiveWindowCategoryQuota,
  sumNetPickupQuantity
} from "../../common/policies/special-access-policy.utils";

@Injectable()
export class AccessRulesService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list() {
    return this.store.rules;
  }

  update(role: "special" | "merchant", patch: { dailyLimit?: number; categoryLimit?: Record<string, number> }) {
    if (!role) {
      throw new BadRequestException("请选择要配置的角色。");
    }

    const rule = this.store.rules.find((entry) => entry.role === role);

    if (!rule) {
      throw new BadRequestException("未找到对应规则。");
    }

    if (patch.dailyLimit !== undefined) {
      const dailyLimit = Math.floor(Number(patch.dailyLimit));

      if (!Number.isFinite(dailyLimit) || dailyLimit < 0) {
        throw new BadRequestException("每日额度不能为负数。");
      }

      rule.dailyLimit = dailyLimit;
    }

    if (patch.categoryLimit) {
      const nextCategoryLimit: Record<string, number> = {};

      for (const [category, value] of Object.entries(patch.categoryLimit)) {
        const limit = Math.floor(Number(value));

        if (!Number.isFinite(limit) || limit < 0) {
          throw new BadRequestException("品类额度不能为负数。");
        }

        nextCategoryLimit[category] = limit;
      }

      rule.categoryLimit = nextCategoryLimit;
    }

    this.store.logOperation({
      category: "admin",
      type: "update-access-rule",
      status: "success",
      actor: {
        type: "admin",
        id: this.store.users.find((entry) => entry.role === "admin")?.id,
        name: this.store.users.find((entry) => entry.role === "admin")?.name ?? "管理员",
        role: "admin"
      },
      description: `管理员更新了 ${role} 角色的领取规则。`,
      detail: `每日上限 ${rule.dailyLimit}，品类限制 ${JSON.stringify(rule.categoryLimit)}。`,
      metadata: {
        role,
        dailyLimit: rule.dailyLimit
      }
    });

    return rule;
  }

  getQuotaSummaryForUser(user: UserRecord) {
    if (user.role !== "special") {
      return {
        role: user.role,
        remainingToday: {},
        limit: this.store.rules.find((rule) => rule.role === user.role)
      };
    }

    const quota = user.quota ?? this.store.rules.find((rule) => rule.role === "special");
    const currentBusinessDayKey = getBusinessDayKey(new Date());
    // 对用户来说，额度不仅是数量控制，也是在有限供给下尽量保证关键时段有人能领到物资。
    const policyQuota = getActiveWindowCategoryQuota(
      user,
      this.store.specialAccessPolicies,
      this.store.inventory,
      this.store.goodsCatalog,
      new Date()
    );

    const remainingToday =
      Object.keys(policyQuota.remainingByCategory).length > 0
        ? policyQuota.remainingByCategory
        : Object.entries(quota?.categoryLimit ?? {}).reduce<Record<string, number>>(
            (accumulator, [category, limit]) => {
              const usedByCategory = sumNetPickupQuantity(
                this.store.inventory,
                (entry) =>
                  entry.userId === user.id &&
                  entry.category === category &&
                  getBusinessDayKey(entry.happenedAt) === currentBusinessDayKey
              );
              accumulator[category] = Math.max(0, (limit ?? 0) - usedByCategory);
              return accumulator;
            },
            {}
          );

    return {
      role: user.role,
      limit: quota,
      remainingToday,
      remainingByGoods: policyQuota.remainingByGoods,
      usedCount: sumNetPickupQuantity(
        this.store.inventory,
        (entry) =>
          entry.userId === user.id &&
          getBusinessDayKey(entry.happenedAt) === currentBusinessDayKey
      ),
      activeWindows: policyQuota.activeWindows
    };
  }

  getQuotaSummaryByPhone(phone: string) {
    const user = this.store.users.find((entry) => entry.phone === phone);

    if (!user) {
      throw new BadRequestException("该手机号未登记。");
    }

    return this.getQuotaSummaryForUser(user);
  }

  getQuotaSummaryByUserId(userId?: string) {
    const user = userId ? this.store.users.find((entry) => entry.id === userId) : undefined;

    if (!user) {
      throw new BadRequestException("当前登录态已失效，请重新登录。");
    }

    return this.getQuotaSummaryForUser(user);
  }

  assertCanOpenSpecialCabinet(user: UserRecord, category?: GoodsCategory) {
    const summary = this.getQuotaSummaryForUser(user);
    const activeWindows = summary.activeWindows ?? [];

    // 先拦住不在服务窗口的请求，避免用户走到柜前才发现今天这个时段根本不能领取。
    if (!activeWindows.length) {
      throw new BadRequestException("当前不在可领取时间段内。");
    }

    if (category) {
      const remainingForCategory = (summary.remainingToday as Record<string, number>)[category] ?? 0;

      if (remainingForCategory <= 0) {
        throw new BadRequestException(`当前品类 ${category} 的领取额度已用完。`);
      }
    } else if (
      Object.values((summary.remainingByGoods as Record<string, number> | undefined) ?? {}).every(
        (value) => value <= 0
      )
    ) {
      throw new BadRequestException("当前时间段内没有可领取额度。");
    }

    return summary;
  }
}
