import type {
  EntitlementAllocationLine,
  EntitlementPoolSnapshot,
  GoodsCatalogItem,
  GoodsCategory,
  GoodsTaxonomyNode,
  InventoryMovement,
  ServiceCompletionStatus,
  SpecialAccessPolicy,
  SpecialAccessWindowUsage,
  UserRecord
} from "@vm/shared-types";

import {
  allocateEntitlements,
  type EntitlementAllocationGoods,
  type EntitlementAllocationNode
} from "./entitlement-allocation";

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
  entitlementLimits: NonNullable<SpecialAccessPolicy["entitlementLimits"]>;
}

type EffectivePolicy = Omit<SpecialAccessPolicy, "applicableUserIds"> & {
  applicableUserIds?: string[];
  effectiveFromDateKey?: string;
  effectiveToDateKey?: string;
};

const buildCatalogMap = (catalog: GoodsCatalogItem[]) =>
  new Map(catalog.map((item) => [item.goodsId, item]));

const quotaMovementKey = (entry: InventoryMovement) =>
  entry.orderNo && entry.goodsId ? `${entry.orderNo}::${entry.goodsId}` : undefined;

const normalizeQuantity = (value: number, maximum: number) => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return 0;
  }

  return Math.min(Math.max(0, value), Math.max(0, maximum));
};

const resolveMovementQuantity = (entry: InventoryMovement) =>
  normalizeQuantity(entry.quantity, entry.quantity);

const resolveQuotaQuantity = (entry: InventoryMovement) =>
  entry.quotaQuantity === undefined
    ? resolveMovementQuantity(entry)
    : normalizeQuantity(entry.quotaQuantity, entry.quantity);

const sumNetConsumptionQuantity = (
  inventory: InventoryMovement[],
  pickupFilter: (entry: InventoryMovement) => boolean,
  resolveQuantity: (entry: InventoryMovement) => number
) => {
  const selectedConsumptions = inventory.filter(
    (entry) => (entry.type === "pickup" || entry.type === "adjustment") && pickupFilter(entry)
  );
  const selectedKeys = new Set(
    selectedConsumptions
      .map(quotaMovementKey)
      .filter((key): key is string => Boolean(key))
  );
  const refundQuantityByKey = new Map<string, number>();

  for (const refund of inventory) {
    if (refund.type !== "refund") {
      continue;
    }

    const key = quotaMovementKey(refund);

    if (!key || !selectedKeys.has(key)) {
      continue;
    }

    refundQuantityByKey.set(
      key,
      (refundQuantityByKey.get(key) ?? 0) + resolveQuantity(refund)
    );
  }

  return selectedConsumptions.reduce((sum, pickup) => {
    const key = quotaMovementKey(pickup);
    const refundedQuantity = key ? refundQuantityByKey.get(key) ?? 0 : 0;
    const pickupQuantity = resolveQuantity(pickup);
    const consumedRefundQuantity = Math.min(pickupQuantity, refundedQuantity);

    if (key && consumedRefundQuantity > 0) {
      refundQuantityByKey.set(key, Math.max(0, refundedQuantity - consumedRefundQuantity));
    }

    return sum + Math.max(0, pickupQuantity - consumedRefundQuantity);
  }, 0);
};

export const sumNetPickupQuantity = (
  inventory: InventoryMovement[],
  pickupFilter: (entry: InventoryMovement) => boolean
) => sumNetConsumptionQuantity(inventory, pickupFilter, resolveMovementQuantity);

export const sumNetQuotaQuantity = (
  inventory: InventoryMovement[],
  pickupFilter: (entry: InventoryMovement) => boolean
) => sumNetConsumptionQuantity(inventory, pickupFilter, resolveQuotaQuantity);

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
      goodsLimits: policy.goodsLimits,
      entitlementLimits: policy.entitlementLimits ?? []
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
      goodsLimits: policy.goodsLimits,
      entitlementLimits: policy.entitlementLimits ?? []
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
        goodsLimits: policy.goodsLimits,
        entitlementLimits: policy.entitlementLimits ?? []
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
  const catalogMap = buildCatalogMap(goodsCatalog);

  const windowSummaries: SpecialAccessWindowUsage[] = windows.map((window) => ({
    policyId: window.policyId,
    policyName: window.policyName,
    weekdays: window.weekdays,
    dateKey: window.dateKey,
    startHour: window.startHour,
    endHour: window.endHour,
    goodsUsage: window.goodsLimits.map((limit) => {
      const usedQuantity = sumNetPickupQuantity(
        inventory,
        (entry) => {
          const parts = getLocalDateParts(entry.happenedAt);
          return (
            entry.userId === user.id &&
            getBusinessDayKey(entry.happenedAt) === businessDateKey &&
            toDateKey(entry.happenedAt) === window.dateKey &&
            parts.hour >= window.startHour &&
            parts.hour < window.endHour &&
            entry.goodsId === limit.goodsId
          );
        }
      );

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
  const catalogMap = buildCatalogMap(goodsCatalog);
  const remainingByCategory: Record<string, number> = {};
  const remainingByGoods: Record<string, number> = {};

  for (const window of activeWindows) {
    for (const limit of window.goodsLimits) {
      const usedQuantity = sumNetQuotaQuantity(
        inventory,
        (entry) => {
          const parts = getLocalDateParts(entry.happenedAt);
          return (
            entry.userId === user.id &&
            getBusinessDayKey(entry.happenedAt) === businessDateKey &&
            toDateKey(entry.happenedAt) === window.dateKey &&
            parts.hour >= window.startHour &&
            parts.hour < window.endHour &&
            entry.goodsId === limit.goodsId
          );
        }
      );

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

const isMovementInsideWindow = (
  movement: InventoryMovement,
  window: PolicyWindow,
  businessDateKey: string
) => {
  const parts = getLocalDateParts(movement.happenedAt);
  return (
    getBusinessDayKey(movement.happenedAt) === businessDateKey &&
    toDateKey(movement.happenedAt) === window.dateKey &&
    parts.hour >= window.startHour &&
    parts.hour < window.endHour
  );
};

const buildEntitlementPoolId = (window: PolicyWindow, limitId: string) =>
  `${window.policyId}:${window.dateKey}:${limitId}`;

/**
 * 将树状领取规则、当天流水和退款收敛成一个额度快照。旧流水没有记录额度池时，
 * 会按实际货品重新分配；新流水则按保存的精确池恢复，避免分类移动改写历史。
 */
export const getActiveWindowEntitlementQuota = (
  user: UserRecord,
  policies: SpecialAccessPolicy[],
  inventory: InventoryMovement[],
  goodsCatalog: GoodsCatalogItem[],
  taxonomyNodes: GoodsTaxonomyNode[],
  value: string | Date = new Date()
) => {
  const activeWindows = getActiveWindowsForUser(user, policies, value);
  const businessDateKey = getBusinessDayKey(value);
  const poolMaximum = new Map<string, number>();
  const poolById = new Map<string, EntitlementPoolSnapshot>();

  for (const window of activeWindows) {
    for (const limit of window.entitlementLimits) {
      const poolId = buildEntitlementPoolId(window, limit.id);
      const pool: EntitlementPoolSnapshot = {
        ...limit,
        poolId,
        limitId: limit.id,
        policyId: window.policyId,
        policyName: window.policyName,
        remaining: limit.quantity
      };
      poolMaximum.set(poolId, limit.quantity);
      poolById.set(poolId, pool);
    }
  }

  const relevantMovements = inventory.filter(
    (movement) =>
      movement.userId === user.id &&
      activeWindows.some((window) => isMovementInsideWindow(movement, window, businessDateKey))
  );
  const legacyMovements: InventoryMovement[] = [];

  for (const movement of relevantMovements) {
    const lines = movement.entitlementAllocations ?? [];
    if (!lines.length) {
      legacyMovements.push(movement);
      continue;
    }

    const direction = movement.type === "refund" ? 1 : movement.type === "pickup" || movement.type === "adjustment" ? -1 : 0;
    if (direction === 0) continue;
    for (const line of lines) {
      const pool = poolById.get(line.poolId);
      if (!pool) continue;
      const maximum = poolMaximum.get(line.poolId) ?? pool.remaining;
      pool.remaining = Math.min(maximum, Math.max(0, pool.remaining + direction * line.quantity));
    }
  }

  const legacyRequests = goodsCatalog.flatMap((goods) => {
    const quantity = sumNetQuotaQuantity(
      legacyMovements,
      (movement) => movement.goodsId === goods.goodsId
    );
    return quantity > 0 ? [{ goodsId: goods.goodsId, quantity }] : [];
  });
  if (legacyRequests.length && poolById.size) {
    const legacyAllocation = allocateEntitlements({
      nodes: taxonomyNodes,
      goods: goodsCatalog,
      pools: [...poolById.values()],
      requests: legacyRequests
    });
    for (const line of legacyAllocation.allocations) {
      const pool = poolById.get(line.poolId)!;
      pool.remaining = Math.max(0, pool.remaining - line.quantity);
    }
  }

  const remainingPools = [...poolById.values()].sort((left, right) =>
    left.poolId.localeCompare(right.poolId)
  );
  const receivableByGoods: Record<string, number> = {};
  for (const goods of goodsCatalog.filter((entry) => entry.status !== "inactive")) {
    const result = allocateEntitlements({
      nodes: taxonomyNodes,
      goods: goodsCatalog,
      pools: remainingPools,
      requests: [{ goodsId: goods.goodsId, quantity: Number.MAX_SAFE_INTEGER }]
    });
    receivableByGoods[goods.goodsId] = result.allocations.reduce(
      (sum, line) => sum + line.quantity,
      0
    );
  }

  return {
    activeWindows,
    remainingPools,
    receivableByGoods,
    remainingTotal: remainingPools.reduce((sum, pool) => sum + pool.remaining, 0)
  };
};

export const allocateActiveEntitlements = (
  quota: ReturnType<typeof getActiveWindowEntitlementQuota>,
  taxonomyNodes: GoodsTaxonomyNode[],
  goodsCatalog: GoodsCatalogItem[],
  requests: Array<{ goodsId: string; quantity: number }>
): { fulfilled: boolean; allocations: EntitlementAllocationLine[]; shortages: Array<{ goodsId: string; quantity: number }> } =>
  allocateEntitlements({
    nodes: taxonomyNodes,
    goods: goodsCatalog,
    pools: quota.remainingPools,
    requests
  });

export const allocateActiveEntitlementsPreservingLocks = (
  quota: ReturnType<typeof getActiveWindowEntitlementQuota>,
  taxonomyNodes: EntitlementAllocationNode[],
  goodsCatalog: EntitlementAllocationGoods[],
  requests: Array<{ goodsId: string; quantity: number }>,
  lockedAllocations: readonly EntitlementAllocationLine[]
) => {
  const requestedByGoods = new Map<string, number>();
  for (const request of requests) {
    requestedByGoods.set(
      request.goodsId,
      (requestedByGoods.get(request.goodsId) ?? 0) + request.quantity
    );
  }

  const preserved: EntitlementAllocationLine[] = [];
  const preservedByGoods = new Map<string, number>();
  for (const line of lockedAllocations) {
    const requested = requestedByGoods.get(line.goodsId) ?? 0;
    const alreadyPreserved = preservedByGoods.get(line.goodsId) ?? 0;
    const quantity = Math.min(line.quantity, Math.max(0, requested - alreadyPreserved));
    if (quantity <= 0) continue;
    preserved.push({ ...line, quantity });
    preservedByGoods.set(line.goodsId, alreadyPreserved + quantity);
  }

  const remainingPools = quota.remainingPools.map((pool) => ({ ...pool }));
  const poolById = new Map(remainingPools.map((pool) => [pool.poolId, pool]));
  for (const line of preserved) {
    const pool = poolById.get(line.poolId);
    if (pool) pool.remaining = Math.max(0, pool.remaining - line.quantity);
  }
  const remainingQuota = {
    ...quota,
    remainingPools,
    remainingTotal: remainingPools.reduce((sum, pool) => sum + pool.remaining, 0)
  };
  const remainingRequests = [...requestedByGoods].flatMap(([goodsId, quantity]) => {
    const remaining = quantity - (preservedByGoods.get(goodsId) ?? 0);
    return remaining > 0 ? [{ goodsId, quantity: remaining }] : [];
  });
  const additional = allocateEntitlements({
    nodes: taxonomyNodes,
    goods: goodsCatalog,
    pools: remainingQuota.remainingPools,
    requests: remainingRequests
  });

  return {
    fulfilled: additional.fulfilled,
    allocations: [...preserved, ...additional.allocations],
    shortages: additional.shortages
  };
};

export const subtractLockedEntitlements = (
  quota: ReturnType<typeof getActiveWindowEntitlementQuota>,
  allocations: readonly EntitlementAllocationLine[]
) => {
  const remainingPools = quota.remainingPools.map((pool) => ({ ...pool }));
  const poolById = new Map(remainingPools.map((pool) => [pool.poolId, pool]));
  for (const line of allocations) {
    const pool = poolById.get(line.poolId);
    if (!pool || pool.remaining < line.quantity) {
      throw new Error("已有预约锁定的领取额度已失效。");
    }
    pool.remaining -= line.quantity;
  }
  return {
    ...quota,
    remainingPools,
    remainingTotal: remainingPools.reduce((sum, pool) => sum + pool.remaining, 0)
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
