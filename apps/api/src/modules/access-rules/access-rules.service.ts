import { BadRequestException, Inject, Injectable } from "@nestjs/common";

import type { GoodsCategory, UserRecord } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

const isSameDay = (left: string, right: string) =>
  new Date(left).toDateString() === new Date(right).toDateString();

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
        isSameDay(entry.happenedAt, new Date().toISOString())
    );

    const usedByCategory = todayPickups.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.category] = (accumulator[entry.category] ?? 0) + entry.quantity;
      return accumulator;
    }, {});

    const remainingToday = Object.entries(quota?.categoryLimit ?? {}).reduce<Record<string, number>>(
      (accumulator, [category, limit]) => {
        accumulator[category] = Math.max(0, (limit ?? 0) - (usedByCategory[category] ?? 0));
        return accumulator;
      },
      {}
    );

    return {
      role: user.role,
      limit: quota,
      remainingToday,
      usedCount: todayPickups.reduce((sum, entry) => sum + entry.quantity, 0)
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
    const dailyLimit = summary.limit?.dailyLimit ?? 0;

    if ((summary.usedCount ?? 0) >= dailyLimit) {
      throw new BadRequestException("今日免费领取次数已用完。");
    }

    if (category) {
      const remainingForCategory = (summary.remainingToday as Record<string, number>)[category] ?? 0;

      if (remainingForCategory <= 0) {
        throw new BadRequestException(`当前品类 ${category} 的领取额度已用完。`);
      }
    }

    return summary;
  }
}
