import { existsSync, readFileSync } from "node:fs";

const REQUIRED_ARRAY_KEYS = [
  "users",
  "rules",
  "devices",
  "goodsCatalog",
  "goodsCategories",
  "regions",
  "warehouses",
  "specialAccessPolicies",
  "goodsAlertPolicies",
  "registrationApplications",
  "merchantGoodsTemplates",
  "deviceGoodsSettings",
  "goodsBatches",
  "batchConsumptionTraces",
  "inventoryTransfers",
  "stocktakes",
  "expiredBatchDispositions",
  "events",
  "inventory",
  "paymentOrders",
  "paymentRefunds",
  "reservations",
  "alerts",
  "logs",
  "platformTenants",
  "manualVerificationGrants",
  "adminCredentials",
  "backofficeCredentials",
  "callbackLog"
] as const;

const REQUIRED_PAIR_ARRAY_KEYS = ["verificationCodes", "sessions", "draftSessions", "deviceRuntime"] as const;
const PAYMENT_PROVIDERS = new Set(["wechat", "alipay"]);
const PAYMENT_ORDER_PHASES = new Set(["pre_open", "post_settlement"]);
const PAYMENT_ORDER_STATUSES = new Set([
  "created",
  "pending",
  "paid",
  "failed",
  "closed",
  "refunded"
]);
const PAYMENT_REFUND_STATUSES = new Set(["pending", "success", "failed"]);
const PAYMENT_REFUND_PROVIDER_OUTCOMES = new Set(["unknown", "pending", "success", "failed"]);
const PAYMENT_REFUND_BUSINESS_APPLY_STATES = new Set(["pending", "completed"]);
const PLATFORM_TENANT_STATUSES = new Set(["active", "trial", "paused"]);
const DATA_PLANE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SIMULATION_INITIALIZATION_SOURCES = new Set([
  "simulation-seed",
  "simulation-empty",
  "legacy-simulation"
]);
const LIVE_INITIALIZATION_SOURCES = new Set([
  "live-bootstrap-pending",
  "live-bootstrap"
]);
const DEFAULT_BACKOFFICE_CREDENTIAL_ROLE_LABELS = [
  ["super_admin", "服务提供商超级管理员"],
  ["admin", "实例管理员"],
  ["merchant", "商户"],
  ["restocker", "补货员"]
] as const;

export interface PersistedStateValidationResult {
  summary: Record<string, number>;
  warnings: string[];
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const countArray = (state: Record<string, unknown>, key: string) => {
  const value = state[key];
  return Array.isArray(value) ? value.length : 0;
};

const summarizeDefaultCredentialWarnings = (state: Record<string, unknown>) => {
  const legacyCredentials = Array.isArray(state.adminCredentials) ? state.adminCredentials : [];
  const backofficeCredentials = Array.isArray(state.backofficeCredentials)
    ? state.backofficeCredentials
    : [];
  const legacyCount = legacyCredentials.filter(
    (entry) => isRecord(entry) && entry.usesDefaultPassword === true
  ).length;
  const roleCounts = new Map<string, number>();

  for (const credential of backofficeCredentials) {
    if (!isRecord(credential) || credential.usesDefaultPassword !== true) {
      continue;
    }

    const role = typeof credential.role === "string" ? credential.role : "other";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }

  const details: string[] = [];

  if (legacyCount > 0) {
    details.push(`旧管理员兼容凭据 ${legacyCount} 条`);
  }

  for (const [role, label] of DEFAULT_BACKOFFICE_CREDENTIAL_ROLE_LABELS) {
    const count = roleCounts.get(role) ?? 0;

    if (count > 0) {
      details.push(`${label} ${count} 条`);
      roleCounts.delete(role);
    }
  }

  const otherBackofficeCount = Array.from(roleCounts.values()).reduce(
    (total, count) => total + count,
    0
  );

  if (otherBackofficeCount > 0) {
    details.push(`其他后台角色 ${otherBackofficeCount} 条`);
  }

  return {
    count: legacyCount + backofficeCredentials.filter(
      (entry) => isRecord(entry) && entry.usesDefaultPassword === true
    ).length,
    details
  };
};

const validateUniqueField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  result: PersistedStateValidationResult,
  normalize: (value: string) => string = (value) => value
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  const seen = new Set<string>();

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      result.errors.push(`${key}[${index}] 必须是对象。`);
      continue;
    }

    const identifier = item[field];

    if (typeof identifier !== "string" || !identifier.trim()) {
      result.errors.push(`${key}[${index}].${field} 缺失或不是字符串。`);
      continue;
    }

    const normalized = normalize(identifier.trim());

    if (seen.has(normalized)) {
      result.errors.push(`${key} 存在重复 ${field}。`);
    }

    seen.add(normalized);
  }
};

const validateRequiredStringFields = (
  state: Record<string, unknown>,
  key: string,
  fields: string[],
  result: PersistedStateValidationResult
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      result.errors.push(`${key}[${index}] 必须是对象。`);
      continue;
    }

    for (const field of fields) {
      if (typeof item[field] !== "string" || !item[field].trim()) {
        result.errors.push(`${key}[${index}].${field} 缺失或为空字符串。`);
      }
    }
  }
};

const validatePairArray = (
  state: Record<string, unknown>,
  key: string,
  result: PersistedStateValidationResult
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    result.errors.push(`${key} 必须是数组。`);
    return;
  }

  const seenKeys = new Set<string>();

  for (const [index, item] of value.entries()) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !isRecord(item[1])) {
      result.errors.push(`${key}[${index}] 必须是 [string, object] 形式。`);
      continue;
    }

    if (!item[0].trim()) {
      result.errors.push(`${key}[${index}] 的键不能为空。`);
    } else if (seenKeys.has(item[0])) {
      result.errors.push(`${key} 存在重复键。`);
    }

    seenKeys.add(item[0]);
  }
};

const validateNumericField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  result: PersistedStateValidationResult,
  options: {
    integer?: boolean;
    safeInteger?: boolean;
    min?: number;
    max?: number;
  } = {}
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }

    const numericValue = item[field];

    if (
      typeof numericValue !== "number" ||
      !Number.isFinite(numericValue) ||
      (options.safeInteger && !Number.isSafeInteger(numericValue)) ||
      (options.integer && !Number.isInteger(numericValue)) ||
      (options.min !== undefined && numericValue < options.min) ||
      (options.max !== undefined && numericValue > options.max)
    ) {
      const range = [
        options.safeInteger ? "安全整数" : options.integer ? "整数" : "有限数字",
        options.min !== undefined ? `不小于 ${options.min}` : undefined,
        options.max !== undefined ? `不大于 ${options.max}` : undefined
      ]
        .filter(Boolean)
        .join("且");
      result.errors.push(`${key}[${index}].${field} 必须是${range}。`);
    }
  }
};

const validateBooleanField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  result: PersistedStateValidationResult
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }

    if (typeof item[field] !== "boolean") {
      result.errors.push(`${key}[${index}].${field} 必须是布尔值。`);
    }
  }
};

const validateAllowedStringField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  allowedValues: ReadonlySet<string>,
  label: string,
  result: PersistedStateValidationResult,
  optional = false
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }

    const fieldValue = item[field];

    if (optional && fieldValue === undefined) {
      continue;
    }

    if (typeof fieldValue !== "string" || !allowedValues.has(fieldValue)) {
      result.errors.push(`${key}[${index}].${field} 不是允许的${label}。`);
    }
  }
};

const validateReferenceField = (
  state: Record<string, unknown>,
  key: string,
  field: string,
  targetIds: ReadonlySet<string>,
  targetLabel: string,
  result: PersistedStateValidationResult,
  optional = false
) => {
  const value = state[key];

  if (!Array.isArray(value)) {
    return;
  }

  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }

    const reference = item[field];

    if (optional && (reference === undefined || reference === null || reference === "")) {
      continue;
    }

    if (typeof reference !== "string" || !reference.trim() || !targetIds.has(reference)) {
      result.errors.push(`${key}[${index}].${field} 引用了不存在的${targetLabel}。`);
    }
  }
};

const recordIdentifierSet = (state: Record<string, unknown>, key: string, field: string) => {
  const value = state[key];

  return new Set(
    Array.isArray(value)
      ? value
          .filter(isRecord)
          .map((entry) => entry[field])
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      : []
  );
};

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim());

const validatePaymentRefundCompletionMarkers = (
  state: Record<string, unknown>,
  result: PersistedStateValidationResult
) => {
  const paymentRefunds = state.paymentRefunds;

  if (!Array.isArray(paymentRefunds)) {
    return;
  }

  for (const [index, refund] of paymentRefunds.entries()) {
    if (!isRecord(refund)) {
      continue;
    }

    const status = refund.status;
    const providerOutcome = refund.providerOutcome;
    const businessApplyState = refund.businessApplyState;
    const refundedAt = refund.refundedAt;

    // 渠道成功但本地业务尚未完成时，合法快照为 pending + providerOutcome=success；
    // 其他状态组合会让已退款金额被错误释放，必须在生产加载时停止。
    if (
      providerOutcome === "success" &&
      status !== "success" &&
      status !== "pending"
    ) {
      result.errors.push(
        `paymentRefunds[${index}].providerOutcome 为成功时退款状态必须为成功或待确认。`
      );
    }

    // 失败状态只在渠道已明确失败且业务副作用未完成时才可释放可退余额。
    // pending / unknown（或旧快照缺失结果）都不能证明渠道没有退款，必须停止生产加载。
    if (status === "failed" && providerOutcome !== "failed") {
      result.errors.push(
        `paymentRefunds[${index}].status 为失败时退款渠道结果必须为失败。`
      );
    }

    if (status === "failed" && businessApplyState === "completed") {
      result.errors.push(
        `paymentRefunds[${index}].status 为失败时退款业务应用状态不能为已完成。`
      );
    }

    if (refundedAt === undefined) {
      continue;
    }

    if (!isNonEmptyString(refundedAt)) {
      result.errors.push(`paymentRefunds[${index}].refundedAt 必须是非空字符串。`);
    }

    if (status !== "success") {
      result.errors.push(`paymentRefunds[${index}].refundedAt 存在时退款状态必须为成功。`);
    }

    if (providerOutcome !== undefined && providerOutcome !== "success") {
      result.errors.push(
        `paymentRefunds[${index}].refundedAt 存在时退款渠道结果必须为成功。`
      );
    }
  }
};

const validatePaymentRefundBindings = (
  state: Record<string, unknown>,
  result: PersistedStateValidationResult
) => {
  const paymentOrders = state.paymentOrders;
  const paymentRefunds = state.paymentRefunds;

  if (!Array.isArray(paymentOrders) || !Array.isArray(paymentRefunds)) {
    return;
  }

  const ordersById = new Map<string, Record<string, unknown>>();

  for (const paymentOrder of paymentOrders) {
    if (!isRecord(paymentOrder) || !isNonEmptyString(paymentOrder.id)) {
      continue;
    }
    ordersById.set(paymentOrder.id, paymentOrder);
  }

  const activeRefundTotals = new Map<string, number>();
  const cumulativeOverflowOrderIds = new Set<string>();

  for (const [index, refund] of paymentRefunds.entries()) {
    if (!isRecord(refund) || !isNonEmptyString(refund.paymentOrderId)) {
      continue;
    }

    const paymentOrder = ordersById.get(refund.paymentOrderId);

    // 孤儿引用由通用引用校验单独报告，避免在错误中重复或暴露绑定信息。
    if (!paymentOrder) {
      continue;
    }

    if (
      isNonEmptyString(refund.paymentNo) &&
      isNonEmptyString(paymentOrder.paymentNo) &&
      refund.paymentNo !== paymentOrder.paymentNo
    ) {
      result.errors.push(`paymentRefunds[${index}].paymentNo 与引用支付单不一致。`);
    }

    if (
      isNonEmptyString(refund.provider) &&
      isNonEmptyString(paymentOrder.provider) &&
      refund.provider !== paymentOrder.provider
    ) {
      result.errors.push(`paymentRefunds[${index}].provider 与引用支付单不一致。`);
    }

    const refundAmount = refund.amount;
    const paymentOrderAmount = paymentOrder.amount;

    if (
      !isNonNegativeSafeInteger(refundAmount) ||
      refundAmount <= 0 ||
      !isNonNegativeSafeInteger(paymentOrderAmount)
    ) {
      continue;
    }

    if (refundAmount > paymentOrderAmount) {
      result.errors.push(`paymentRefunds[${index}].amount 超过引用支付单金额。`);
      continue;
    }

    if (refund.status !== "success" && refund.status !== "pending") {
      continue;
    }

    const accumulatedAmount = activeRefundTotals.get(refund.paymentOrderId) ?? 0;

    if (accumulatedAmount > paymentOrderAmount - refundAmount) {
      if (!cumulativeOverflowOrderIds.has(refund.paymentOrderId)) {
        result.errors.push(
          "paymentRefunds 对同一支付单的成功或待确认退款累计金额超过支付单金额。"
        );
        cumulativeOverflowOrderIds.add(refund.paymentOrderId);
      }
      continue;
    }

    activeRefundTotals.set(refund.paymentOrderId, accumulatedAmount + refundAmount);
  }
};

export const validatePersistedState = (parsed: unknown): PersistedStateValidationResult => {
  const result: PersistedStateValidationResult = {
    summary: {},
    warnings: [],
    errors: []
  };

  if (!isRecord(parsed)) {
    result.errors.push("业务数据根节点必须是对象。");
    return result;
  }

  if (parsed.dataPlane !== "simulation" && parsed.dataPlane !== "live") {
    result.errors.push("dataPlane 必须是 simulation 或 live。");
  }

  if (
    typeof parsed.instanceId !== "string" ||
    !DATA_PLANE_INSTANCE_ID_PATTERN.test(parsed.instanceId)
  ) {
    result.errors.push("instanceId 格式无效。");
  }

  if (parsed.dataPlane === "simulation") {
    if (
      typeof parsed.initializationSource !== "string" ||
      !SIMULATION_INITIALIZATION_SOURCES.has(parsed.initializationSource)
    ) {
      result.errors.push("simulation 数据平面的 initializationSource 无效。");
    }
  }

  if (parsed.dataPlane === "live") {
    if (
      typeof parsed.initializationSource !== "string" ||
      !LIVE_INITIALIZATION_SOURCES.has(parsed.initializationSource)
    ) {
      result.errors.push("live 数据平面的 initializationSource 无效。");
    }
  }

  const isLegacySimulationManualVerificationGrants =
    parsed.dataPlane === "simulation" && parsed.manualVerificationGrants === undefined;

  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!Array.isArray(parsed[key])) {
      if (key === "manualVerificationGrants" && isLegacySimulationManualVerificationGrants) {
        result.warnings.push(
          "历史 simulation 快照缺少 manualVerificationGrants，将在受控启动时补齐。"
        );
        continue;
      }

      result.errors.push(`${key} 必须是数组。`);
    }
  }

  for (const key of REQUIRED_PAIR_ARRAY_KEYS) {
    validatePairArray(parsed, key, result);
  }

  if (!isRecord(parsed.reservationSettings)) {
    result.errors.push("reservationSettings 必须是对象。");
  } else {
    const { enabled, holdMinutes, maxTimeouts } = parsed.reservationSettings;

    if (typeof enabled !== "boolean") {
      result.errors.push("reservationSettings.enabled 必须是布尔值。");
    }

    if (
      typeof holdMinutes !== "number" ||
      !Number.isInteger(holdMinutes) ||
      holdMinutes < 5 ||
      holdMinutes > 24 * 60
    ) {
      result.errors.push("reservationSettings.holdMinutes 必须是 5 至 1440 的整数。");
    }

    if (
      typeof maxTimeouts !== "number" ||
      !Number.isInteger(maxTimeouts) ||
      maxTimeouts < 1 ||
      maxTimeouts > 20
    ) {
      result.errors.push("reservationSettings.maxTimeouts 必须是 1 至 20 的整数。");
    }
  }

  validateUniqueField(parsed, "users", "id", result);
  validateUniqueField(parsed, "users", "phone", result);
  validateUniqueField(parsed, "devices", "deviceCode", result);
  validateUniqueField(parsed, "goodsCatalog", "goodsId", result);
  validateUniqueField(parsed, "goodsCategories", "id", result);
  validateUniqueField(parsed, "warehouses", "code", result);
  validateUniqueField(parsed, "goodsBatches", "batchId", result);
  validateUniqueField(parsed, "registrationApplications", "id", result);
  validateUniqueField(parsed, "merchantGoodsTemplates", "id", result);
  validateUniqueField(parsed, "batchConsumptionTraces", "id", result);
  validateUniqueField(parsed, "inventoryTransfers", "id", result);
  validateUniqueField(parsed, "stocktakes", "id", result);
  validateUniqueField(parsed, "events", "eventId", result);
  validateUniqueField(parsed, "events", "orderNo", result);
  validateUniqueField(parsed, "inventory", "id", result);
  validateUniqueField(parsed, "paymentOrders", "id", result);
  validateUniqueField(parsed, "paymentOrders", "paymentNo", result);
  validateUniqueField(parsed, "paymentRefunds", "id", result);
  validateUniqueField(parsed, "paymentRefunds", "refundNo", result);
  validateUniqueField(parsed, "reservations", "id", result);
  validateUniqueField(parsed, "alerts", "id", result);
  validateUniqueField(parsed, "logs", "id", result);
  validateUniqueField(parsed, "platformTenants", "id", result);
  validateUniqueField(
    parsed,
    "manualVerificationGrants",
    "manualGrantId",
    result
  );
  validateUniqueField(parsed, "callbackLog", "id", result);
  validateUniqueField(parsed, "adminCredentials", "username", result, (value) => value.toLowerCase());
  validateUniqueField(parsed, "backofficeCredentials", "username", result, (value) => value.toLowerCase());
  validateRequiredStringFields(parsed, "users", ["id", "phone", "name", "role", "status"], result);
  validateRequiredStringFields(
    parsed,
    "manualVerificationGrants",
    [
      "manualGrantId",
      "challengeKey",
      "purpose",
      "issuerUserId",
      "targetUserId",
      "tenantId",
      "phoneHash",
      "expiresAt",
      "requestedAt"
    ],
    result
  );
  validateRequiredStringFields(parsed, "devices", ["deviceCode", "name", "status"], result);
  validateRequiredStringFields(parsed, "goodsCatalog", ["goodsId", "goodsCode", "name", "category"], result);
  validateRequiredStringFields(parsed, "goodsBatches", ["batchId", "goodsId", "deviceCode", "sourceType"], result);
  validateRequiredStringFields(parsed, "events", ["eventId", "orderNo", "userId", "deviceCode", "status"], result);
  validateRequiredStringFields(parsed, "inventory", ["id", "userId", "deviceCode", "goodsId", "type"], result);
  validateRequiredStringFields(parsed, "paymentOrders", ["id", "paymentNo", "provider", "phase", "status"], result);
  validateRequiredStringFields(parsed, "paymentRefunds", ["id", "paymentOrderId", "paymentNo", "refundNo", "provider", "status"], result);
  validateRequiredStringFields(parsed, "reservations", ["id", "userId", "deviceCode", "status"], result);
  validateRequiredStringFields(
    parsed,
    "platformTenants",
    ["id", "code", "name", "status", "createdAt"],
    result
  );
  validateRequiredStringFields(
    parsed,
    "adminCredentials",
    ["userId", "username", "passwordSalt", "passwordHash", "passwordUpdatedAt"],
    result
  );
  validateRequiredStringFields(
    parsed,
    "backofficeCredentials",
    ["userId", "username", "role", "passwordSalt", "passwordHash", "passwordUpdatedAt"],
    result
  );
  validateNumericField(parsed, "goodsBatches", "quantity", result, { integer: true, min: 0 });
  validateNumericField(parsed, "goodsBatches", "remainingQuantity", result, { integer: true });
  validateNumericField(parsed, "inventory", "quantity", result, { integer: true, min: 1 });
  validateNumericField(parsed, "inventory", "unitPrice", result, { min: 0 });
  validateNumericField(parsed, "events", "amount", result, { min: 0 });
  validateNumericField(parsed, "paymentOrders", "amount", result, { safeInteger: true, min: 0 });
  validateNumericField(parsed, "paymentRefunds", "amount", result, { safeInteger: true, min: 1 });
  validateAllowedStringField(
    parsed,
    "paymentOrders",
    "provider",
    PAYMENT_PROVIDERS,
    "支付渠道",
    result
  );
  validateAllowedStringField(
    parsed,
    "platformTenants",
    "status",
    PLATFORM_TENANT_STATUSES,
    "平台租户状态",
    result
  );
  validateAllowedStringField(
    parsed,
    "paymentOrders",
    "phase",
    PAYMENT_ORDER_PHASES,
    "支付阶段",
    result
  );
  validateAllowedStringField(
    parsed,
    "paymentOrders",
    "status",
    PAYMENT_ORDER_STATUSES,
    "支付状态",
    result
  );
  validateAllowedStringField(
    parsed,
    "paymentRefunds",
    "provider",
    PAYMENT_PROVIDERS,
    "支付渠道",
    result
  );
  validateAllowedStringField(
    parsed,
    "paymentRefunds",
    "status",
    PAYMENT_REFUND_STATUSES,
    "退款状态",
    result
  );
  validateAllowedStringField(
    parsed,
    "paymentRefunds",
    "providerOutcome",
    PAYMENT_REFUND_PROVIDER_OUTCOMES,
    "退款渠道结果",
    result,
    true
  );
  validateAllowedStringField(
    parsed,
    "paymentRefunds",
    "businessApplyState",
    PAYMENT_REFUND_BUSINESS_APPLY_STATES,
    "退款业务应用状态",
    result,
    true
  );
  validateBooleanField(parsed, "adminCredentials", "usesDefaultPassword", result);
  validateBooleanField(parsed, "backofficeCredentials", "usesDefaultPassword", result);

  const catalogGoodsIds = recordIdentifierSet(parsed, "goodsCatalog", "goodsId");
  const userIds = recordIdentifierSet(parsed, "users", "id");
  const platformTenantIds = recordIdentifierSet(parsed, "platformTenants", "id");
  const paymentOrderIds = recordIdentifierSet(parsed, "paymentOrders", "id");
  const eventIds = recordIdentifierSet(parsed, "events", "eventId");

  validateReferenceField(parsed, "inventory", "goodsId", catalogGoodsIds, "货品", result);
  validateReferenceField(parsed, "merchantGoodsTemplates", "goodsId", catalogGoodsIds, "货品", result, true);
  validateReferenceField(parsed, "registrationApplications", "linkedUserId", userIds, "用户", result, true);
  validateReferenceField(
    parsed,
    "registrationApplications",
    "tenantId",
    platformTenantIds,
    "平台租户",
    result,
    true
  );
  validateReferenceField(parsed, "adminCredentials", "userId", userIds, "用户", result);
  validateReferenceField(parsed, "backofficeCredentials", "userId", userIds, "用户", result);
  validateReferenceField(parsed, "paymentRefunds", "paymentOrderId", paymentOrderIds, "支付单", result);
  validateReferenceField(parsed, "paymentOrders", "eventId", eventIds, "开柜事件", result, true);
  validateReferenceField(parsed, "goodsBatches", "goodsId", catalogGoodsIds, "货品", result);
  validatePaymentRefundCompletionMarkers(parsed, result);
  validatePaymentRefundBindings(parsed, result);

  if (parsed.dataPlane === "live") {
    const platformTenants = parsed.platformTenants;

    if (parsed.initializationSource === "live-bootstrap-pending") {
      if (!Array.isArray(platformTenants) || platformTenants.length !== 0) {
        result.errors.push("待初始化 live 数据平面不能预先包含平台租户。");
      }
    } else if (!Array.isArray(platformTenants) || platformTenants.length !== 1) {
      result.errors.push("live 数据平面必须包含且仅包含一个当前平台租户。");
    }
  }

  const batches = parsed.goodsBatches;

  if (Array.isArray(batches)) {
    let negativeBalanceBatchCount = 0;

    for (const batch of batches) {
      if (!isRecord(batch)) {
        continue;
      }

      if (typeof batch.remainingQuantity === "number" && batch.remainingQuantity < 0) {
        negativeBalanceBatchCount += 1;
      }
    }

    if (negativeBalanceBatchCount > 0) {
      result.warnings.push(
        `存在 ${negativeBalanceBatchCount} 条负库存平衡批次，校验允许但恢复后需继续关注库存修正。`
      );
    }
  }

  const defaultCredentialWarning = summarizeDefaultCredentialWarnings(parsed);

  if (defaultCredentialWarning.count > 0) {
    result.warnings.push(
      `仍有 ${defaultCredentialWarning.count} 个默认密码凭据（${defaultCredentialWarning.details.join("；")}），公网投放前应改密或移除。`
    );
  }

  result.summary = {
    users: countArray(parsed, "users"),
    devices: countArray(parsed, "devices"),
    goodsCatalog: countArray(parsed, "goodsCatalog"),
    goodsBatches: countArray(parsed, "goodsBatches"),
    inventory: countArray(parsed, "inventory"),
    events: countArray(parsed, "events"),
    alerts: countArray(parsed, "alerts"),
    logs: countArray(parsed, "logs"),
    paymentOrders: countArray(parsed, "paymentOrders"),
    paymentRefunds: countArray(parsed, "paymentRefunds"),
    reservations: countArray(parsed, "reservations"),
    sessions: countArray(parsed, "sessions"),
    callbackLog: countArray(parsed, "callbackLog")
  };

  return result;
};

export const validatePersistedStateFile = (filePath: string): PersistedStateValidationResult => {
  if (!existsSync(filePath)) {
    return {
      summary: {},
      warnings: [],
      errors: ["未找到业务数据文件。"]
    };
  }

  try {
    return validatePersistedState(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return {
      summary: {},
      warnings: [],
      errors: ["业务数据 JSON 解析失败。"]
    };
  }
};

export const assertPersistedStateIntegrity = (state: unknown) => {
  const result = validatePersistedState(state);

  if (result.errors.length > 0) {
    throw new Error("运行数据完整性检查未通过。");
  }
};
