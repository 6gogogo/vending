import type {
  AccessQuota,
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
  BackofficeCredentialSnapshot,
  BackofficePermission,
  BackofficeRole,
  BackofficeSessionSnapshot,
  CallbackLogRecord,
  CabinetReservationRecord,
  DataMonitorRange,
  DataMonitorSnapshot,
  DashboardSnapshot,
  DeviceMonitoringDetail,
  DeviceRecord,
  ExpiredBatchDispositionMethod,
  ExpiredBatchDispositionRecord,
  GoodsAlertPolicy,
  GoodsCatalogItem,
  GoodsCategoryRecord,
  GoodsDetailSnapshot,
  GoodsOverviewSnapshot,
  InventoryMovement,
  InstanceRuntimeControlStatus,
  InstanceRuntimeRestartPayload,
  InstanceRuntimeRestartResult,
  MerchantGoodsTemplate,
  ManualSettlementCandidate,
  ManualSettlementConflictResolutionPayload,
  ManualSettlementCreatePayload,
  ManualSettlementOrderLinkPayload,
  ManualSettlementRecord,
  ManualSettlementRevertPayload,
  ManualVerificationGrantSnapshot,
  ManualVerificationPurpose,
  OperationLogCategory,
  OperationLogRecord,
  OperationLogStatus,
  PaymentDiagnosticsResult,
  PaymentRefundRecord,
  PlatformOverviewSnapshot,
  PlatformTenantCreatePayload,
  PlatformTenantProvisioningResult,
  PlatformTenantRecord,
  PlatformTenantUpdatePayload,
  PublicRuntimeConfig,
  RegionRecord,
  RegistrationApplication,
  ReservationSettings,
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

import { adminApiBaseUrl, adminClient } from "./client";
import { useAdminSessionStore } from "../stores/session";

type AdminLoginResponse = BackofficeSessionSnapshot;

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
      provider: "mock" | "aliyun_pnvs" | "manual";
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
  publicRuntimeConfig() {
    return adminClient.get<PublicRuntimeConfig>("/public-config");
  },
  requestBackofficePasswordResetCode(username: string, phone: string) {
    return adminClient.post<{
      phone: string;
      expiresInSeconds: number;
      provider: "mock" | "aliyun_pnvs" | "manual";
      previewCode?: string;
    }>("/auth/request-code", {
      username,
      phone,
      scene: "password-reset"
    });
  },
  resetOwnBackofficePassword(payload: {
    username: string;
    phone: string;
    code: string;
    newPassword: string;
  }) {
    return adminClient.post<{ reset: boolean }>("/auth/backoffice-password-reset", payload);
  },
  changeAdminPassword(payload: { currentPassword: string; newPassword: string }) {
    return adminClient.patch<AdminLoginResponse>("/auth/backoffice-password", payload);
  },
  session() {
    return adminClient.get<AdminLoginResponse>("/auth/backoffice-session");
  },
  logout() {
    return adminClient.post<{ revoked: boolean }>("/auth/logout");
  },
  createBackofficeCredential(payload: {
    userId: string;
    username: string;
    password?: string;
    role?: BackofficeRole;
    tenantId?: string;
    permissions?: BackofficePermission[];
  }) {
    requireBackofficePermission("backoffice-credentials:manage");
    return adminClient.post<BackofficeCredentialSnapshot>("/auth/backoffice-credentials", payload);
  },
  backofficeCredentials() {
    requireBackofficePermission("backoffice-credentials:manage");
    return adminClient.get<BackofficeCredentialSnapshot[]>("/auth/backoffice-credentials");
  },
  resetBackofficePasswordAsProvider(payload: {
    userId: string;
    role: BackofficeRole;
    newPassword: string;
    reason: string;
  }) {
    requireBackofficePermission("backoffice-credentials:manage");
    return adminClient.post<BackofficeCredentialSnapshot>(
      "/auth/backoffice-password-reset-as-super-admin",
      payload
    );
  },
  issueManualVerificationCode(payload: {
    userId: string;
    purpose: ManualVerificationPurpose;
    code: string;
    expiresInSeconds?: number;
  }) {
    requireBackofficePermission("verification-codes:manage");
    return adminClient.post<ManualVerificationGrantSnapshot>(
      "/auth/manual-verification-codes",
      payload
    );
  },
  manualVerificationCodes() {
    requireBackofficePermission("verification-codes:manage");
    return adminClient.get<ManualVerificationGrantSnapshot[]>(
      "/auth/manual-verification-codes"
    );
  },
  revokeManualVerificationCode(grantId: string, reason: string) {
    requireBackofficePermission("verification-codes:manage");
    return adminClient.post<ManualVerificationGrantSnapshot>(
      `/auth/manual-verification-codes/${encodeURIComponent(grantId)}/revoke`,
      { reason }
    );
  },
  clearManualVerificationCode(grantId: string) {
    requireBackofficePermission("verification-codes:manage");
    return adminClient.delete<ManualVerificationGrantSnapshot>(
      `/auth/manual-verification-codes/${encodeURIComponent(grantId)}`
    );
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
  createPlatformTenant(payload: PlatformTenantCreatePayload) {
    requireBackofficePermission("platform-tenants:manage");
    return adminClient.post<PlatformTenantProvisioningResult>("/platform/tenants", payload);
  },
  updatePlatformTenant(tenantId: string, payload: PlatformTenantUpdatePayload) {
    requireBackofficePermission("platform-tenants:manage");
    return adminClient.patch<PlatformTenantRecord>(
      `/platform/tenants/${encodeURIComponent(tenantId)}`,
      payload
    );
  },
  enterPlatformTenant(tenantId: string) {
    requireBackofficePermission("platform-tenants:view");
    return adminClient.post<BackofficeSessionSnapshot>(
      `/platform/tenants/${encodeURIComponent(tenantId)}/enter`
    );
  },
  exitPlatformTenant() {
    return adminClient.post<BackofficeSessionSnapshot>("/platform/exit-instance");
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
    requireBackofficePermission("users:review");
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
    requireBackofficePermission("users:manage");
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
    requireBackofficePermission("users:manage");
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
    requireBackofficePermission("users:manage");
    return adminClient.post<UserRecord>("/users", payload);
  },
  importUsers(payload: {
    role: Extract<UserRecord["role"], "special" | "merchant">;
    entries: Array<{
      phone: string;
      name: string;
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
      quota?: AccessQuota;
    }>;
  }) {
    requireBackofficePermission("users:manage");
    return adminClient.post<{ count: number; imported: UserRecord[] }>("/users/import", payload);
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
    requireBackofficePermission("users:manage");
    return adminClient.patch<UserRecord>(`/users/${userId}`, payload);
  },
  removeUser(userId: string) {
    requireBackofficePermission("users:manage");
    return adminClient.delete<{ id: string; name: string }>(`/users/${userId}`);
  },
  batchRemoveUsers(payload: { userIds: string[]; confirmedCount: number }) {
    requireBackofficePermission("users:manage");
    return adminClient.post<{ count: number; removed: Array<{ id: string; name: string }> }>(
      "/users/batch-remove",
      payload
    );
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
    requireBackofficePermission("users:manage");
    return adminClient.patch<{ count: number; updated: UserRecord[] }>("/users/batch", payload);
  },
  assignUserDevices(userId: string, deviceCodes: string[]) {
    requireBackofficePermission("users:manage");
    return adminClient.patch<UserRecord>(
      `/users/${encodeURIComponent(userId)}/device-assignment`,
      { deviceCodes }
    );
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
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post(`/users/${userId}/manual-adjustment`, payload);
  },
  manualSettlementCandidates(userId?: string) {
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.get<ManualSettlementCandidate[]>(
      "/cabinet-events/manual-settlement-candidates",
      { query: { userId } }
    );
  },
  createManualSettlement(eventId: string, payload: ManualSettlementCreatePayload) {
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post<ManualSettlementRecord>(
      `/cabinet-events/event/${encodeURIComponent(eventId)}/manual-settlement`,
      payload
    );
  },
  linkManualSettlementOrder(eventId: string, payload: ManualSettlementOrderLinkPayload) {
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post<ManualSettlementRecord>(
      `/cabinet-events/event/${encodeURIComponent(eventId)}/manual-settlement/order-link`,
      payload
    );
  },
  completeManualSettlementPlatform(eventId: string) {
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post<{
      manualSettlement: ManualSettlementRecord;
      platformCompletion: unknown;
    }>(
      `/cabinet-events/event/${encodeURIComponent(eventId)}/manual-settlement/platform-completion`
    );
  },
  revertManualSettlement(eventId: string, payload: ManualSettlementRevertPayload) {
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post<ManualSettlementRecord>(
      `/cabinet-events/event/${encodeURIComponent(eventId)}/manual-settlement/revert`,
      payload
    );
  },
  resolveManualSettlementConflict(
    eventId: string,
    payload: ManualSettlementConflictResolutionPayload
  ) {
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post<ManualSettlementRecord>(
      `/cabinet-events/event/${encodeURIComponent(eventId)}/manual-settlement/conflict-resolution`,
      payload
    );
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
    requireBackofficePermission("users:rules:manage");
    return adminClient.post<UserAccessPolicy>(`/users/${userId}/access-policies`, payload);
  },
  deleteUserAccessPolicy(userId: string, policyId: string) {
    requireBackofficePermission("users:rules:manage");
    return adminClient.delete<UserAccessPolicy>(`/users/${userId}/access-policies/${policyId}`);
  },
  applyUserAccessPolicyNow(userId: string, policyId: string) {
    requireBackofficePermission("users:rules:manage");
    return adminClient.post<UserAccessPolicy>(`/users/${userId}/access-policies/${policyId}/apply-now`);
  },
  policies() {
    requireBackofficePermission("users:view");
    return adminClient.get<SpecialAccessPolicy[]>("/special-access-policies");
  },
  createPolicy(payload: Omit<SpecialAccessPolicy, "id">) {
    requireBackofficePermission("users:rules:manage");
    return adminClient.post<SpecialAccessPolicy>("/special-access-policies", payload);
  },
  updatePolicy(id: string, payload: Partial<Omit<SpecialAccessPolicy, "id">>) {
    requireBackofficePermission("users:rules:manage");
    return adminClient.patch<SpecialAccessPolicy>(`/special-access-policies/${id}`, payload);
  },
  batchAssignPolicies(payload: {
    userIds: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    requireBackofficePermission("users:rules:manage");
    return adminClient.post<SpecialAccessPolicy[]>("/special-access-policies/batch-assign", payload);
  },
  reservationSettings() {
    requireBackofficePermission("users:view");
    return adminClient.get<ReservationSettings>("/reservations/settings");
  },
  saveReservationSettings(payload: Partial<Pick<ReservationSettings, "enabled" | "holdMinutes" | "maxTimeouts">>) {
    requireBackofficePermission("reservations:manage");
    return adminClient.patch<ReservationSettings>("/reservations/settings", payload);
  },
  reservations(userId: string) {
    requireBackofficePermission("users:view");
    return adminClient.get<CabinetReservationRecord[]>(
      `/reservations?userId=${encodeURIComponent(userId)}`
    );
  },
  cancelReservation(id: string, reason: string) {
    requireBackofficePermission("reservations:manage");
    return adminClient.post<CabinetReservationRecord>(
      `/reservations/${encodeURIComponent(id)}/cancel`,
      { reason }
    );
  },
  resolveAlert(id: string, note?: string) {
    requireBackofficePermission("alerts:manage");
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
    requireBackofficePermission("devices:manage");
    return adminClient.post<DeviceRecord>("/devices", payload);
  },
  removeDevice(deviceCode: string) {
    requireBackofficePermission("devices:manage");
    return adminClient.delete<{ deviceCode: string; name: string }>(`/devices/${deviceCode}`);
  },
  async uploadImage(file: File) {
    requireBackofficePermission("uploads:images");
    const sessionStore = useAdminSessionStore();
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(
      `${adminApiBaseUrl}/uploads/images`,
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
  assignedDeviceDetail(deviceCode: string) {
    requireBackofficePermission("devices:view");
    return adminClient.get<DeviceRecord>(`/devices/${deviceCode}`);
  },
  deviceCallbackLogs(deviceCode: string, limit = 20) {
    requireBackofficePermission("operation-logs:view");
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
    requireBackofficePermission("devices:manage");
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/goods`, payload);
  },
  removeDeviceGoods(deviceCode: string, goodsId: string, doorNum?: string) {
    requireBackofficePermission("devices:manage");
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
    requireBackofficePermission("devices:manage");
    return adminClient.patch<DeviceRecord>(`/devices/${deviceCode}/location`, payload);
  },
  refreshDevice(deviceCode: string) {
    requireBackofficePermission("devices:operate");
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/refresh`);
  },
  confirmDeviceDoorClosed(deviceCode: string) {
    requireBackofficePermission("devices:operate");
    return adminClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/confirm-door-closed`);
  },
  remoteOpenDevice(deviceCode: string, doorNum: string, reason: string) {
    requireBackofficePermission("devices:operate");
    return adminClient.post<{ eventId: string; orderNo: string; deviceCode: string; doorNum: string }>(
      `/devices/${deviceCode}/remote-open`,
      { doorNum, reason }
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
    requireBackofficePermission("devices:operate");
    requireBackofficePermission("payments:refund");
    return adminClient.post("/cabinet-events/payment-success", payload);
  },
  retryZeroCostPlatformCompletion(eventId: string) {
    requireBackofficePermission("devices:operate");
    return adminClient.post(`/cabinet-events/event/${eventId}/platform-completion-retry`);
  },
  confirmBillingResolution(eventId: string, note: string) {
    requireBackofficePermission("devices:operate");
    return adminClient.post(`/cabinet-events/event/${eventId}/billing-confirmation`, { note });
  },
  refundOrder(payload: {
    orderNo: string;
    transactionId: string;
    deviceCode: string;
    refundNo: string;
    amount: number;
  }) {
    requireBackofficePermission("payments:refund");
    return adminClient.post<PaymentRefundRecord>("/inventory-orders/refund", payload);
  },
  reconcileRefund(id: string) {
    requireBackofficePermission("payments:refund");
    return adminClient.post<PaymentRefundRecord>(
      `/payments/refunds/${encodeURIComponent(id)}/reconcile`
    );
  },
  goodsOverview() {
    requireBackofficePermission("goods:view");
    return adminClient.get<GoodsOverviewSnapshot>("/goods-overview");
  },
  async exportGoodsOverview(token: string) {
    requireBackofficePermission("goods:export");
    const response = await fetch(
      `${adminApiBaseUrl}/goods-overview/export/file`,
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
    requireBackofficePermission("goods:manage");
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
    requireBackofficePermission("goods:manage");
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
    requireBackofficePermission("goods:manage");
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
    requireBackofficePermission("goods:manage");
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
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post(`/goods/${goodsId}/batches`, payload);
  },
  removeGoodsBatch(batchId: string, payload: { quantity: number; note?: string; confirmed?: boolean }) {
    requireBackofficePermission("goods:stock-adjust");
    return adminClient.post(`/goods/batches/${batchId}/remove`, payload);
  },
  goodsAlertPolicies() {
    requireBackofficePermission("goods:view");
    return adminClient.get<GoodsAlertPolicy[]>("/goods-alert-policies");
  },
  createGoodsAlertPolicy(payload: Omit<GoodsAlertPolicy, "id">) {
    requireBackofficePermission("goods:manage");
    return adminClient.post<GoodsAlertPolicy>("/goods-alert-policies", payload);
  },
  updateGoodsAlertPolicy(id: string, payload: Partial<Omit<GoodsAlertPolicy, "id">>) {
    requireBackofficePermission("goods:manage");
    return adminClient.patch<GoodsAlertPolicy>(`/goods-alert-policies/${id}`, payload);
  },
  batchAssignGoodsAlertPolicies(payload: {
    deviceCodes: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    requireBackofficePermission("goods:manage");
    return adminClient.post<GoodsAlertPolicy[]>("/goods-alert-policies/batch-assign", payload);
  },
  syncDeviceGoods(deviceCode: string, doorNum = "1") {
    requireBackofficePermission("goods:manage");
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
    requireBackofficePermission("goods:manage");
    return adminClient.patch(`/devices/${deviceCode}/goods/${goodsId}/threshold`, payload);
  },
  alerts() {
    requireBackofficePermission("alerts:manage");
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
  paymentDiagnostics() {
    requireBackofficePermission("system-settings:view");
    return adminClient.get<PaymentDiagnosticsResult>("/payments/diagnostics");
  },
  saveSystemSettings(payload: SystemSettingsUpdatePayload) {
    requireBackofficePermission("system-settings:update");
    return adminClient.patch<SystemSettingsUpdateResult>("/system-settings", payload);
  },
  instanceRuntimeControl() {
    requireBackofficePermission("system-settings:view");
    return adminClient.get<InstanceRuntimeControlStatus>("/system-settings/runtime-control");
  },
  restartCurrentInstance(payload: InstanceRuntimeRestartPayload) {
    requireBackofficePermission("system-settings:update");
    return adminClient.post<InstanceRuntimeRestartResult>(
      "/system-settings/runtime-control/restart",
      payload
    );
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
    requireBackofficePermission("warehouse:transfer");
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
    requireBackofficePermission("warehouse:stocktake");
    return adminClient.post("/stocktakes", payload);
  },
  createExpiredBatchDisposition(
    batchId: string,
    payload: {
      confirmed: boolean;
      quantity: number;
      method: ExpiredBatchDispositionMethod;
      reason: string;
      idempotencyKey?: string;
    }
  ) {
    requireBackofficePermission("warehouse:dispose-expired");
    return adminClient.post<ExpiredBatchDispositionRecord>(
      `/expired-batches/${encodeURIComponent(batchId)}/dispositions`,
      payload
    );
  },
  async exportStocktake(id: string, token: string) {
    requireBackofficePermission("warehouse:export");
    const response = await fetch(
      `${adminApiBaseUrl}/stocktakes/${id}/export`,
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
      `${adminApiBaseUrl}/operation-logs/export/file${query.size ? `?${query.toString()}` : ""}`,
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
      `${adminApiBaseUrl}/operation-logs/export/system-file`,
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
    requireBackofficePermission("operation-logs:undo");
    return adminClient.post<OperationLogRecord>(`/operation-logs/${id}/undo`);
  }
};
