import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import type { GoodsCategory, UserRecord } from "@vm/shared-types";

import { getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import {
  getActiveWindowCategoryQuota,
  getActiveWindowEntitlementQuota,
  sumNetQuotaQuantity
} from "../../common/policies/special-access-policy.utils";

const GOODS_CATEGORIES = new Set<GoodsCategory>(["food", "drink", "daily"]);

@Injectable()
export class AccessRulesService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list() {
    return this.store.rules;
  }

  update(
    role: "special" | "merchant",
    patch: { dailyLimit?: number; categoryLimit?: Record<string, number> },
    actorUserId?: string
  ) {
    if (!role) {
      throw new BadRequestException("请选择要配置的角色。");
    }

    const rule = this.store.rules.find((entry) => entry.role === role);

    if (!rule) {
      throw new BadRequestException("未找到对应规则。");
    }

    let nextDailyLimit = rule.dailyLimit;
    let nextCategoryLimit = rule.categoryLimit;

    if (patch.dailyLimit !== undefined) {
      const dailyLimit = Number(patch.dailyLimit);

      if (!Number.isFinite(dailyLimit) || !Number.isInteger(dailyLimit) || dailyLimit < 0) {
        throw new BadRequestException("每日额度必须是非负整数。");
      }

      nextDailyLimit = dailyLimit;
    }

    if (patch.categoryLimit) {
      const normalizedCategoryLimit: Partial<Record<GoodsCategory, number>> = {};

      for (const [category, value] of Object.entries(patch.categoryLimit)) {
        if (!GOODS_CATEGORIES.has(category as GoodsCategory)) {
          throw new BadRequestException(`不支持的货品品类：${category}`);
        }

        const limit = Number(value);

        if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) {
          throw new BadRequestException("品类额度必须是非负整数。");
        }

        normalizedCategoryLimit[category as GoodsCategory] = limit;
      }

      nextCategoryLimit = normalizedCategoryLimit;
    }

    const actor = actorUserId
      ? this.store.users.find((entry) => entry.id === actorUserId && entry.role === "admin")
      : undefined;
    const beforeMutation = structuredClone(rule);
    const logsBeforeMutation = structuredClone(this.store.logs);

    try {
      // 全部字段校验通过后再一次性提交，避免失败请求留下半更新状态。
      rule.dailyLimit = nextDailyLimit;
      rule.categoryLimit = nextCategoryLimit;

      this.store.logOperation({
        category: "admin",
        type: "update-access-rule",
        status: "success",
        actor: {
          type: "admin",
          id: actor?.id,
          name: actor?.name ?? "管理员",
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
    } catch (error) {
      Object.assign(rule, beforeMutation);
      this.store.logs.splice(0, this.store.logs.length, ...logsBeforeMutation);
      throw error;
    }
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
    const entitlementQuota = getActiveWindowEntitlementQuota(
      user,
      this.store.specialAccessPolicies,
      this.store.inventory,
      this.store.goodsCatalog,
      this.store.goodsTaxonomyNodes,
      new Date()
    );
    if (entitlementQuota.remainingPools.length > 0) {
      const remainingToday = this.store.goodsCatalog.reduce<Record<string, number>>(
        (result, goods) => {
          result[goods.category] = Math.max(
            result[goods.category] ?? 0,
            entitlementQuota.receivableByGoods[goods.goodsId] ?? 0
          );
          return result;
        },
        {}
      );
      return {
        role: user.role,
        limit: quota,
        remainingToday,
        remainingByGoods: entitlementQuota.receivableByGoods,
        receivableByGoods: entitlementQuota.receivableByGoods,
        remainingPools: entitlementQuota.remainingPools,
        taxonomyRevision: this.store.goodsTaxonomyNodes.reduce(
          (maximum, node) => Math.max(maximum, node.revision),
          0
        ),
        usedCount: entitlementQuota.remainingPools.reduce((sum, pool) => sum + pool.quantity - pool.remaining, 0),
        remainingDaily: entitlementQuota.remainingTotal,
        remainingFreeTotal: entitlementQuota.remainingTotal,
        activeWindows: entitlementQuota.activeWindows
      };
    }
    // 对用户来说，额度不仅是数量控制，也是在有限供给下尽量保证关键时段有人能领到物资。
    const policyQuota = getActiveWindowCategoryQuota(
      user,
      this.store.specialAccessPolicies,
      this.store.inventory,
      this.store.goodsCatalog,
      new Date()
    );

    const usedCount = sumNetQuotaQuantity(
      this.store.inventory,
      (entry) =>
        entry.userId === user.id &&
        getBusinessDayKey(entry.happenedAt) === currentBusinessDayKey
    );
    const configuredRemainingDaily = Math.max(0, (quota?.dailyLimit ?? 0) - usedCount);
    const policyRemainingTotal = Object.values(policyQuota.remainingByGoods).reduce(
      (sum, value) => sum + Math.max(0, value),
      0
    );
    const personalPolicyIds = new Set((user.accessPolicies ?? []).map((entry) => entry.id));
    const hasActivePersonalPolicy = policyQuota.activeWindows.some((window) =>
      personalPolicyIds.has(window.policyId)
    );
    // 个人每日可领取物资是当前后台的明确授权来源。存量人员可能仍带有旧版零总额度；
    // 此时不能让废弃字段覆盖已生效的个人设定。模板规则和正数总额度仍保留原上限语义。
    const remainingDaily =
      (quota?.dailyLimit ?? 0) > 0 || !hasActivePersonalPolicy || policyRemainingTotal === 0
        ? configuredRemainingDaily
        : policyRemainingTotal;
    const uncappedRemainingToday =
      Object.keys(policyQuota.remainingByCategory).length > 0
        ? policyQuota.remainingByCategory
        : Object.entries(quota?.categoryLimit ?? {}).reduce<Record<string, number>>(
            (accumulator, [category, limit]) => {
              const usedByCategory = sumNetQuotaQuantity(
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
    const remainingToday = this.capEachQuotaByTotal(uncappedRemainingToday, remainingDaily);
    const remainingByGoods = this.capEachQuotaByTotal(policyQuota.remainingByGoods, remainingDaily);
    const aggregateRemaining = Object.values(
      Object.keys(remainingByGoods).length ? remainingByGoods : remainingToday
    ).reduce((sum, value) => sum + value, 0);
    const remainingFreeTotal = Math.min(remainingDaily, aggregateRemaining);

    return {
      role: user.role,
      limit: quota,
      remainingToday,
      remainingByGoods,
      usedCount,
      remainingDaily,
      remainingFreeTotal,
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

  assertCanOpenSpecialCabinet(user: UserRecord) {
    const summary = this.getQuotaSummaryForUser(user);
    const activeWindows = summary.activeWindows ?? [];

    // 服务时段决定用户当前是否具备开柜资格；免费额度只参与后续预结算，
    // 额度为零时仍可按货品价格继续，不能在计价前把请求直接拦掉。
    if (!activeWindows.length) {
      throw new BadRequestException("当前不在可领取时间段内。");
    }

    return summary;
  }

  private capEachQuotaByTotal(values: Record<string, number>, totalLimit: number) {
    const remaining = Math.max(0, totalLimit);
    return Object.entries(values).reduce<Record<string, number>>((result, [key, rawValue]) => {
      const value = Number.isFinite(rawValue) ? Math.max(0, Math.floor(rawValue)) : 0;
      result[key] = Math.min(value, remaining);
      return result;
    }, {});
  }
}
