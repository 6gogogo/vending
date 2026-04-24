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
  OperationLogCategory,
  OperationLogRecord,
  OperationLogStatus,
  RegionRecord,
  RegistrationApplication,
  SystemAuditLogEntry,
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
    role: "admin";
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
  changeAdminPassword(payload: { currentPassword: string; newPassword: string }) {
    return adminClient.patch<AdminLoginResponse>("/auth/admin-password", payload);
  },
  session() {
    return adminClient.get<AdminLoginResponse>("/auth/session");
  },
  dashboard() {
    return adminClient.get<DashboardSnapshot>("/analytics/dashboard");
  },
  dataMonitor(query?: { month?: string; date?: string; range?: DataMonitorRange }) {
    return adminClient.get<DataMonitorSnapshot>("/analytics/data-monitor", {
      query
    });
  },
  registrationApplications(status?: RegistrationApplication["status"]) {
    return adminClient.get<RegistrationApplication[]>("/registration-applications", {
      query: { status }
    });
  },
  reviewRegistration(id: string, payload: { decision: "approved" | "rejected"; reason?: string }) {
    return adminClient.patch<RegistrationApplication>(`/registration-applications/${id}/review`, payload);
  },
  users(role?: UserRecord["role"]) {
    return adminClient.get<UserRecord[]>("/users", {
      query: { role }
    });
  },
  regions() {
    return adminClient.get<RegionRecord[]>("/regions");
  },
  createRegion(payload: {
    name: string;
    sortOrder?: number;
    longitude?: number;
    latitude?: number;
  }) {
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
    return adminClient.patch<UserRecord>(`/users/${userId}`, payload);
  },
  removeUser(userId: string) {
    return adminClient.delete<{ id: string; name: string }>(`/users/${userId}`);
  },
  userDetail(userId: string, query?: { month?: string; date?: string }) {
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
    }
  ) {
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
    return adminClient.post<UserAccessPolicy>(`/users/${userId}/access-policies`, payload);
  },
  deleteUserAccessPolicy(userId: string, policyId: string) {
    return adminClient.delete<UserAccessPolicy>(`/users/${userId}/access-policies/${policyId}`);
  },
  applyUserAccessPolicyNow(userId: string, policyId: string) {
    return adminClient.post<UserAccessPolicy>(`/users/${userId}/access-policies/${policyId}/apply-now`);
  },
  policies() {
    return adminClient.get<SpecialAccessPolicy[]>("/special-access-policies");
  },
  createPolicy(payload: Omit<SpecialAccessPolicy, "id">) {
    return adminClient.post<SpecialAccessPolicy>("/special-access-policies", payload);
  },
  updatePolicy(id: string, payload: Partial<Omit<SpecialAccessPolicy, "id">>) {
    return adminClient.patch<SpecialAccessPolicy>(`/special-access-policies/${id}`, payload);
  },
  batchAssignPolicies(payload: {
    userIds: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    return adminClient.post<SpecialAccessPolicy[]>("/special-access-policies/batch-assign", payload);
  },
  resolveAlert(id: string, note?: string) {
    return adminClient.patch(`/alerts/${id}/resolve`, { note });
  },
  devices() {
    return adminClient.get<DeviceRecord[]>("/devices");
  },
  upsertDevice(payload: {
    deviceCode: string;
    name: string;
    location: string;
    address?: string;
    longitude?: number;
    latitude?: number;
    status?: DeviceRecord["status"];
    doorNum?: string;
    doorLabel?: string;
  }) {
    return adminClient.post<DeviceRecord>("/devices", payload);
  },
  removeDevice(deviceCode: string) {
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
    return adminClient.get<DeviceMonitoringDetail>(`/devices/${deviceCode}/monitoring`);
  },
  deviceCallbackLogs(deviceCode: string, limit = 20) {
    return adminClient.get<CallbackLogRecord[]>("/cabinet-events/callback-logs", {
      query: { deviceCode, limit }
    });
  },
  systemAuditLogs(filters?: { pathContains?: string; deviceCode?: string; limit?: number }) {
    return adminClient.get<SystemAuditLogEntry[]>("/operation-logs/system-audit", {
      query: filters
    });
  },
  addDeviceGoods(deviceCode: string, payload: { goodsId: string; doorNum?: string }) {
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/goods`, payload);
  },
  removeDeviceGoods(deviceCode: string, goodsId: string, doorNum?: string) {
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
    return adminClient.patch<DeviceRecord>(`/devices/${deviceCode}/location`, payload);
  },
  refreshDevice(deviceCode: string) {
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/refresh`);
  },
  remoteOpenDevice(deviceCode: string, doorNum = "1") {
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
    return adminClient.get<GoodsOverviewSnapshot>("/goods-overview");
  },
  async exportGoodsOverview(token: string) {
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
    return adminClient.get<GoodsCatalogItem[]>("/goods-catalog");
  },
  goodsCategories() {
    return adminClient.get<GoodsCategoryRecord[]>("/goods-categories");
  },
  createGoodsCategory(payload: {
    name: string;
    category: "food" | "drink" | "daily";
    sortOrder?: number;
  }) {
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
    return adminClient.patch<GoodsCategoryRecord>(`/goods-categories/${id}`, payload);
  },
  goodsDetail(goodsId: string) {
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
    }
  ) {
    return adminClient.post(`/goods/${goodsId}/batches`, payload);
  },
  removeGoodsBatch(batchId: string, payload: { quantity: number; note?: string }) {
    return adminClient.post(`/goods/batches/${batchId}/remove`, payload);
  },
  goodsAlertPolicies() {
    return adminClient.get<GoodsAlertPolicy[]>("/goods-alert-policies");
  },
  createGoodsAlertPolicy(payload: Omit<GoodsAlertPolicy, "id">) {
    return adminClient.post<GoodsAlertPolicy>("/goods-alert-policies", payload);
  },
  updateGoodsAlertPolicy(id: string, payload: Partial<Omit<GoodsAlertPolicy, "id">>) {
    return adminClient.patch<GoodsAlertPolicy>(`/goods-alert-policies/${id}`, payload);
  },
  batchAssignGoodsAlertPolicies(payload: {
    deviceCodes: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    return adminClient.post<GoodsAlertPolicy[]>("/goods-alert-policies/batch-assign", payload);
  },
  syncDeviceGoods(deviceCode: string, doorNum = "1") {
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
    return adminClient.patch(`/devices/${deviceCode}/goods/${goodsId}/threshold`, payload);
  },
  alerts() {
    return adminClient.get<AlertTask[]>("/alerts");
  },
  aiStatus() {
    return adminClient.get<AiProviderStatus>("/ai-insights/status");
  },
  saveAiConfig(payload: AiProviderConfigPayload) {
    return adminClient.patch<AiProviderStatus>("/ai-insights/config", payload);
  },
  testAiConfig() {
    return adminClient.post<AiProviderTestResult>("/ai-insights/test", {});
  },
  aiEventDiagnosis(payload: { eventId?: string; orderNo?: string; logId?: string }) {
    return adminClient.post<AiEventDiagnosis>("/ai-insights/event-diagnosis", payload);
  },
  aiOperationsReport(query?: { dateKey?: string; reportType?: AiOperationsReportType }) {
    return adminClient.get<AiOperationsReport>("/ai-insights/operations-report", {
      query
    });
  },
  aiRestockLayoutSuggestions(query?: { dateKey?: string; range?: DataMonitorRange }) {
    return adminClient.get<AiRestockLayoutSuggestion>("/ai-insights/restock-layout-suggestions", {
      query
    });
  },
  aiFeedbackDraft(payload: { alertId: string }) {
    return adminClient.post<AiFeedbackDraft>("/ai-insights/feedback-draft", payload);
  },
  aiPolicyOptimization(query?: { dateKey?: string; range?: DataMonitorRange }) {
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
    return adminClient.post<AiAdminCustomQueryReply>("/ai-insights/admin-custom-query", payload);
  },
  warehouses() {
    return adminClient.get<WarehouseRecord[]>("/warehouses");
  },
  warehouseInventory() {
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
    return adminClient.post("/stocktakes", payload);
  },
  async exportStocktake(id: string, token: string) {
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
    return adminClient.get<OperationLogRecord[]>("/operation-logs", {
      query: filters
    });
  },
  logDetail(id: string) {
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
    return adminClient.post<OperationLogRecord>(`/operation-logs/${id}/undo`);
  }
};
