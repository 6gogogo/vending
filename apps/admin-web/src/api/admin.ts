import type {
  DashboardSnapshot,
  DeviceMonitoringDetail,
  DeviceRecord,
  GoodsAlertPolicy,
  GoodsCatalogItem,
  GoodsOverviewSnapshot,
  OperationLogCategory,
  OperationLogRecord,
  OperationLogStatus,
  SpecialAccessPolicy,
  UserManagementDetail,
  UserRecord
} from "@vm/shared-types";

import { adminClient } from "./client";

interface AdminLoginResponse {
  token: string;
  user: {
    id: string;
    role: "admin";
    name: string;
    phone: string;
    tags: string[];
  };
}

export const adminApi = {
  requestCode(phone: string) {
    return adminClient.post<{ phone: string; expiresInSeconds: number; previewCode: string }>(
      "/auth/request-code",
      { phone }
    );
  },
  adminLogin(phone: string, code: string) {
    return adminClient.post<AdminLoginResponse>("/auth/admin-login", { phone, code });
  },
  session() {
    return adminClient.get<AdminLoginResponse>("/auth/session");
  },
  dashboard() {
    return adminClient.get<DashboardSnapshot>("/analytics/dashboard");
  },
  users(role?: UserRecord["role"]) {
    return adminClient.get<UserRecord[]>("/users", {
      query: { role }
    });
  },
  createUser(payload: {
    role: UserRecord["role"];
    phone: string;
    name: string;
    status?: "active" | "inactive";
    neighborhood?: string;
    tags?: string[];
  }) {
    return adminClient.post<UserRecord>("/users", payload);
  },
  updateUser(
    userId: string,
    payload: {
      phone?: string;
      name?: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      tags?: string[];
    }
  ) {
    return adminClient.patch<UserRecord>(`/users/${userId}`, payload);
  },
  userDetail(userId: string) {
    return adminClient.get<UserManagementDetail>(`/users/${userId}`);
  },
  batchUpdateUsers(payload: {
    userIds: string[];
    patch: {
      status?: "active" | "inactive";
      tags?: string[];
      neighborhood?: string;
    };
  }) {
    return adminClient.patch<{ count: number; updated: UserRecord[] }>("/users/batch", payload);
  },
  manualAdjustUser(
    userId: string,
    payload: {
      deviceCode: string;
      goodsId: string;
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
  alerts() {
    return adminClient.get<
      Array<{
        id: string;
        title: string;
        detail: string;
        dueAt: string;
        status: string;
        deviceCode?: string;
        targetUserId?: string;
      }>
    >("/alerts");
  },
  resolveAlert(id: string, note?: string) {
    return adminClient.patch(`/alerts/${id}/resolve`, { note });
  },
  devices() {
    return adminClient.get<DeviceRecord[]>("/devices");
  },
  deviceDetail(deviceCode: string) {
    return adminClient.get<DeviceMonitoringDetail>(`/devices/${deviceCode}/monitoring`);
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
  goodsOverview() {
    return adminClient.get<GoodsOverviewSnapshot>("/goods-overview");
  },
  goodsCatalog() {
    return adminClient.get<GoodsCatalogItem[]>("/goods-catalog");
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
  logs(filters?: {
    category?: OperationLogCategory;
    status?: OperationLogStatus;
    subjectType?: "user" | "device" | "event" | "alert" | "goods";
    subjectId?: string;
  }) {
    return adminClient.get<OperationLogRecord[]>("/operation-logs", {
      query: filters
    });
  },
  logDetail(id: string) {
    return adminClient.get<OperationLogRecord>(`/operation-logs/${id}`);
  }
};
