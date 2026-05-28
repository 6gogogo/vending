import type {
  AiAdminCustomQueryReply,
  AiEventDiagnosis,
  AiFeedbackDraft,
  AiOperationsReport,
  AiOperationsReportType,
  AiPolicyOptimizationSuggestion,
  AiProviderConfigPayload,
  AiProviderStatus,
  AiProviderTestResult,
  AiRestockLayoutSuggestion,
  AlertTask,
  BackofficePermission,
  BackofficeRole,
  BackofficeScope,
  CallbackLogRecord,
  DataMonitorRange,
  DataMonitorSnapshot,
  DashboardSnapshot,
  DeviceMonitoringDetail,
  DeviceRecord,
  GoodsAlertPolicy,
  GoodsCatalogItem,
  GoodsCategoryRecord,
  GoodsDetailSnapshot,
  GoodsOverviewSnapshot,
  InventoryMovement,
  MerchantGoodsTemplate,
  OperationLogCategory,
  OperationLogRecord,
  OperationLogStatus,
  PlatformOverviewSnapshot,
  PlatformTenantRecord,
  RegionRecord,
  RegistrationApplication,
  SystemAuditLogEntry,
  SystemSettingsSnapshot,
  SystemSettingsUpdatePayload,
  SystemSettingsUpdateResult,
  SpecialAccessPolicy,
  UserAccessPolicy,
  UserManagementDetail,
  UserRecord,
  WarehouseInventorySnapshot,
  WarehouseRecord
} from "@vm/shared-types";

import { adminClient } from "./client";
import { useAdminSessionStore } from "../stores/session";

interface AdminLoginResponse {
  token: string;
  user: {
    id: string;
    role: "admin" | "merchant";
    backofficeRole: BackofficeRole;
    scope: BackofficeScope;
    tenantId?: string;
    tenantName?: string;
    permissions: BackofficePermission[];
    name: string;
    phone: string;
    tags: string[];
  };
  auth: {
    username: string;
    usesDefaultPassword: boolean;
    passwordUpdatedAt: string;
  };
}

const requireBackofficePermission = (permission: BackofficePermission) => {
  const sessionStore = useAdminSessionStore();

  if (!sessionStore.can(permission)) {
    throw new Error("当前账号没有权限执行该操作。");
  }
};

const requireAnyBackofficePermission = (permissions: BackofficePermission[]) => {
  const sessionStore = useAdminSessionStore();

  if (!sessionStore.canAny(permissions)) {
    throw new Error("当前账号没有权限执行该操作。");
  }
};

export const adminApi = {
  requestCode(phone: string) {
    return adminClient.post<{
      phone: string;
      expiresInSeconds: number;
      provider: "mock" | "aliyun";
      previewCode?: string;
    }>(
      "/auth/request-code",
      { phone }
    );
  },
  adminLogin(phone: string, code: string) {
    return adminClient.post<AdminLoginResponse>("/auth/admin-login", { phone, code });
  },
  adminPasswordLogin(username: string, password: string) {
    return adminClient.post<AdminLoginResponse>("/auth/admin-password-login", { username, password });
  },
  backofficeLogin(username: string, password: string) {
    return adminClient.post<AdminLoginResponse>("/auth/backoffice-login", { username, password });
  },
  changeAdminPassword(payload: { currentPassword: string; newPassword: string }) {
    return adminClient.patch<AdminLoginResponse>("/auth/backoffice-password", payload);
  },
  session() {
    return adminClient.get<AdminLoginResponse>("/auth/backoffice-session");
  },
  createBackofficeCredential(payload: {
    userId: string;
    username: string;
    password: string;
    role?: BackofficeRole;
    tenantId?: string;
    permissions?: BackofficePermission[];
  }) {
    requireBackofficePermission("backoffice-credentials:manage");
    return adminClient.post("/auth/backoffice-credentials", payload);
  },
  dashboard() {
    requireBackofficePermission("dashboard:view");
    return adminClient.get<DashboardSnapshot>("/analytics/dashboard");
  },
  platformOverview() {
    requireBackofficePermission("platform-overview:view");
    return adminClient.get<PlatformOverviewSnapshot>("/platform/overview");
  },
  platformTenants() {
    requireBackofficePermission("platform-tenants:view");
    return adminClient.get<PlatformTenantRecord[]>("/platform/tenants");
  },
  dataMonitor(query?: { month?: string; date?: string; range?: DataMonitorRange }) {
    requireBackofficePermission("analytics:data-monitor:view");
    return adminClient.get<DataMonitorSnapshot>("/analytics/data-monitor", {
      query
    });
  },
  registrationApplications(status?: RegistrationApplication["status"]) {
    requireBackofficePermission("users:view");
    return adminClient.get<RegistrationApplication[]>("/registration-applications", {
      query: { status }
    });
  },
  reviewRegistration(id: string, payload: { decision: "approved" | "rejected"; reason?: string }) {
    requireBackofficePermission("users:view");
    return adminClient.patch<RegistrationApplication>(`/registration-applications/${id}/review`, payload);
  },
  users(role?: UserRecord["role"]) {
    requireBackofficePermission("users:view");
    return adminClient.get<UserRecord[]>("/users", {
      query: { role }
    });
  },
  regions() {
    requireBackofficePermission("users:view");
    return adminClient.get<RegionRecord[]>("/regions");
  },
  createRegion(payload: {
    name: string;
    sortOrder?: number;
    longitude?: number;
    latitude?: number;
  }) {
    requireBackofficePermission("users:view");
    return adminClient.post<RegionRecord>("/regions", payload);
  },
  updateRegion(
    id: string,
    payload: Partial<{
      name: string;
      status: "active" | "inactive";
      sortOrder: number;
      longitude: number;
      latitude: number;
    }>
  ) {
    requireBackofficePermission("users:view");
    return adminClient.patch<RegionRecord>(`/regions/${id}`, payload);
  },
  createUser(payload: {
    role: UserRecord["role"];
    phone: string;
    name: string;
    status?: "active" | "inactive";
    neighborhood?: string;
    regionId?: string;
    regionName?: string;
    tags?: string[];
  }) {
    requireBackofficePermission("users:view");
    return adminClient.post<UserRecord>("/users", payload);
  },
  updateUser(
    userId: string,
    payload: {
      role?: UserRecord["role"];
      phone?: string;
      name?: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
    }
  ) {
    requireBackofficePermission("users:view");
    return adminClient.patch<UserRecord>(`/users/${userId}`, payload);
  },
  removeUser(userId: string) {
    requireBackofficePermission("users:view");
    return adminClient.delete<{ id: string; name: string }>(`/users/${userId}`);
  },
  userDetail(userId: string, query?: { month?: string; date?: string }) {
    requireBackofficePermission("users:view");
    return adminClient.get<UserManagementDetail>(`/users/${userId}`, {
      query
    });
  },
  batchUpdateUsers(payload: {
    userIds: string[];
    patch: {
      status?: "active" | "inactive";
      tags?: string[];
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
    };
  }) {
    requireBackofficePermission("users:view");
    return adminClient.patch<{ count: number; updated: UserRecord[] }>("/users/batch", payload);
  },
  manualAdjustUser(
    userId: string,
    payload: {
      deviceCode: string;
      goodsId: string;
      relatedEventId?: string;
      relatedOrderNo?: string;
      goodsName?: string;
      category?: "food" | "drink" | "daily";
      quantity: number;
      unitPrice?: number;
      direction: "restock" | "deduct";
      note?: string;
      confirmed?: boolean;
      batchConsumptions?: Array<{
        batchId: string;
        quantity: number;
      }>;
    }
  ) {
    requireBackofficePermission("users:view");
    return adminClient.post(`/users/${userId}/manual-adjustment`, payload);
  },
  saveUserAccessPolicy(
    userId: string,
    payload: {
      id?: string;
      name: string;
      weekdays: number[];
      startHour: number;
      endHour: number;
      goodsLimits: Array<{
        goodsId: string;
        quantity: number;
      }>;
      status: UserAccessPolicy["status"];
      sourcePolicyId?: string;
    }
  ) {
    requireBackofficePermission("users:view");
    return adminClient.post<UserAccessPolicy>(`/users/${userId}/access-policies`, payload);
  },
  deleteUserAccessPolicy(userId: string, policyId: string) {
    requireBackofficePermission("users:view");
    return adminClient.delete<UserAccessPolicy>(`/users/${userId}/access-policies/${policyId}`);
  },
  applyUserAccessPolicyNow(userId: string, policyId: string) {
    requireBackofficePermission("users:view");
    return adminClient.post<UserAccessPolicy>(`/users/${userId}/access-policies/${policyId}/apply-now`);
  },
  policies() {
    requireBackofficePermission("users:view");
    return adminClient.get<SpecialAccessPolicy[]>("/special-access-policies");
  },
  createPolicy(payload: Omit<SpecialAccessPolicy, "id">) {
    requireBackofficePermission("users:view");
    return adminClient.post<SpecialAccessPolicy>("/special-access-policies", payload);
  },
  updatePolicy(id: string, payload: Partial<Omit<SpecialAccessPolicy, "id">>) {
    requireBackofficePermission("users:view");
    return adminClient.patch<SpecialAccessPolicy>(`/special-access-policies/${id}`, payload);
  },
  batchAssignPolicies(payload: {
    userIds: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    requireBackofficePermission("users:view");
    return adminClient.post<SpecialAccessPolicy[]>("/special-access-policies/batch-assign", payload);
  },
  resolveAlert(id: string, note?: string) {
    return adminClient.patch(`/alerts/${id}/resolve`, { note });
  },
  devices() {
    requireAnyBackofficePermission(["devices:view", "goods:view", "users:view", "warehouse:view"]);
    return adminClient.get<DeviceRecord[]>("/devices");
  },
  upsertDevice(payload: {
    deviceCode: string;
    name: string;
    location: string;
    address?: string;
    longitude?: number;
    latitude?: number;
    doorNum?: string;
    doorLabel?: string;
  }) {
    requireBackofficePermission("devices:view");
    return adminClient.post<DeviceRecord>("/devices", payload);
  },
  removeDevice(deviceCode: string) {
    requireBackofficePermission("devices:view");
    return adminClient.delete<{ deviceCode: string; name: string }>(`/devices/${deviceCode}`);
  },
  async uploadImage(file: File) {
    const sessionStore = useAdminSessionStore();
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/uploads/images`,
      {
        method: "POST",
        headers: sessionStore.token
          ? {
              Authorization: `Bearer ${sessionStore.token}`
            }
          : undefined,
        body: formData
      }
    );

    const parsed = (await response.json()) as {
      code: number;
      message: string;
      data?: { url: string; filename: string; relativePath: string };
    };

    if (!response.ok || parsed.code !== 200 || !parsed.data) {
      throw new Error(parsed.message || "上传失败");
    }

    return parsed.data;
  },
  deviceDetail(deviceCode: string) {
    requireAnyBackofficePermission(["devices:view", "warehouse:view"]);
    return adminClient.get<DeviceMonitoringDetail>(`/devices/${deviceCode}/monitoring`);
  },
  deviceCallbackLogs(deviceCode: string, limit = 20) {
    requireBackofficePermission("system-audit:view");
    return adminClient.get<CallbackLogRecord[]>("/cabinet-events/callback-logs", {
      query: { deviceCode, limit }
    });
  },
  systemAuditLogs(filters?: { pathContains?: string; deviceCode?: string; limit?: number }) {
    requireBackofficePermission("system-audit:view");
    return adminClient.get<SystemAuditLogEntry[]>("/operation-logs/system-audit", {
      query: filters
    });
  },
  addDeviceGoods(deviceCode: string, payload: { goodsId: string; doorNum?: string }) {
    requireBackofficePermission("devices:view");
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/goods`, payload);
  },
  removeDeviceGoods(deviceCode: string, goodsId: string, doorNum?: string) {
    requireBackofficePermission("devices:view");
    return adminClient.delete<DeviceMonitoringDetail>(`/devices/${deviceCode}/goods/${goodsId}`, {
      query: { doorNum }
    });
  },
  updateDeviceLocation(
    deviceCode: string,
    payload: {
      location?: string;
      address?: string;
      longitude?: number;
      latitude?: number;
    }
  ) {
    requireBackofficePermission("devices:view");
    return adminClient.patch<DeviceRecord>(`/devices/${deviceCode}/location`, payload);
  },
  refreshDevice(deviceCode: string) {
    requireBackofficePermission("devices:view");
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/refresh`);
  },
  remoteOpenDevice(deviceCode: string, doorNum = "1") {
    requireBackofficePermission("devices:view");
    return adminClient.post<{ eventId: string; orderNo: string; deviceCode: string; doorNum: string }>(
      `/devices/${deviceCode}/remote-open`,
      { doorNum }
    );
  },
  notifyPaymentSuccess(payload: {
    orderNo: string;
    eventId: string;
    transactionId: string;
    deviceCode: string;
    amount: number;
    openId?: string;
    targetUrl?: string;
    notifyUrl?: string;
    noticeUrl?: string;
  }) {
    return adminClient.post("/cabinet-events/payment-success", payload);
  },
  refundOrder(payload: {
    orderNo: string;
    transactionId: string;
    deviceCode: string;
    refundNo: string;
    amount: number;
  }) {
    return adminClient.post("/inventory-orders/refund", payload);
  },
  goodsOverview() {
    requireBackofficePermission("goods:view");
    return adminClient.get<GoodsOverviewSnapshot>("/goods-overview");
  },
  async exportGoodsOverview(token: string) {
    requireBackofficePermission("goods:view");
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/goods-overview/export/file`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      throw new Error("导出失败");
    }

    return {
      blob: await response.blob(),
      filename:
        response.headers.get("content-disposition")?.match(/filename=\"?([^\";]+)\"?/)?.[1] ??
        "goods-overview.xls"
    };
  },
  goodsCatalog() {
    requireAnyBackofficePermission(["goods:view", "devices:view", "users:view"]);
    return adminClient.get<GoodsCatalogItem[]>("/goods-catalog");
  },
  goodsCategories() {
    requireAnyBackofficePermission(["goods:view", "merchant-workbench:view"]);
    return adminClient.get<GoodsCategoryRecord[]>("/goods-categories");
  },
  createGoodsCategory(payload: {
    name: string;
    category: "food" | "drink" | "daily";
    sortOrder?: number;
  }) {
    requireBackofficePermission("goods:view");
    return adminClient.post<GoodsCategoryRecord>("/goods-categories", payload);
  },
  updateGoodsCategory(
    id: string,
    payload: Partial<{
      name: string;
      category: "food" | "drink" | "daily";
      status: "active" | "inactive";
      sortOrder: number;
    }>
  ) {
    requireBackofficePermission("goods:view");
    return adminClient.patch<GoodsCategoryRecord>(`/goods-categories/${id}`, payload);
  },
  goodsDetail(goodsId: string) {
    requireBackofficePermission("goods:view");
    return adminClient.get<GoodsDetailSnapshot>(`/goods/${goodsId}`);
  },
  createGoods(payload: {
    goodsCode: string;
    goodsId?: string;
    name: string;
    fullName?: string;
    category: "food" | "drink" | "daily";
    categoryName?: string;
    price: number;
    imageUrl: string;
    packageForm?: string;
    specification?: string;
    manufacturer?: string;
  }) {
    requireBackofficePermission("goods:view");
    return adminClient.post<GoodsCatalogItem>("/goods", payload);
  },
  updateGoods(
    goodsId: string,
    payload: Partial<{
      goodsCode: string;
      name: string;
      fullName: string;
      category: "food" | "drink" | "daily";
      categoryName: string;
      price: number;
      imageUrl: string;
      packageForm: string;
      specification: string;
      manufacturer: string;
      status: "active" | "inactive";
    }>
  ) {
    requireBackofficePermission("goods:view");
    return adminClient.patch<GoodsCatalogItem>(`/goods/${goodsId}`, payload);
  },
  addGoodsBatch(
    goodsId: string,
    payload: {
      deviceCode: string;
      quantity: number;
      expiresAt?: string;
      sourceType?: "admin" | "merchant" | "system";
      sourceUserId?: string;
      sourceUserName?: string;
      note?: string;
      confirmed?: boolean;
    }
  ) {
    requireBackofficePermission("goods:view");
    return adminClient.post(`/goods/${goodsId}/batches`, payload);
  },
  removeGoodsBatch(batchId: string, payload: { quantity: number; note?: string; confirmed?: boolean }) {
    requireBackofficePermission("goods:view");
    return adminClient.post(`/goods/batches/${batchId}/remove`, payload);
  },
  goodsAlertPolicies() {
    requireBackofficePermission("goods:view");
    return adminClient.get<GoodsAlertPolicy[]>("/goods-alert-policies");
  },
  createGoodsAlertPolicy(payload: Omit<GoodsAlertPolicy, "id">) {
    requireBackofficePermission("goods:view");
    return adminClient.post<GoodsAlertPolicy>("/goods-alert-policies", payload);
  },
  updateGoodsAlertPolicy(id: string, payload: Partial<Omit<GoodsAlertPolicy, "id">>) {
    requireBackofficePermission("goods:view");
    return adminClient.patch<GoodsAlertPolicy>(`/goods-alert-policies/${id}`, payload);
  },
  batchAssignGoodsAlertPolicies(payload: {
    deviceCodes: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    requireBackofficePermission("goods:view");
    return adminClient.post<GoodsAlertPolicy[]>("/goods-alert-policies/batch-assign", payload);
  },
  syncDeviceGoods(deviceCode: string, doorNum = "1") {
    requireBackofficePermission("goods:view");
    return adminClient.post(`/devices/${deviceCode}/sync-goods`, undefined, {
      query: { doorNum }
    });
  },
  updateDeviceGoodsThreshold(
    deviceCode: string,
    goodsId: string,
    payload: {
      enabled: boolean;
      lowStockThreshold?: number;
    }
  ) {
    requireBackofficePermission("goods:view");
    return adminClient.patch(`/devices/${deviceCode}/goods/${goodsId}/threshold`, payload);
  },
  alerts() {
    return adminClient.get<AlertTask[]>("/alerts");
  },
  merchantTemplates() {
    requireBackofficePermission("merchant-workbench:view");
    return adminClient.get<MerchantGoodsTemplate[]>("/merchant-goods-templates");
  },
  merchantRestockTraces() {
    requireBackofficePermission("merchant-workbench:view");
    return adminClient.get<{
      batches: Array<{
        batchId: string;
        goodsId: string;
        goodsName: string;
        deviceCode: string;
        deviceName: string;
        quantity: number;
        remainingQuantity: number;
        expiresAt?: string;
        createdAt: string;
      }>;
      records: InventoryMovement[];
      logs: OperationLogRecord[];
      dailySummary: Array<{
        dateKey: string;
        claimedUnits: number;
        helpedUsers: number;
        helpTimes: number;
        cumulativeHelpTimes: number;
      }>;
      cumulativeHelpTimes: number;
    }>("/merchant-restock-traces");
  },
  aiStatus() {
    return adminClient.get<AiProviderStatus>("/ai-insights/status");
  },
  saveAiConfig(payload: AiProviderConfigPayload) {
    requireBackofficePermission("ai-insights:manage");
    return adminClient.patch<AiProviderStatus>("/ai-insights/config", payload);
  },
  testAiConfig() {
    requireBackofficePermission("ai-insights:manage");
    return adminClient.post<AiProviderTestResult>("/ai-insights/test", {});
  },
  systemSettings() {
    requireBackofficePermission("system-settings:view");
    return adminClient.get<SystemSettingsSnapshot>("/system-settings");
  },
  saveSystemSettings(payload: SystemSettingsUpdatePayload) {
    requireBackofficePermission("system-settings:update");
    return adminClient.patch<SystemSettingsUpdateResult>("/system-settings", payload);
  },
  aiEventDiagnosis(payload: { eventId?: string; orderNo?: string; logId?: string }) {
    requireBackofficePermission("ai-insights:view");
    return adminClient.post<AiEventDiagnosis>("/ai-insights/event-diagnosis", payload);
  },
  aiOperationsReport(query?: { dateKey?: string; reportType?: AiOperationsReportType }) {
    requireBackofficePermission("ai-insights:view");
    return adminClient.get<AiOperationsReport>("/ai-insights/operations-report", {
      query
    });
  },
  aiRestockLayoutSuggestions(query?: { dateKey?: string; range?: DataMonitorRange }) {
    requireBackofficePermission("ai-insights:view");
    return adminClient.get<AiRestockLayoutSuggestion>("/ai-insights/restock-layout-suggestions", {
      query
    });
  },
  aiFeedbackDraft(payload: { alertId: string }) {
    requireBackofficePermission("ai-insights:view");
    return adminClient.post<AiFeedbackDraft>("/ai-insights/feedback-draft", payload);
  },
  aiPolicyOptimization(query?: { dateKey?: string; range?: DataMonitorRange }) {
    requireBackofficePermission("ai-insights:view");
    return adminClient.get<AiPolicyOptimizationSuggestion>("/ai-insights/policy-optimization", {
      query
    });
  },
  aiAdminCustomQuery(payload: {
    question: string;
    dateKey?: string;
    range?: DataMonitorRange;
    history?: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
  }) {
    requireBackofficePermission("ai-insights:view");
    return adminClient.post<AiAdminCustomQueryReply>("/ai-insights/admin-custom-query", payload);
  },
  warehouses() {
    requireAnyBackofficePermission(["warehouse:view", "goods:view"]);
    return adminClient.get<WarehouseRecord[]>("/warehouses");
  },
  warehouseInventory() {
    requireAnyBackofficePermission(["warehouse:view", "goods:view"]);
    return adminClient.get<WarehouseInventorySnapshot>("/warehouse-inventory");
  },
  createInventoryTransfer(payload: {
    fromCode: string;
    toCode: string;
    goodsId: string;
    quantity: number;
    sourceBatchId?: string;
    note?: string;
  }) {
    requireAnyBackofficePermission(["warehouse:view", "goods:view"]);
    return adminClient.post("/inventory-transfers", payload);
  },
  createStocktake(payload: {
    deviceCode: string;
    note?: string;
    items: Array<{
      goodsId: string;
      actualQuantity: number;
    }>;
  }) {
    requireBackofficePermission("warehouse:view");
    return adminClient.post("/stocktakes", payload);
  },
  async exportStocktake(id: string, token: string) {
    requireBackofficePermission("warehouse:view");
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/stocktakes/${id}/export`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      throw new Error("导出失败");
    }

    return {
      blob: await response.blob(),
      filename:
        response.headers.get("content-disposition")?.match(/filename=\"?([^\";]+)\"?/)?.[1] ??
        `stocktake-${id}.xls`
    };
  },
  logs(filters?: {
    category?: OperationLogCategory;
    status?: OperationLogStatus;
    subjectType?: "user" | "device" | "event" | "alert" | "goods" | "warehouse" | "stocktake";
    subjectId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    requireBackofficePermission("operation-logs:view");
    return adminClient.get<OperationLogRecord[]>("/operation-logs", {
      query: filters
    });
  },
  logDetail(id: string) {
    requireBackofficePermission("operation-logs:view");
    return adminClient.get<OperationLogRecord>(`/operation-logs/${id}`);
  },
  async exportLogs(
    token: string,
    filters?: {
      category?: OperationLogCategory;
      status?: OperationLogStatus;
      subjectType?: "user" | "device" | "event" | "alert" | "goods" | "warehouse" | "stocktake";
      subjectId?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    requireBackofficePermission("operation-logs:export");
    const query = new URLSearchParams();

    if (filters?.category) {
      query.set("category", filters.category);
    }

    if (filters?.status) {
      query.set("status", filters.status);
    }

    if (filters?.subjectType) {
      query.set("subjectType", filters.subjectType);
    }

    if (filters?.subjectId) {
      query.set("subjectId", filters.subjectId);
    }

    if (filters?.dateFrom) {
      query.set("dateFrom", filters.dateFrom);
    }

    if (filters?.dateTo) {
      query.set("dateTo", filters.dateTo);
    }

    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/operation-logs/export/file${query.size ? `?${query.toString()}` : ""}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      throw new Error("导出失败");
    }

    return {
      blob: await response.blob(),
      filename:
        response.headers.get("content-disposition")?.match(/filename=\"?([^\";]+)\"?/)?.[1] ??
        "operation-logs.xls"
    };
  },
  async exportSystemAuditLog(token: string) {
    requireBackofficePermission("system-audit:export");
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/operation-logs/export/system-file`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      throw new Error("导出失败");
    }

    return {
      blob: await response.blob(),
      filename:
        response.headers.get("content-disposition")?.match(/filename=\"?([^\";]+)\"?/)?.[1] ??
        "system-audit.ndjson"
    };
  },
  undoLog(id: string) {
    requireBackofficePermission("operation-logs:view");
    return adminClient.post<OperationLogRecord>(`/operation-logs/${id}/undo`);
  }
};
