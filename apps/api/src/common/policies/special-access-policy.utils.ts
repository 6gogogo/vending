import type {
  GoodsCatalogItem,
  GoodsCategory,
  InventoryMovement,
  ServiceCompletionStatus,
  SpecialAccessPolicy,
  SpecialAccessWindowUsage,
  UserRecord
} from "@vm/shared-types";

import {
  addDaysToDateKey,
  getBusinessDayKey,
  getBusinessDayStartHour,
  getLocalDateParts,
  getWeekdayForDateKey,
  toDateKey
} from "../time/business-day";

interface PolicyWindow {
  policyId: string;
  policyName: string;
  weekdays: number[];
  dateKey: string;
  startHour: number;
  endHour: number;
  goodsLimits: SpecialAccessPolicy["goodsLimits"];
}

type EffectivePolicy = Omit<SpecialAccessPolicy, "applicableUserIds"> & {
  applicableUserIds?: string[];
  effectiveFromDateKey?: string;
  effectiveToDateKey?: string;
};

const buildCatalogMap = (catalog: GoodsCatalogItem[]) =>
  new Map(catalog.map((item) => [item.goodsId, item]));

export const getApplicablePoliciesForUser = (
  policies: SpecialAccessPolicy[],
  userId: string,
  status: SpecialAccessPolicy["status"] = "active"
) =>
  policies.filter(
    (policy) =>
      policy.status === status && policy.applicableUserIds.includes(userId)
  );

export const getEffectivePoliciesForUser = (
  user: UserRecord,
  templates: SpecialAccessPolicy[],
  status: SpecialAccessPolicy["status"] = "active",
  businessDateKey: string = getBusinessDayKey(new Date())
): EffectivePolicy[] => {
  const directPolicies =
    user.accessPolicies
      ?.filter((policy) => {
        if (policy.status !== status) {
          return false;
        }

        const effectiveFromDateKey = policy.effectiveFromDateKey ?? "0000-01-01";
        const effectiveToDateKey = policy.effectiveToDateKey ?? "9999-12-31";

        return effectiveFromDateKey <= businessDateKey && effectiveToDateKey >= businessDateKey;
      })
      .map((policy) => ({
        ...policy,
        applicableUserIds: [user.id]
      })) ?? [];

  if (directPolicies.length) {
    return directPolicies;
  }

  return getApplicablePoliciesForUser(templates, user.id, status);
};

export const getBusinessDayWindowsForPolicy = (
  policy: EffectivePolicy,
  businessDateKey: string
): PolicyWindow[] => {
  const windows: PolicyWindow[] = [];
  const startHour = getBusinessDayStartHour();

  if (policy.startHour >= startHour && policy.weekdays.includes(getWeekdayForDateKey(businessDateKey))) {
    windows.push({
      policyId: policy.id,
      policyName: policy.name,
      weekdays: policy.weekdays,
      dateKey: businessDateKey,
      startHour: policy.startHour,
      endHour: policy.endHour,
      goodsLimits: policy.goodsLimits
    });
  }

  const nextDateKey = addDaysToDateKey(businessDateKey, 1);

  if (policy.startHour < startHour && policy.weekdays.includes(getWeekdayForDateKey(nextDateKey))) {
    windows.push({
      policyId: policy.id,
      policyName: policy.name,
      weekdays: policy.weekdays,
      dateKey: nextDateKey,
      startHour: policy.startHour,
      endHour: policy.endHour,
      goodsLimits: policy.goodsLimits
    });
  }

  return windows;
};

export const getBusinessDayWindowsForUser = (
  user: UserRecord,
  policies: SpecialAccessPolicy[],
  businessDateKey: string = getBusinessDayKey(new Date())
) =>
  getEffectivePoliciesForUser(user, policies, "active", businessDateKey).flatMap((policy) =>
    getBusinessDayWindowsForPolicy(policy, businessDateKey)
  );

export const getActiveWindowsForUser = (
  user: UserRecord,
  policies: SpecialAccessPolicy[],
  value: string | Date = new Date()
) => {
  const currentDateKey = toDateKey(value);
  const { hour, weekday } = getLocalDateParts(value);

  return getEffectivePoliciesForUser(user, policies, "active", getBusinessDayKey(value)).flatMap((policy) => {
    if (!policy.weekdays.includes(weekday)) {
      return [];
    }

    if (hour < policy.startHour || hour >= policy.endHour) {
      return [];
    }

    return [
      {
        policyId: policy.id,
        policyName: policy.name,
        weekdays: policy.weekdays,
        dateKey: currentDateKey,
        startHour: policy.startHour,
        endHour: policy.endHour,
        goodsLimits: policy.goodsLimits
      }
    ];
  });
};

export const summarizeBusinessDayForUser = (
  user: UserRecord,
  policies: SpecialAccessPolicy[],
  inventory: InventoryMovement[],
  goodsCatalog: GoodsCatalogItem[],
  businessDateKey: string = getBusinessDayKey(new Date())
) => {
  const windows = getBusinessDayWindowsForUser(user, policies, businessDateKey);
  const relevantPickups = inventory.filter(
    (entry) => entry.userId === user.id && entry.type === "pickup" && getBusinessDayKey(entry.happenedAt) === businessDateKey
  );
  const catalogMap = buildCatalogMap(goodsCatalog);

  const windowSummaries: SpecialAccessWindowUsage[] = windows.map((window) => ({
    policyId: window.policyId,
    policyName: window.policyName,
    weekdays: window.weekdays,
    dateKey: window.dateKey,
    startHour: window.startHour,
    endHour: window.endHour,
    goodsUsage: window.goodsLimits.map((limit) => {
      const usedQuantity = relevantPickups
        .filter((entry) => {
          const parts = getLocalDateParts(entry.happenedAt);
          return (
            toDateKey(entry.happenedAt) === window.dateKey &&
            parts.hour >= window.startHour &&
            parts.hour < window.endHour &&
            entry.goodsId === limit.goodsId
          );
        })
        .reduce((sum, entry) => sum + entry.quantity, 0);

      return {
        goodsId: limit.goodsId,
        goodsName: limit.goodsName ?? catalogMap.get(limit.goodsId)?.name ?? limit.goodsId,
        category: limit.category ?? catalogMap.get(limit.goodsId)?.category ?? "daily",
        quantityLimit: limit.quantity,
        usedQuantity
      };
    })
  }));

  const allUsage = windowSummaries.flatMap((entry) => entry.goodsUsage);
  const totalGoods = allUsage.reduce((sum, entry) => sum + entry.quantityLimit, 0);
  const fulfilledGoods = allUsage.reduce(
    (sum, entry) => sum + Math.min(entry.quantityLimit, entry.usedQuantity),
    0
  );

  let completionStatus: ServiceCompletionStatus = "not_applicable";

  if (totalGoods > 0 && fulfilledGoods === 0) {
    completionStatus = "unserved";
  } else if (totalGoods > 0 && fulfilledGoods < totalGoods) {
    completionStatus = "partial";
  } else if (totalGoods > 0 && fulfilledGoods >= totalGoods) {
    completionStatus = "complete";
  }

  return {
    businessDateKey,
    completionStatus,
    totalGoods,
    fulfilledGoods,
    windows: windowSummaries
  };
};

export const getActiveWindowCategoryQuota = (
  user: UserRecord,
  policies: SpecialAccessPolicy[],
  inventory: InventoryMovement[],
  goodsCatalog: GoodsCatalogItem[],
  value: string | Date = new Date()
) => {
  const activeWindows = getActiveWindowsForUser(user, policies, value);
  const businessDateKey = getBusinessDayKey(value);
  const relevantPickups = inventory.filter(
    (entry) => entry.userId === user.id && entry.type === "pickup" && getBusinessDayKey(entry.happenedAt) === businessDateKey
  );
  const catalogMap = buildCatalogMap(goodsCatalog);
  const remainingByCategory: Record<string, number> = {};
  const remainingByGoods: Record<string, number> = {};

  for (const window of activeWindows) {
    for (const limit of window.goodsLimits) {
      const usedQuantity = relevantPickups
        .filter((entry) => {
          const parts = getLocalDateParts(entry.happenedAt);
          return (
            toDateKey(entry.happenedAt) === window.dateKey &&
            parts.hour >= window.startHour &&
            parts.hour < window.endHour &&
            entry.goodsId === limit.goodsId
          );
        })
        .reduce((sum, entry) => sum + entry.quantity, 0);

      const remaining = Math.max(0, limit.quantity - usedQuantity);
      const category = limit.category ?? catalogMap.get(limit.goodsId)?.category ?? "daily";
      remainingByGoods[limit.goodsId] = (remainingByGoods[limit.goodsId] ?? 0) + remaining;
      remainingByCategory[category] = (remainingByCategory[category] ?? 0) + remaining;
    }
  }

  return {
    activeWindows,
    remainingByCategory,
    remainingByGoods
  };
};

export const buildCalendarMonthDays = (monthKey: string) => {
  const [year, month] = monthKey.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = firstDay.getUTCDay();
  const gridStart = new Date(Date.UTC(year, month - 1, 1 - ((firstWeekday + 6) % 7)));

  return Array.from({ length: 35 }, (_, index) => {
    const current = new Date(gridStart);
    current.setUTCDate(gridStart.getUTCDate() + index);
    const dateKey = current.toISOString().slice(0, 10);

    return {
      dateKey,
      day: current.getUTCDate(),
      inCurrentMonth: current.getUTCMonth() + 1 === month
    };
  });
};

export const getPolicyGoodsCategory = (
  goodsId: string,
  policy: SpecialAccessPolicy,
  goodsCatalog: GoodsCatalogItem[]
): GoodsCategory =>
  policy.goodsLimits.find((entry) => entry.goodsId === goodsId)?.category ??
  goodsCatalog.find((entry) => entry.goodsId === goodsId)?.category ??
  "daily";
