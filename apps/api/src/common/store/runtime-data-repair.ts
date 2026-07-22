import type { PersistedStoreState } from "./persistence";
import { validatePersistedState } from "./persisted-state-integrity";

interface RepairCategorySummary {
  detected: number;
  eligible: number;
  blocked: number;
}

export interface RuntimeDataRepairAnalysis {
  malformedGoods: RepairCategorySummary;
  zeroQuantityInventory: RepairCategorySummary;
  orphanMerchantTemplates: RepairCategorySummary;
  manualRequiredCredentialDuplicateGroups: number;
  initialValidationErrorCount: number;
  remainingValidationErrorCount: number;
  canApply: boolean;
}

export interface RuntimeDataRepairResult {
  state: PersistedStoreState;
  analysis: RuntimeDataRepairAnalysis;
  changed: boolean;
}

interface RepairCandidates {
  malformedGoods: Record<string, unknown>[];
  eligibleMalformedGoods: Record<string, unknown>[];
  zeroQuantityInventory: Record<string, unknown>[];
  eligibleZeroQuantityInventory: Record<string, unknown>[];
  orphanMerchantTemplates: Record<string, unknown>[];
  eligibleOrphanMerchantTemplates: Record<string, unknown>[];
  manualRequiredCredentialDuplicateGroups: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim());

const asRecordArray = (state: Record<string, unknown>, key: string) =>
  Array.isArray(state[key]) ? state[key].filter(isRecord) : [];

const hasExternalExactReference = (
  root: unknown,
  identifiers: readonly string[],
  excluded: object
) => {
  const targets = new Set(identifiers.filter(nonEmptyString));
  const seen = new WeakSet<object>();

  const visit = (value: unknown): boolean => {
    if (value === excluded) {
      return false;
    }

    if (typeof value === "string") {
      return targets.has(value);
    }

    if (!value || typeof value !== "object") {
      return false;
    }

    if (seen.has(value)) {
      return false;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.some((entry) => visit(entry));
    }

    return Object.entries(value).some(
      ([key, entry]) => targets.has(key) || visit(entry)
    );
  };

  return targets.size > 0 && visit(root);
};

const hasBusinessAnchor = (entry: Record<string, unknown>) => {
  const anchorKeys = [
    "orderNo",
    "sourceOrderNo",
    "eventId",
    "batchId",
    "consumedBatches",
    "transactionId",
    "refundNo",
    "paymentOrderId",
    "paymentNo"
  ] as const;

  return anchorKeys.some((key) => {
    const value = entry[key];

    if (typeof value === "string") {
      return Boolean(value.trim());
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return value !== undefined && value !== null;
  });
};

const duplicateCredentialGroupCount = (state: Record<string, unknown>) =>
  ["adminCredentials", "backofficeCredentials"].reduce((total, key) => {
    const counts = new Map<string, number>();

    for (const credential of asRecordArray(state, key)) {
      const username = credential.username;

      if (!nonEmptyString(username)) {
        continue;
      }

      const normalized = username.trim().toLowerCase();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }

    return total + [...counts.values()].filter((count) => count > 1).length;
  }, 0);

const collectRepairCandidates = (state: unknown): RepairCandidates => {
  if (!isRecord(state)) {
    return {
      malformedGoods: [],
      eligibleMalformedGoods: [],
      zeroQuantityInventory: [],
      eligibleZeroQuantityInventory: [],
      orphanMerchantTemplates: [],
      eligibleOrphanMerchantTemplates: [],
      manualRequiredCredentialDuplicateGroups: 0
    };
  }

  const goodsCatalog = asRecordArray(state, "goodsCatalog");
  const catalogGoodsIds = new Set(
    goodsCatalog
      .map((goods) => goods.goodsId)
      .filter(nonEmptyString)
      .map((goodsId) => goodsId.trim())
  );
  const malformedGoods = goodsCatalog.filter((goods) =>
    ["goodsId", "goodsCode", "name", "category"].some(
      (field) => !nonEmptyString(goods[field])
    )
  );
  const eligibleMalformedGoods = malformedGoods.filter((goods) => {
    const goodsId = goods.goodsId;
    const goodsCode = goods.goodsCode;

    return (
      nonEmptyString(goodsId) &&
      nonEmptyString(goodsCode) &&
      !hasExternalExactReference(state, [goodsId, goodsCode], goods)
    );
  });

  const zeroQuantityInventory = asRecordArray(state, "inventory").filter(
    (movement) => movement.quantity === 0
  );
  const eligibleZeroQuantityInventory = zeroQuantityInventory.filter((movement) =>
    nonEmptyString(movement.id) &&
    !hasBusinessAnchor(movement) &&
    !hasExternalExactReference(state, [movement.id], movement)
  );

  const orphanMerchantTemplates = asRecordArray(state, "merchantGoodsTemplates").filter(
    (template) =>
      nonEmptyString(template.goodsId) &&
      !catalogGoodsIds.has(template.goodsId.trim())
  );
  const eligibleOrphanMerchantTemplates = orphanMerchantTemplates.filter(
    (template) =>
      nonEmptyString(template.id) &&
      !hasExternalExactReference(state, [template.id], template)
  );

  return {
    malformedGoods,
    eligibleMalformedGoods,
    zeroQuantityInventory,
    eligibleZeroQuantityInventory,
    orphanMerchantTemplates,
    eligibleOrphanMerchantTemplates,
    manualRequiredCredentialDuplicateGroups: duplicateCredentialGroupCount(state)
  };
};

const removeCandidates = (state: Record<string, unknown>, candidates: RepairCandidates) => {
  const removeFrom = (key: string, entries: readonly Record<string, unknown>[]) => {
    if (!Array.isArray(state[key]) || entries.length === 0) {
      return;
    }

    const removalSet = new Set(entries);
    state[key] = state[key].filter((entry) => !removalSet.has(entry as Record<string, unknown>));
  };

  removeFrom("goodsCatalog", candidates.eligibleMalformedGoods);
  removeFrom("inventory", candidates.eligibleZeroQuantityInventory);
  removeFrom("merchantGoodsTemplates", candidates.eligibleOrphanMerchantTemplates);
};

const summarizeCategory = (
  detected: readonly unknown[],
  eligible: readonly unknown[]
): RepairCategorySummary => ({
  detected: detected.length,
  eligible: eligible.length,
  blocked: detected.length - eligible.length
});

export const analyseRuntimeDataRepair = (state: unknown): RuntimeDataRepairAnalysis => {
  const candidates = collectRepairCandidates(state);
  const initialValidationErrorCount = validatePersistedState(state).errors.length;
  const candidateState = structuredClone(state);
  let remainingValidationErrorCount = initialValidationErrorCount;

  if (isRecord(candidateState)) {
    const candidateRepairCandidates = collectRepairCandidates(candidateState);
    removeCandidates(candidateState, candidateRepairCandidates);
    remainingValidationErrorCount = validatePersistedState(candidateState).errors.length;
  }

  const malformedGoods = summarizeCategory(
    candidates.malformedGoods,
    candidates.eligibleMalformedGoods
  );
  const zeroQuantityInventory = summarizeCategory(
    candidates.zeroQuantityInventory,
    candidates.eligibleZeroQuantityInventory
  );
  const orphanMerchantTemplates = summarizeCategory(
    candidates.orphanMerchantTemplates,
    candidates.eligibleOrphanMerchantTemplates
  );

  return {
    malformedGoods,
    zeroQuantityInventory,
    orphanMerchantTemplates,
    manualRequiredCredentialDuplicateGroups:
      candidates.manualRequiredCredentialDuplicateGroups,
    initialValidationErrorCount,
    remainingValidationErrorCount,
    canApply:
      malformedGoods.blocked === 0 &&
      zeroQuantityInventory.blocked === 0 &&
      orphanMerchantTemplates.blocked === 0 &&
      candidates.manualRequiredCredentialDuplicateGroups === 0 &&
      remainingValidationErrorCount === 0
  };
};

export const applyApprovedRuntimeDataRepair = (state: unknown): RuntimeDataRepairResult => {
  const analysis = analyseRuntimeDataRepair(state);

  if (!analysis.canApply || !isRecord(state)) {
    throw new Error("仍存在需人工处理或无法证明安全的运行数据问题，已拒绝写入。");
  }

  const repaired = structuredClone(state) as Record<string, unknown>;
  const candidates = collectRepairCandidates(repaired);
  removeCandidates(repaired, candidates);
  const validation = validatePersistedState(repaired);

  if (validation.errors.length > 0) {
    throw new Error("修复后的运行数据完整性检查未通过，已拒绝写入。");
  }

  const changed =
    candidates.eligibleMalformedGoods.length > 0 ||
    candidates.eligibleZeroQuantityInventory.length > 0 ||
    candidates.eligibleOrphanMerchantTemplates.length > 0;

  return {
    state: repaired as unknown as PersistedStoreState,
    analysis,
    changed
  };
};
