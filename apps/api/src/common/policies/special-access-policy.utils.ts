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

export const getBusinessDayWindowsForPolicy = (
  policy: SpecialAccessPolicy,
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
  policies: SpecialAccessPolicy[],
  userId: string,
  businessDateKey: string = getBusinessDayKey(new Date())
) =>
  getApplicablePoliciesForUser(policies, userId).flatMap((policy) =>
    getBusinessDayWindowsForPolicy(policy, businessDateKey)
  );

export const getActiveWindowsForUser = (
  policies: SpecialAccessPolicy[],
  userId: string,
  value: string | Date = new Date()
) => {
  const currentDateKey = toDateKey(value);
  const { hour, weekday } = getLocalDateParts(value);

  return getApplicablePoliciesForUser(policies, userId).flatMap((policy) => {
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
  const windows = getBusinessDayWindowsForUser(policies, user.id, businessDateKey);
  const relevantPickups = inventory.filter(
    (entry) => entry.userId === user.id && entry.type === "pickup" && getBusinessDayKey(entry.happenedAt) === businessDateKey
  );
  const catalogMap = buildCatalogMap(goodsCatalog);

  const windowSummaries: SpecialAccessWindowUsage[] = windows.map((window) => ({
    policyId: window.policyId,
    policyName: window.policyName,
    weekdays: window.weekdays,
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
  policies: SpecialAccessPolicy[],
  userId: string,
  inventory: InventoryMovement[],
  goodsCatalog: GoodsCatalogItem[],
  value: string | Date = new Date()
) => {
  const activeWindows = getActiveWindowsForUser(policies, userId, value);
  const businessDateKey = getBusinessDayKey(value);
  const relevantPickups = inventory.filter(
    (entry) => entry.userId === userId && entry.type === "pickup" && getBusinessDayKey(entry.happenedAt) === businessDateKey
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

export const getPolicyGoodsCategory = (
  goodsId: string,
  policy: SpecialAccessPolicy,
  goodsCatalog: GoodsCatalogItem[]
): GoodsCategory =>
  policy.goodsLimits.find((entry) => entry.goodsId === goodsId)?.category ??
  goodsCatalog.find((entry) => entry.goodsId === goodsId)?.category ??
  "daily";
