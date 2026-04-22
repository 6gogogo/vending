export type UserRole = "admin" | "merchant" | "special";
export type MobileDisplayRole = "admin" | "merchant" | "normal";
export type RegistrationStatus = "pending" | "approved" | "rejected";

export type GoodsCategory = "food" | "drink" | "daily";
export type InventoryLocationType = "device" | "warehouse";

export type DeviceStatus = "online" | "offline" | "maintenance";

export type CabinetEventStatus =
  | "created"
  | "opening"
  | "opened"
  | "closed"
  | "settled"
  | "failed"
  | "timeout_unopened"
  | "stuck_open"
  | "refunded";

export type InventoryMovementType =
  | "pickup"
  | "donation"
  | "expired"
  | "adjustment"
  | "manual-restock"
  | "manual-deduction"
  | "refund";

export type AlertStatus = "open" | "acknowledged" | "resolved";
export type AlertGrade = "fault" | "feedback" | "warning";

export type PolicyStatus = "active" | "inactive";
export type GoodsBatchSource = "admin" | "merchant" | "system";
export type OperationLogUndoState = "undoable" | "undone" | "not_undoable";
export type UserLedgerStatus =
  | "unregistered"
  | "registered"
  | "quota_unclaimed"
  | "quota_partial"
  | "quota_complete";

export type ServiceCompletionStatus = "complete" | "partial" | "unserved" | "not_applicable";

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface CallbackLogRecord {
  id: string;
  type: string;
  receivedAt: string;
  payload: unknown;
}

export interface SystemAuditLogEntry {
  occurredAt: string;
  method: string;
  path: string;
  query?: unknown;
  params?: unknown;
  body?: unknown;
  statusCode: number;
  durationMs: number;
  actorUserId?: string;
  actorRole?: UserRole;
  ip?: string;
  userAgent?: string;
  response?: unknown;
  error?: {
    name?: string;
    message?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface AccessQuota {
  dailyLimit: number;
  categoryLimit: Partial<Record<GoodsCategory, number>>;
}

export interface UserRecord {
  id: string;
  role: UserRole;
  phone: string;
  name: string;
  status: "active" | "inactive";
  neighborhood?: string;
  regionId?: string;
  regionName?: string;
  ledgerStatus?: UserLedgerStatus;
  tags: string[];
  quota?: AccessQuota;
  mobileProfileCompleted?: boolean;
  profile?: {
    note?: string;
    contactName?: string;
    address?: string;
    organization?: string;
    title?: string;
  };
  merchantProfile?: {
    donationWindowDays: number;
    defaultDeviceCodes: string[];
  };
  accessPolicies?: UserAccessPolicy[];
}

export interface RegistrationApplicationProfile {
  name: string;
  neighborhood?: string;
  regionId?: string;
  regionName?: string;
  note?: string;
  merchantName?: string;
  contactName?: string;
  address?: string;
  organization?: string;
  title?: string;
}

export interface RegistrationApplication {
  id: string;
  phone: string;
  requestedRole: UserRole;
  profile: RegistrationApplicationProfile;
  status: RegistrationStatus;
  reviewReason?: string;
  linkedUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MobileAuthDraft {
  token: string;
  phone: string;
  requestedRole?: UserRole;
  linkedUserId?: string;
  applicationId?: string;
}

export interface MobileSessionSnapshot {
  token: string;
  user: {
    id: string;
    role: UserRole;
    name: string;
    phone: string;
    tags: string[];
  };
  quota?: {
    role?: UserRole;
    limit?: AccessQuota | CabinetAccessRule;
    remainingToday: Record<string, number>;
    remainingByGoods?: Record<string, number>;
    usedCount?: number;
    activeWindows?: Array<{
      policyId: string;
      policyName: string;
      weekdays: number[];
      dateKey: string;
      startHour: number;
      endHour: number;
      goodsLimits: SpecialAccessPolicyGoodsLimit[];
    }>;
  };
}

export type MobileLoginResult =
  | ({
      state: "approved";
    } & MobileSessionSnapshot)
  | {
      state: "needs_profile";
      draft: MobileAuthDraft;
      phone: string;
      role: UserRole;
      profile?: RegistrationApplicationProfile;
      isExistingUser: boolean;
    }
  | {
      state: "pending_review";
      draft: MobileAuthDraft;
      application: RegistrationApplication;
    }
  | {
      state: "rejected";
      draft: MobileAuthDraft;
      application: RegistrationApplication;
    };

export type AppLoginResult =
  | ({
      state: "approved";
    } & MobileSessionSnapshot)
  | {
      state: "not_registered";
      phone: string;
      message: string;
    }
  | {
      state: "pending_review";
      phone: string;
      application: RegistrationApplication;
      message: string;
    }
  | {
      state: "rejected";
      phone: string;
      application: RegistrationApplication;
      message: string;
    };

export interface RegistrationPhoneLookup {
  phone: string;
  state: "new" | "existing_user" | "pending" | "rejected" | "approved";
  fixedRole?: UserRole;
  profile?: RegistrationApplicationProfile;
  application?: RegistrationApplication;
  linkedUser?: Pick<UserRecord, "id" | "role" | "name" | "phone" | "mobileProfileCompleted">;
  message?: string;
}

export interface MerchantGoodsTemplate {
  id: string;
  ownerUserId: string;
  goodsId?: string;
  goodsCode?: string;
  goodsName: string;
  fullName?: string;
  category: GoodsCategory;
  categoryName?: string;
  packageForm?: string;
  specification?: string;
  manufacturer?: string;
  defaultQuantity: number;
  defaultShelfLifeDays: number;
  imageUrl?: string;
  status: PolicyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoodsCatalogItem {
  goodsCode: string;
  goodsId: string;
  name: string;
  fullName?: string;
  category: GoodsCategory;
  categoryName?: string;
  price: number;
  imageUrl: string;
  packageForm?: string;
  specification?: string;
  manufacturer?: string;
  status?: PolicyStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface GoodsCategoryRecord {
  id: string;
  name: string;
  category: GoodsCategory;
  status: PolicyStatus;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegionRecord {
  id: string;
  name: string;
  status: PolicyStatus;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WarehouseRecord {
  code: string;
  name: string;
  location?: string;
  status: PolicyStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeviceGoods extends GoodsCatalogItem {
  stock: number;
  expiresAt?: string;
  thresholdEnabled?: boolean;
  lowStockThreshold?: number;
  stockHint?: string;
  expiringSoon?: boolean;
}

export interface DeviceDoor {
  doorNum: string;
  label: string;
  goods: DeviceGoods[];
}

export interface DeviceRuntimeState {
  deviceCode: string;
  doorState: "open" | "closed" | "unknown";
  lastCommandAt?: string;
  lastOpenedAt?: string;
  lastClosedAt?: string;
  lastRefreshAt?: string;
  openedAfterLastCommand: boolean;
}

export interface DeviceRecord {
  deviceCode: string;
  name: string;
  location: string;
  address?: string;
  longitude?: number;
  latitude?: number;
  distanceMeters?: number;
  status: DeviceStatus;
  doors: DeviceDoor[];
  lastSeenAt: string;
  runtime?: DeviceRuntimeState;
}

export interface CabinetAccessRule {
  role: Extract<UserRole, "special" | "merchant">;
  dailyLimit: number;
  categoryLimit: Partial<Record<GoodsCategory, number>>;
  requiresPhoneMatch: boolean;
  allowExpirySetup: boolean;
}

export interface CabinetOpenRequest {
  phone: string;
  deviceCode: string;
  doorNum?: string;
  payStyle?: string;
  category?: GoodsCategory;
  openMode?: "manual" | "scan";
  intentItems?: Array<{
    goodsId: string;
    quantity: number;
    goodsName?: string;
    category?: GoodsCategory;
  }>;
}

export interface CabinetOpenResult {
  orderNo: string;
  eventId: string;
  deviceCode: string;
  doorNum: string;
  role: UserRole;
  openMode?: "manual" | "scan";
  remainingQuota?: Partial<Record<string, number>>;
  acceptedIntentItems?: Array<{
    goodsId: string;
    quantity: number;
    goodsName?: string;
  }>;
}

export interface CabinetIntentItem {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  quantity: number;
}

export interface CabinetSettlementComparisonItem {
  goodsId: string;
  goodsName: string;
  quantity: number;
}

export interface CabinetSettlementComparison {
  matched: boolean;
  comparedAt: string;
  summary: string;
  intendedItems: CabinetSettlementComparisonItem[];
  settledItems: CabinetSettlementComparisonItem[];
  missingItems: CabinetSettlementComparisonItem[];
  extraItems: CabinetSettlementComparisonItem[];
}

export interface CabinetEventRecord {
  eventId: string;
  orderNo: string;
  userId: string;
  phone: string;
  role: UserRole;
  deviceCode: string;
  doorNum: string;
  openMode?: "manual" | "scan";
  status: CabinetEventStatus;
  createdAt: string;
  updatedAt: string;
  amount: number;
  intentItems?: CabinetIntentItem[];
  settlementComparison?: CabinetSettlementComparison;
  paymentNotifyUrl?: string;
  paymentNotifyStatus?: "pending" | "success" | "failed";
  paymentNotifyMessage?: string;
  paymentNotifiedAt?: string;
  paymentTransactionId?: string;
  adjustments?: CabinetAdjustmentRecord[];
  adjustmentOrderNo?: string;
  adjustmentNoticeUrl?: string;
  adjustmentAmount?: number;
  adjustmentPaymentNotifyStatus?: "pending" | "success" | "failed";
  adjustmentPaymentNotifyMessage?: string;
  adjustmentPaymentNotifiedAt?: string;
  adjustmentPaymentTransactionId?: string;
  adjustmentRefundNo?: string;
  adjustmentRefundTransactionId?: string;
  adjustmentRefundedAt?: string;
  refundNo?: string;
  refundTransactionId?: string;
  refundedAt?: string;
  goods: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface CabinetAdjustmentRecord {
  orderNo: string;
  sourceOrderNo?: string;
  noticeUrl?: string;
  amount: number;
  createdAt: string;
  updatedAt: string;
  goods?: Array<{
    goodsId: string;
    goodsName: string;
    quantity: number;
    unitPrice: number;
  }>;
  paymentNotifyStatus?: "pending" | "success" | "failed";
  paymentNotifyMessage?: string;
  paymentNotifiedAt?: string;
  paymentTransactionId?: string;
  refundNo?: string;
  refundTransactionId?: string;
  refundedAt?: string;
}

export interface InventoryMovement {
  id: string;
  orderNo?: string;
  sourceOrderNo?: string;
  eventId?: string;
  userId: string;
  deviceCode: string;
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  quantity: number;
  unitPrice: number;
  type: InventoryMovementType;
  happenedAt: string;
  expiresAt?: string;
  transactionId?: string;
  refundNo?: string;
}

export interface AlertTask {
  id: string;
  type: "expiry" | "callback" | "inventory" | "device_fault" | "user_feedback";
  grade: AlertGrade;
  title: string;
  status: AlertStatus;
  deviceCode?: string;
  deviceName?: string;
  targetUserId?: string;
  targetUserName?: string;
  goodsId?: string;
  goodsName?: string;
  goodsSummary?: string;
  dueAt: string;
  createdAt: string;
  detail: string;
  previewDetail?: string;
  sourceLogId?: string;
  relatedEventId?: string;
  resolvedAt?: string;
  resolvedByUserId?: string;
  resolutionNote?: string;
}

export type OperationLogCategory =
  | "pickup"
  | "restock"
  | "device"
  | "admin"
  | "alert"
  | "inventory"
  | "user"
  | "policy"
  | "goods";

export type OperationLogStatus = "success" | "pending" | "warning" | "failed";

export interface OperationLogActor {
  type: "admin" | "merchant" | "special" | "system";
  id?: string;
  name: string;
  role?: UserRole;
}

export interface OperationLogSubject {
  type: "user" | "device" | "event" | "alert" | "goods" | "warehouse" | "stocktake";
  id: string;
  label: string;
}

export interface OperationLogRecord {
  id: string;
  category: OperationLogCategory;
  type: string;
  status: OperationLogStatus;
  occurredAt: string;
  actor: OperationLogActor;
  primarySubject?: OperationLogSubject;
  secondarySubject?: OperationLogSubject;
  detail: string;
  description: string;
  relatedEventId?: string;
  relatedOrderNo?: string;
  metadata?: Record<string, unknown>;
}

export interface SpecialAccessPolicyGoodsLimit {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  quantity: number;
}

export interface SpecialAccessPolicy {
  id: string;
  name: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
  goodsLimits: SpecialAccessPolicyGoodsLimit[];
  applicableUserIds: string[];
  status: PolicyStatus;
}

export interface UserAccessPolicy {
  id: string;
  name: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
  goodsLimits: SpecialAccessPolicyGoodsLimit[];
  status: PolicyStatus;
  sourcePolicyId?: string;
  effectiveFromDateKey?: string;
  effectiveToDateKey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ServiceOverviewPerson {
  userId: string;
  name: string;
  phone: string;
  neighborhood?: string;
  completionStatus: ServiceCompletionStatus;
  fulfilledGoods: number;
  totalGoods: number;
  summary: string;
  detailLines?: string[];
}

export interface ServiceOverviewBucket {
  count: number;
  users: ServiceOverviewPerson[];
}

export interface GoodsOverviewItem {
  deviceCode: string;
  deviceName: string;
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  stock: number;
  thresholdEnabled: boolean;
  lowStockThreshold?: number;
  status: "ok" | "low" | "empty";
  nearestExpiryAt?: string;
}

export interface GoodsAlertPolicyThreshold {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  lowStockThreshold: number;
}

export interface GoodsAlertPolicy {
  id: string;
  name: string;
  applicableDeviceCodes: string[];
  thresholds: GoodsAlertPolicyThreshold[];
  status: PolicyStatus;
}

export interface GoodsBatchRecord {
  batchId: string;
  goodsId: string;
  deviceCode: string;
  locationType?: InventoryLocationType;
  locationName?: string;
  quantity: number;
  remainingQuantity: number;
  expiresAt?: string;
  createdAt: string;
  sourceType: GoodsBatchSource;
  sourceUserId?: string;
  sourceUserName?: string;
  sourcePolicyId?: string;
  note?: string;
}

export interface BatchConsumptionTrace {
  id: string;
  batchId: string;
  goodsId: string;
  goodsName: string;
  deviceCode: string;
  sourceUserId?: string;
  sourceUserName?: string;
  consumerUserId?: string;
  consumerUserName?: string;
  quantity: number;
  happenedAt: string;
  orderNo?: string;
  eventId?: string;
}

export interface DeviceGoodsSetting {
  deviceCode: string;
  goodsId: string;
  enabled: boolean;
  lowStockThreshold?: number;
  sourcePolicyId?: string;
  updatedAt: string;
}

export interface GoodsOverviewSnapshot {
  totalKinds: number;
  lowStockKinds: number;
  outOfStockKinds: number;
  policyCount: number;
  settingCount: number;
  warehouseStockTotal: number;
  flaggedGoods: GoodsOverviewItem[];
  byDevice: Array<{
    deviceCode: string;
    deviceName: string;
    totalStock: number;
    kinds: number;
    lowStockItems: number;
  }>;
  byGoods: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    totalStock: number;
    warehouseStock: number;
    lowStockDevices: number;
    outOfStockDevices: number;
    nearestExpiryAt?: string;
    deviceDistribution: GoodsOverviewItem[];
  }>;
  recentLogs: OperationLogRecord[];
}

export interface GoodsDetailSnapshot {
  goods: GoodsCatalogItem;
  totalStock: number;
  warehouseStock: number;
  nearestExpiryAt?: string;
  deviceDistribution: GoodsOverviewItem[];
  batches: GoodsBatchRecord[];
  deviceSettings: Array<{
    deviceCode: string;
    deviceName: string;
    enabled: boolean;
    lowStockThreshold?: number;
    currentStock: number;
    nearestExpiryAt?: string;
  }>;
  recentLogs: OperationLogRecord[];
}

export interface WarehouseInventoryItem {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  totalStock: number;
  nearestExpiryAt?: string;
  batchCount: number;
}

export interface InventoryTransferRecord {
  id: string;
  fromType: InventoryLocationType;
  fromCode: string;
  fromName: string;
  toType: InventoryLocationType;
  toCode: string;
  toName: string;
  goodsId: string;
  goodsName: string;
  quantity: number;
  happenedAt: string;
  actorUserId?: string;
  actorUserName?: string;
  note?: string;
  batches: Array<{
    sourceBatchId: string;
    quantity: number;
    expiresAt?: string;
  }>;
}

export interface StocktakeItem {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  systemQuantity: number;
  actualQuantity: number;
  delta: number;
  nearestExpiryAt?: string;
  batchCount: number;
}

export interface StocktakeRecord {
  id: string;
  deviceCode: string;
  deviceName: string;
  createdAt: string;
  actorUserId?: string;
  actorUserName?: string;
  note?: string;
  items: StocktakeItem[];
}

export interface WarehouseInventorySnapshot {
  warehouse: WarehouseRecord;
  totalStock: number;
  goodsKinds: number;
  items: WarehouseInventoryItem[];
  transfers: InventoryTransferRecord[];
  stocktakes: StocktakeRecord[];
  recentLogs: OperationLogRecord[];
}

export interface MerchantRestockDailySummary {
  dateKey: string;
  claimedUnits: number;
  helpedUsers: number;
  helpTimes: number;
  cumulativeHelpTimes: number;
}

export interface DashboardStats {
  completeUsers: number;
  partialUsers: number;
  unservedUsers: number;
  pendingTasks: number;
  lowStockKinds: number;
  outOfStockKinds: number;
}

export interface TrendPoint {
  label: string;
  pickups: number;
  donations: number;
}

export interface DashboardSnapshot {
  businessDateKey: string;
  stats: DashboardStats;
  weeklyTrend: TrendPoint[];
  taskGradeSummary: Record<AlertGrade, number>;
  serviceOverview: {
    completeUsers: ServiceOverviewBucket;
    partialUsers: ServiceOverviewBucket;
    unservedUsers: ServiceOverviewBucket;
    totalUsers: number;
  };
  pendingTasks: AlertTask[];
  goodsOverview: GoodsOverviewSnapshot;
  summaryLogs: OperationLogRecord[];
}

export interface DeviceMonitoringDetail {
  device: DeviceRecord;
  runtime: DeviceRuntimeState;
  businessDateKey: string;
  servedUsers: number;
  totalStock: number;
  pendingTasks: AlertTask[];
  recentEvents: CabinetEventRecord[];
  recentLogs: OperationLogRecord[];
  businessDayServedUsers: Array<{
    userId: string;
    userName: string;
    role: UserRole;
    goodsSummary: string;
    totalQuantity: number;
    lastServedAt: string;
  }>;
  stockChanges: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    currentStock: number;
    deltaSinceStartOfBusinessDay: number;
    thresholdEnabled: boolean;
    lowStockThreshold?: number;
    nearestExpiryAt?: string;
  }>;
  debug?: {
    callbackLogs: CallbackLogRecord[];
    systemAuditLogs: SystemAuditLogEntry[];
  };
}

export interface SpecialAccessWindowUsage {
  policyId: string;
  policyName: string;
  weekdays: number[];
  dateKey: string;
  startHour: number;
  endHour: number;
  goodsUsage: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    quantityLimit: number;
    usedQuantity: number;
  }>;
}

export interface UserPolicyCalendarDay {
  dateKey: string;
  day: number;
  inCurrentMonth: boolean;
  completionStatus: ServiceCompletionStatus;
  hasPickup: boolean;
  hasAdjustment: boolean;
}

export interface UserPolicyCalendarSummary {
  monthKey: string;
  selectedDateKey: string;
  days: UserPolicyCalendarDay[];
  selectedDateSummary?: {
    businessDateKey: string;
    completionStatus: ServiceCompletionStatus;
    fulfilledGoods: number;
    totalGoods: number;
    windows: SpecialAccessWindowUsage[];
  };
}

export interface DataMonitorCalendarDay {
  dateKey: string;
  day: number;
  inCurrentMonth: boolean;
  hasData: boolean;
  activityLevel: "none" | "light" | "medium" | "high";
}

export type DataMonitorMetricKey =
  | "servedUsers"
  | "pickupUnits"
  | "restockUnits"
  | "transferUnits"
  | "eventCount"
  | "feedbackResolvedCount"
  | "logCount";

export type DataMonitorRange = "today" | "3d" | "7d";

export interface DataMonitorMetricBar {
  key: DataMonitorMetricKey;
  label: string;
  value: number;
  unit: string;
}

export interface DataMonitorRangePoint {
  dateKey: string;
  label: string;
  servedUsers: number;
  pickupUnits: number;
  restockUnits: number;
  transferUnits: number;
  eventCount: number;
  feedbackResolvedCount: number;
  logCount: number;
}

export interface DataMonitorTimeBucketBar {
  key: "morning" | "midday" | "afternoon" | "night";
  label: string;
  value: number;
}

export interface DataMonitorRegionBreakdown {
  regionId?: string;
  regionName: string;
  servedUsers: number;
  pickupUnits: number;
  pickupTimes: number;
  firstPickupAt?: string;
  lastPickupAt?: string;
  peakHourLabel?: string;
  timeBars: DataMonitorTimeBucketBar[];
}

export interface DataMonitorDailySummary {
  businessDateKey: string;
  servedUsers: number;
  pickupUnits: number;
  restockUnits: number;
  transferUnits: number;
  eventCount: number;
  feedbackResolvedCount: number;
  logCount: number;
  metricBars: DataMonitorMetricBar[];
  topGoods: Array<{
    goodsId: string;
    goodsName: string;
    quantity: number;
  }>;
  topDevices: Array<{
    deviceCode: string;
    deviceName: string;
    pickupUnits: number;
    restockUnits: number;
    eventCount: number;
  }>;
  recentLogs: OperationLogRecord[];
}

export interface DataMonitorSnapshot {
  monthKey: string;
  selectedDateKey: string;
  range: DataMonitorRange;
  days: DataMonitorCalendarDay[];
  selectedDateSummary?: DataMonitorDailySummary;
  periodSummary?: DataMonitorDailySummary;
  rangeStartDateKey: string;
  rangeEndDateKey: string;
  rangeSeries: DataMonitorRangePoint[];
  rangeSummary: Omit<DataMonitorRangePoint, "dateKey" | "label">;
  regionBreakdown: DataMonitorRegionBreakdown[];
}

export type AiInsightConfidence = "high" | "medium" | "low";
export type AiInsightUrgency = "high" | "medium" | "low";
export type AiOperationsReportType = "morning" | "daily";

export interface AiProviderStatus {
  enabled: boolean;
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  missingConfig: string[];
}

export interface AiInsightMeta {
  generatedAt: string;
  provider: "openai-compatible";
  model: string;
}

export interface AiEventDiagnosis {
  meta: AiInsightMeta;
  target: {
    eventId: string;
    orderNo: string;
    deviceCode: string;
    deviceName?: string;
    status: CabinetEventStatus;
    relatedLogId?: string;
  };
  summary: string;
  confidence: AiInsightConfidence;
  possibleCauses: string[];
  handlingSuggestions: string[];
  requiresOnsiteInspection: boolean;
  onsiteInspectionReason: string;
  referencedSignals: string[];
}

export interface AiOperationsReport {
  meta: AiInsightMeta;
  dateKey: string;
  reportType: AiOperationsReportType;
  summary: string;
  priorityItems: string[];
  stockRisks: string[];
  expiryRisks: string[];
  feedbackHighlights: string[];
  recommendedActions: string[];
}

export interface AiDeviceRestockRecommendation {
  deviceCode: string;
  deviceName: string;
  goodsId?: string;
  goodsName: string;
  suggestedQuantity?: number;
  reason: string;
}

export interface AiRegionLayoutRecommendation {
  regionId?: string;
  regionName: string;
  suggestion: string;
  reason: string;
}

export interface AiRestockLayoutSuggestion {
  meta: AiInsightMeta;
  dateKey: string;
  range: DataMonitorRange;
  summary: string;
  deviceRecommendations: AiDeviceRestockRecommendation[];
  regionRecommendations: AiRegionLayoutRecommendation[];
  scheduleInsights: string[];
}

export interface AiFeedbackDraft {
  meta: AiInsightMeta;
  alertId: string;
  title: string;
  classification: string;
  urgency: AiInsightUrgency;
  summary: string;
  dispatchRecommendation: string;
  replyDraft: string;
}

export interface AiPolicyOptimizationSuggestion {
  meta: AiInsightMeta;
  dateKey: string;
  range: DataMonitorRange;
  summary: string;
  underservedSignals: string[];
  proposedAdjustments: string[];
  cautionNotes: string[];
}

export interface UserManagementDetail {
  user: UserRecord;
  stats?: {
    pickupCount: number;
    donationCount: number;
    adjustmentCount: number;
    lastActiveAt?: string;
  };
  recentRecords: InventoryMovement[];
  recentEvents: CabinetEventRecord[];
  recentLogs: OperationLogRecord[];
  relatedTasks?: AlertTask[];
  applicablePolicies?: SpecialAccessPolicy[];
  accessPolicies?: UserAccessPolicy[];
  businessDaySummary?: {
    businessDateKey: string;
    completionStatus: ServiceCompletionStatus;
    windows: SpecialAccessWindowUsage[];
  };
  policyCalendar?: UserPolicyCalendarSummary;
}

export interface SmartVmCredentials {
  clientId: string;
  key: string;
}

export interface SmartVmDoorStatusPayload {
  eventId: string;
  deviceCode: string;
  status: "OPENDING" | "SUCCESS" | "CLOSED" | "FAIL";
  doorIsOpen?: "Y" | "N";
}

export interface SmartVmSettlementPayload {
  orderNo: string;
  eventId: string;
  phone: string;
  deviceCode: string;
  amount: number;
  notifyUrl: string;
  detail?: Array<{
    goodsName: string;
    quantity: number;
    unitPrice: number;
    goodsId: string;
  }>;
}

export interface SmartVmAdjustmentPayload {
  orgOrderNo: string;
  orderNo: string;
  eventId: string;
  phone: string;
  deviceCode: string;
  amount: number;
  noticeUrl: string;
  detail?: Array<{
    goodsName: string;
    quantity: number;
    unitPrice: number;
    goodsId: string;
  }>;
}

export interface SmartVmPaymentPayload {
  orderNo: string;
  eventId: string;
  transactionId: string;
  openId?: string;
  deviceCode: string;
  amount: number;
  targetUrl?: string;
  notifyUrl?: string;
  noticeUrl?: string;
}

export interface SmartVmRefundPayload {
  orderNo: string;
  transactionId: string;
  refundNo: string;
  deviceCode: string;
  amount: number;
}

export const seedUsers: UserRecord[] = [
  {
    id: "admin-001",
    role: "admin",
    phone: "13800000001",
    name: "街道管理员",
    status: "active",
    regionId: "region-001",
    regionName: "扬名街道",
    tags: ["运营"],
    mobileProfileCompleted: false,
    profile: {
      organization: "扬名街道办",
      title: "值班管理员"
    }
  },
  {
    id: "special-001",
    role: "special",
    phone: "13800000002",
    name: "林阿姨",
    status: "active",
    neighborhood: "扬名街道",
    regionId: "region-001",
    regionName: "扬名街道",
    tags: ["老人", "重点关怀"],
    mobileProfileCompleted: false,
    profile: {
      note: "首批导入"
    },
    quota: {
      dailyLimit: 2,
      categoryLimit: {
        food: 1,
        drink: 1
      }
    }
  },
  {
    id: "special-002",
    role: "special",
    phone: "13800000003",
    name: "陈师傅",
    status: "active",
    neighborhood: "扬名街道",
    regionId: "region-001",
    regionName: "扬名街道",
    tags: ["新业态劳动者"],
    mobileProfileCompleted: false,
    profile: {
      note: "首批导入"
    },
    quota: {
      dailyLimit: 2,
      categoryLimit: {
        food: 1,
        drink: 1
      }
    }
  },
  {
    id: "special-003",
    role: "special",
    phone: "13800000005",
    name: "赵阿姨",
    status: "active",
    neighborhood: "扬名街道",
    regionId: "region-001",
    regionName: "扬名街道",
    tags: ["独居老人"],
    mobileProfileCompleted: false,
    profile: {
      note: "首批导入"
    },
    quota: {
      dailyLimit: 2,
      categoryLimit: {
        food: 1,
        drink: 1
      }
    }
  },
  {
    id: "merchant-001",
    role: "merchant",
    phone: "13800000004",
    name: "鲜食爱心商户",
    status: "active",
    regionId: "region-001",
    regionName: "扬名街道",
    tags: ["食品捐赠"],
    mobileProfileCompleted: false,
    profile: {
      contactName: "王店长",
      address: "扬名路 18 号"
    },
    merchantProfile: {
      donationWindowDays: 2,
      defaultDeviceCodes: ["CAB-1001", "CAB-1002"]
    }
  }
];

export const seedRules: CabinetAccessRule[] = [
  {
    role: "special",
    dailyLimit: 2,
    categoryLimit: {
      food: 1,
      drink: 1,
      daily: 1
    },
    requiresPhoneMatch: true,
    allowExpirySetup: false
  },
  {
    role: "merchant",
    dailyLimit: 8,
    categoryLimit: {},
    requiresPhoneMatch: true,
    allowExpirySetup: true
  }
];

export const seedDevices: DeviceRecord[] = [
  {
    deviceCode: "CAB-1001",
    name: "扬名西点位",
    location: "扬名街道西侧公益柜",
    address: "扬名路 18 号西侧广场",
    longitude: 120.28921,
    latitude: 31.55224,
    status: "online",
    lastSeenAt: "2026-04-08T02:30:00.000Z",
    doors: [
      {
        doorNum: "1",
        label: "右门",
        goods: [
          {
            goodsCode: "690000000001",
            goodsId: "goods-1001",
            name: "三明治",
            category: "food",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/dae4ff/0b1220.png",
            stock: 3,
            expiresAt: "2026-04-09T08:00:00.000Z"
          },
          {
            goodsCode: "690000000002",
            goodsId: "goods-1002",
            name: "牛奶",
            category: "drink",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/c8f7e7/0b1220.png",
            stock: 1
          }
        ]
      }
    ]
  },
  {
    deviceCode: "CAB-1002",
    name: "扬名东点位",
    location: "扬名街道东侧公益柜",
    address: "扬名路 26 号东侧便民点",
    longitude: 120.29382,
    latitude: 31.55347,
    status: "online",
    lastSeenAt: "2026-04-08T02:35:00.000Z",
    doors: [
      {
        doorNum: "1",
        label: "右门",
        goods: [
          {
            goodsCode: "690000000003",
            goodsId: "goods-1003",
            name: "方便面",
            category: "food",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/f8d9c8/0b1220.png",
            stock: 0
          },
          {
            goodsCode: "690000000004",
            goodsId: "goods-1004",
            name: "牙刷",
            category: "daily",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/f7f3b8/0b1220.png",
            stock: 6
          }
        ]
      }
    ]
  }
];

export const seedGoodsCatalog: GoodsCatalogItem[] = [
  {
    goodsCode: "690000000001",
    goodsId: "goods-1001",
    name: "三明治",
    fullName: "鲜食火腿三明治 180g",
    category: "food",
    categoryName: "鲜食面包",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/dae4ff/0b1220.png",
    packageForm: "盒装",
    specification: "180g",
    manufacturer: "社区鲜食工坊",
    status: "active",
    createdAt: "2026-04-07T08:00:00.000Z",
    updatedAt: "2026-04-08T00:22:00.000Z"
  },
  {
    goodsCode: "690000000002",
    goodsId: "goods-1002",
    name: "牛奶",
    fullName: "高钙纯牛奶 250ml",
    category: "drink",
    categoryName: "乳饮",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/c8f7e7/0b1220.png",
    packageForm: "盒装",
    specification: "250ml",
    manufacturer: "社区乳品合作社",
    status: "active",
    createdAt: "2026-04-07T08:00:00.000Z",
    updatedAt: "2026-04-08T00:22:00.000Z"
  },
  {
    goodsCode: "690000000003",
    goodsId: "goods-1003",
    name: "方便面",
    fullName: "红烧牛肉面 103g",
    category: "food",
    categoryName: "方便食品",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/f8d9c8/0b1220.png",
    packageForm: "桶装",
    specification: "103g",
    manufacturer: "民生食品厂",
    status: "active",
    createdAt: "2026-04-07T08:00:00.000Z",
    updatedAt: "2026-04-08T00:22:00.000Z"
  },
  {
    goodsCode: "690000000004",
    goodsId: "goods-1004",
    name: "牙刷",
    fullName: "软毛成人牙刷",
    category: "daily",
    categoryName: "洗护清洁",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/f7f3b8/0b1220.png",
    packageForm: "袋装",
    specification: "1 支",
    manufacturer: "公益日用品厂",
    status: "active",
    createdAt: "2026-04-07T08:00:00.000Z",
    updatedAt: "2026-04-08T00:22:00.000Z"
  }
];

export const seedGoodsCategories: GoodsCategoryRecord[] = [
  {
    id: "goods-category-001",
    name: "鲜食面包",
    category: "food",
    status: "active",
    sortOrder: 1,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  },
  {
    id: "goods-category-002",
    name: "方便食品",
    category: "food",
    status: "active",
    sortOrder: 2,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  },
  {
    id: "goods-category-003",
    name: "乳饮",
    category: "drink",
    status: "active",
    sortOrder: 3,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  },
  {
    id: "goods-category-004",
    name: "洗护清洁",
    category: "daily",
    status: "active",
    sortOrder: 4,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  }
];

export const seedRegions: RegionRecord[] = [
  {
    id: "region-001",
    name: "扬名街道",
    status: "active",
    sortOrder: 1,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  },
  {
    id: "region-002",
    name: "清名桥片区",
    status: "active",
    sortOrder: 2,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  },
  {
    id: "region-other",
    name: "其他",
    status: "active",
    sortOrder: 99,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  }
];

export const seedWarehouses: WarehouseRecord[] = [
  {
    code: "WAREHOUSE-LOCAL",
    name: "本地仓库",
    location: "街道物资中转点",
    status: "active",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z"
  }
];

export const seedSpecialAccessPolicies: SpecialAccessPolicy[] = [
  {
    id: "policy-001",
    name: "早餐关怀",
    weekdays: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 12,
    goodsLimits: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 1
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        quantity: 1
      }
    ],
    applicableUserIds: ["special-001", "special-002", "special-003"],
    status: "active"
  }
];

export const seedGoodsAlertPolicies: GoodsAlertPolicy[] = [
  {
    id: "goods-policy-001",
    name: "早餐柜机低库存模板",
    applicableDeviceCodes: ["CAB-1001", "CAB-1002"],
    status: "active",
    thresholds: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        lowStockThreshold: 2
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        lowStockThreshold: 1
      },
      {
        goodsId: "goods-1003",
        goodsName: "方便面",
        category: "food",
        lowStockThreshold: 2
      }
    ]
  }
];

export const seedRegistrationApplications: RegistrationApplication[] = [
  {
    id: "application-001",
    phone: "13800000006",
    requestedRole: "merchant",
    profile: {
      name: "社区烘焙坊",
      merchantName: "社区烘焙坊",
      contactName: "李店长",
      address: "扬名路 26 号",
      note: "等待街道审核"
    },
    status: "pending",
    createdAt: "2026-04-08T03:20:00.000Z",
    updatedAt: "2026-04-08T03:20:00.000Z"
  },
  {
    id: "application-002",
    phone: "13800000007",
    requestedRole: "special",
    profile: {
      name: "周阿姨",
      neighborhood: "扬名街道",
      regionId: "region-001",
      regionName: "扬名街道",
      note: "资料不完整，已驳回"
    },
    status: "rejected",
    reviewReason: "缺少区域补充信息，请完善后重新提交。",
    createdAt: "2026-04-08T01:20:00.000Z",
    updatedAt: "2026-04-08T02:00:00.000Z"
  }
];

export const seedMerchantGoodsTemplates: MerchantGoodsTemplate[] = [
  {
    id: "template-001",
    ownerUserId: "merchant-001",
    goodsId: "goods-1001",
    goodsCode: "690000000001",
    goodsName: "三明治",
    fullName: "鲜食火腿三明治 180g",
    category: "food",
    categoryName: "鲜食面包",
    packageForm: "盒装",
    specification: "180g",
    manufacturer: "社区鲜食工坊",
    defaultQuantity: 6,
    defaultShelfLifeDays: 2,
    imageUrl: "https://dummyimage.com/160x160/dae4ff/0b1220.png",
    status: "active",
    createdAt: "2026-04-08T00:05:00.000Z",
    updatedAt: "2026-04-08T00:05:00.000Z"
  }
];

export const seedDeviceGoodsSettings: DeviceGoodsSetting[] = [
  {
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    enabled: true,
    lowStockThreshold: 2,
    sourcePolicyId: "goods-policy-001",
    updatedAt: "2026-04-08T00:25:00.000Z"
  },
  {
    deviceCode: "CAB-1001",
    goodsId: "goods-1002",
    enabled: true,
    lowStockThreshold: 1,
    sourcePolicyId: "goods-policy-001",
    updatedAt: "2026-04-08T00:25:00.000Z"
  },
  {
    deviceCode: "CAB-1002",
    goodsId: "goods-1003",
    enabled: true,
    lowStockThreshold: 2,
    sourcePolicyId: "goods-policy-001",
    updatedAt: "2026-04-08T00:25:00.000Z"
  }
];

export const seedGoodsBatches: GoodsBatchRecord[] = [
  {
    batchId: "batch-001",
    goodsId: "goods-1001",
    deviceCode: "CAB-1001",
    quantity: 4,
    remainingQuantity: 2,
    expiresAt: "2026-04-09T08:00:00.000Z",
    createdAt: "2026-04-08T00:22:00.000Z",
    sourceType: "merchant",
    sourceUserId: "merchant-001",
    sourceUserName: "鲜食爱心商户",
    note: "早餐批次"
  },
  {
    batchId: "batch-002",
    goodsId: "goods-1002",
    deviceCode: "CAB-1001",
    quantity: 2,
    remainingQuantity: 1,
    expiresAt: "2026-04-09T08:00:00.000Z",
    createdAt: "2026-04-08T00:22:00.000Z",
    sourceType: "merchant",
    sourceUserId: "merchant-001",
    sourceUserName: "鲜食爱心商户",
    note: "早餐批次"
  },
  {
    batchId: "batch-003",
    goodsId: "goods-1004",
    deviceCode: "CAB-1002",
    locationType: "device",
    locationName: "扬名东点位",
    quantity: 6,
    remainingQuantity: 6,
    createdAt: "2026-04-08T00:10:00.000Z",
    sourceType: "system",
    sourceUserName: "系统补录",
    note: "日用品初始化"
  },
  {
    batchId: "batch-warehouse-001",
    goodsId: "goods-1001",
    deviceCode: "WAREHOUSE-LOCAL",
    locationType: "warehouse",
    locationName: "本地仓库",
    quantity: 8,
    remainingQuantity: 8,
    expiresAt: "2026-04-10T08:00:00.000Z",
    createdAt: "2026-04-08T00:30:00.000Z",
    sourceType: "admin",
    sourceUserId: "admin-001",
    sourceUserName: "街道管理员",
    note: "仓库备货"
  }
];

export const seedBatchConsumptionTraces: BatchConsumptionTrace[] = [
  {
    id: "trace-001",
    batchId: "batch-001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    deviceCode: "CAB-1001",
    sourceUserId: "merchant-001",
    sourceUserName: "鲜食爱心商户",
    consumerUserId: "special-001",
    consumerUserName: "林阿姨",
    quantity: 1,
    happenedAt: "2026-04-08T01:06:00.000Z",
    orderNo: "ord-001",
    eventId: "evt-001"
  },
  {
    id: "trace-002",
    batchId: "batch-002",
    goodsId: "goods-1002",
    goodsName: "牛奶",
    deviceCode: "CAB-1001",
    sourceUserId: "merchant-001",
    sourceUserName: "鲜食爱心商户",
    consumerUserId: "special-001",
    consumerUserName: "林阿姨",
    quantity: 1,
    happenedAt: "2026-04-08T01:08:00.000Z",
    orderNo: "ord-001",
    eventId: "evt-001"
  },
  {
    id: "trace-003",
    batchId: "batch-001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    deviceCode: "CAB-1001",
    sourceUserId: "merchant-001",
    sourceUserName: "鲜食爱心商户",
    consumerUserId: "special-002",
    consumerUserName: "陈师傅",
    quantity: 1,
    happenedAt: "2026-04-08T01:30:00.000Z",
    orderNo: "ord-002",
    eventId: "evt-002"
  }
];

export const seedInventoryTransfers: InventoryTransferRecord[] = [];

export const seedStocktakes: StocktakeRecord[] = [];

export const seedEvents: CabinetEventRecord[] = [
  {
    eventId: "evt-001",
    orderNo: "ord-001",
    userId: "special-001",
    phone: "13800000002",
    role: "special",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "settled",
    createdAt: "2026-04-08T01:02:00.000Z",
    updatedAt: "2026-04-08T01:08:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 1,
        unitPrice: 0
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        quantity: 1,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-002",
    orderNo: "ord-002",
    userId: "special-002",
    phone: "13800000003",
    role: "special",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "settled",
    createdAt: "2026-04-08T01:20:00.000Z",
    updatedAt: "2026-04-08T01:30:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 1,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-003",
    orderNo: "ord-003",
    userId: "merchant-001",
    phone: "13800000004",
    role: "merchant",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "closed",
    createdAt: "2026-04-08T00:15:00.000Z",
    updatedAt: "2026-04-08T00:22:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 4,
        unitPrice: 0
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        quantity: 2,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-004",
    orderNo: "ord-004",
    userId: "admin-001",
    phone: "13800000001",
    role: "admin",
    deviceCode: "CAB-1002",
    doorNum: "1",
    status: "opening",
    createdAt: "2026-04-08T02:00:00.000Z",
    updatedAt: "2026-04-08T02:00:30.000Z",
    amount: 0,
    goods: []
  }
];

export const seedInventory: InventoryMovement[] = [
  {
    id: "mov-001",
    orderNo: "ord-001",
    userId: "special-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-04-08T01:06:00.000Z"
  },
  {
    id: "mov-002",
    orderNo: "ord-001",
    userId: "special-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1002",
    goodsName: "牛奶",
    category: "drink",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-04-08T01:08:00.000Z"
  },
  {
    id: "mov-003",
    orderNo: "ord-002",
    userId: "special-002",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-04-08T01:30:00.000Z"
  },
  {
    id: "mov-004",
    orderNo: "ord-003",
    userId: "merchant-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 4,
    unitPrice: 0,
    type: "donation",
    happenedAt: "2026-04-08T00:22:00.000Z",
    expiresAt: "2026-04-09T08:00:00.000Z"
  },
  {
    id: "mov-005",
    orderNo: "ord-003",
    userId: "merchant-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1002",
    goodsName: "牛奶",
    category: "drink",
    quantity: 2,
    unitPrice: 0,
    type: "donation",
    happenedAt: "2026-04-08T00:22:00.000Z",
    expiresAt: "2026-04-09T08:00:00.000Z"
  }
];

export const seedAlerts: AlertTask[] = [
  {
    id: "task-001",
    type: "expiry",
    grade: "warning",
    title: "物资即将过期",
    status: "open",
    deviceCode: "CAB-1001",
    targetUserId: "merchant-001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    dueAt: "2026-04-09T06:00:00.000Z",
    createdAt: "2026-04-08T02:40:00.000Z",
    detail: "三明治批次即将到期，请在领取期限结束前处理。"
  },
  {
    id: "task-002",
    type: "device_fault",
    grade: "fault",
    title: "柜机开门无响应",
    status: "open",
    deviceCode: "CAB-1002",
    dueAt: "2026-04-08T02:02:00.000Z",
    createdAt: "2026-04-08T02:01:30.000Z",
    detail: "远程开门后超过 90 秒未收到成功开门确认。",
    relatedEventId: "evt-004",
    sourceLogId: "log-004"
  },
  {
    id: "task-003",
    type: "user_feedback",
    grade: "feedback",
    title: "用户反馈柜门关闭缓慢",
    status: "open",
    deviceCode: "CAB-1001",
    targetUserId: "special-002",
    dueAt: "2026-04-08T03:20:00.000Z",
    createdAt: "2026-04-08T02:50:00.000Z",
    detail: "陈师傅反馈 CAB-1001 关门速度较慢，需要现场检查闭门器。"
  }
];

export const seedOperationLogs: OperationLogRecord[] = [
  {
    id: "log-001",
    category: "restock",
    type: "inventory-restock",
    status: "success",
    occurredAt: "2026-04-08T00:22:00.000Z",
    actor: {
      type: "merchant",
      id: "merchant-001",
      name: "鲜食爱心商户",
      role: "merchant"
    },
    primarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    secondarySubject: {
      type: "goods",
      id: "goods-1001",
      label: "三明治"
    },
    description: "鲜食爱心商户向扬名西点位补充了三明治 x4。",
    detail: "商户完成补货开柜后，向 CAB-1001 投放三明治 4 件。",
    relatedEventId: "evt-003",
    relatedOrderNo: "ord-003",
    metadata: {
      quantity: 4,
      deviceCode: "CAB-1001",
      goodsId: "goods-1001",
      goodsName: "三明治",
      undoState: "not_undoable"
    }
  },
  {
    id: "log-002",
    category: "pickup",
    type: "inventory-pickup",
    status: "success",
    occurredAt: "2026-04-08T01:08:00.000Z",
    actor: {
      type: "special",
      id: "special-001",
      name: "林阿姨",
      role: "special"
    },
    primarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    secondarySubject: {
      type: "goods",
      id: "goods-1002",
      label: "牛奶"
    },
    description: "林阿姨在扬名西点位领取牛奶 x1。",
    detail: "用户通过特殊群体端开柜后完成领取，系统记录牛奶 1 件。",
    relatedEventId: "evt-001",
    relatedOrderNo: "ord-001",
    metadata: {
      quantity: 1,
      deviceCode: "CAB-1001",
      goodsId: "goods-1002",
      goodsName: "牛奶",
      undoState: "not_undoable"
    }
  },
  {
    id: "log-003",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-04-08T02:40:00.000Z",
    actor: {
      type: "system",
      name: "系统巡检"
    },
    primarySubject: {
      type: "alert",
      id: "task-001",
      label: "物资即将过期"
    },
    secondarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    description: "系统为扬名西点位创建了物资即将过期任务。",
    detail: "到期巡检命中三明治批次，已生成开放状态的临期任务。",
    metadata: {
      goodsId: "goods-1001",
      deviceCode: "CAB-1001",
      undoState: "not_undoable"
    }
  },
  {
    id: "log-004",
    category: "device",
    type: "remote-open-device",
    status: "pending",
    occurredAt: "2026-04-08T02:00:00.000Z",
    actor: {
      type: "admin",
      id: "admin-001",
      name: "街道管理员",
      role: "admin"
    },
    primarySubject: {
      type: "device",
      id: "CAB-1002",
      label: "扬名东点位"
    },
    secondarySubject: {
      type: "event",
      id: "evt-004",
      label: "ord-004"
    },
    description: "街道管理员向扬名东点位下发了远程开门指令。",
    detail: "设备 CAB-1002 已收到远程开门请求，等待门状态回调。",
    relatedEventId: "evt-004",
    relatedOrderNo: "ord-004",
    metadata: {
      deviceCode: "CAB-1002",
      undoState: "not_undoable"
    }
  },
  {
    id: "log-005",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-04-08T02:50:00.000Z",
    actor: {
      type: "system",
      name: "用户反馈"
    },
    primarySubject: {
      type: "alert",
      id: "task-003",
      label: "用户反馈柜门关闭缓慢"
    },
    secondarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    description: "系统记录了 CAB-1001 的用户反馈。",
    detail: "陈师傅反馈柜门关闭缓慢，已进入待处理任务池。",
    metadata: {
      deviceCode: "CAB-1001",
      targetUserId: "special-002",
      undoState: "not_undoable"
    }
  },
  {
    id: "log-006",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-04-08T02:01:30.000Z",
    actor: {
      type: "system",
      name: "系统巡检"
    },
    primarySubject: {
      type: "alert",
      id: "task-002",
      label: "柜机开门无响应"
    },
    secondarySubject: {
      type: "device",
      id: "CAB-1002",
      label: "扬名东点位"
    },
    description: "系统记录了 CAB-1002 的开门无响应异常。",
    detail: "远程开门超过 90 秒未得到成功反馈，已进入待处理任务池。",
    metadata: {
      deviceCode: "CAB-1002",
      undoState: "not_undoable"
    }
  }
];

export const cloneSeedState = () => ({
  users: structuredClone(seedUsers),
  rules: structuredClone(seedRules),
  devices: structuredClone(seedDevices),
  goodsCatalog: structuredClone(seedGoodsCatalog),
  goodsCategories: structuredClone(seedGoodsCategories),
  regions: structuredClone(seedRegions),
  warehouses: structuredClone(seedWarehouses),
  specialAccessPolicies: structuredClone(seedSpecialAccessPolicies),
  goodsAlertPolicies: structuredClone(seedGoodsAlertPolicies),
  registrationApplications: structuredClone(seedRegistrationApplications),
  merchantGoodsTemplates: structuredClone(seedMerchantGoodsTemplates),
  deviceGoodsSettings: structuredClone(seedDeviceGoodsSettings),
  goodsBatches: structuredClone(seedGoodsBatches),
  batchConsumptionTraces: structuredClone(seedBatchConsumptionTraces),
  inventoryTransfers: structuredClone(seedInventoryTransfers),
  stocktakes: structuredClone(seedStocktakes),
  events: structuredClone(seedEvents),
  inventory: structuredClone(seedInventory),
  alerts: structuredClone(seedAlerts),
  logs: structuredClone(seedOperationLogs)
});
