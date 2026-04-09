import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import type { GoodsCategory, UserRecord } from "@vm/shared-types";

import { getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import {
  getActiveWindowCategoryQuota
} from "../../common/policies/special-access-policy.utils";

@Injectable()
export class AccessRulesService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list() {
    return this.store.rules;
  }

  update(role: "special" | "merchant", patch: { dailyLimit?: number; categoryLimit?: Record<string, number> }) {
    const rule = this.store.rules.find((entry) => entry.role === role);

    if (!rule) {
      throw new BadRequestException("未找到对应规则。");
    }

    if (patch.dailyLimit !== undefined) {
      rule.dailyLimit = patch.dailyLimit;
    }

    if (patch.categoryLimit) {
      rule.categoryLimit = patch.categoryLimit;
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
    const todayPickups = this.store.inventory.filter(
      (entry) =>
        entry.userId === user.id &&
        entry.type === "pickup" &&
        getBusinessDayKey(entry.happenedAt) === getBusinessDayKey(new Date())
    );
    const policyQuota = getActiveWindowCategoryQuota(
      this.store.specialAccessPolicies,
      user.id,
      this.store.inventory,
      this.store.goodsCatalog,
      new Date()
    );

    const remainingToday =
      Object.keys(policyQuota.remainingByCategory).length > 0
        ? policyQuota.remainingByCategory
        : Object.entries(quota?.categoryLimit ?? {}).reduce<Record<string, number>>(
            (accumulator, [category, limit]) => {
              const usedByCategory = todayPickups
                .filter((entry) => entry.category === category)
                .reduce((sum, entry) => sum + entry.quantity, 0);
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
      usedCount: todayPickups.reduce((sum, entry) => sum + entry.quantity, 0),
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

  assertCanOpenSpecialCabinet(user: UserRecord, category?: GoodsCategory) {
    const summary = this.getQuotaSummaryForUser(user);
    const activeWindows = summary.activeWindows ?? [];

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
