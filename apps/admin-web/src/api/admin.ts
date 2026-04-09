import type {
  AlertTask,
  DashboardSnapshot,
  DeviceMonitoringDetail,
  DeviceRecord,
  GoodsAlertPolicy,
  GoodsCatalogItem,
  GoodsDetailSnapshot,
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
  goodsDetail(goodsId: string) {
    return adminClient.get<GoodsDetailSnapshot>(`/goods/${goodsId}`);
  },
  createGoods(payload: {
    goodsCode: string;
    goodsId: string;
    name: string;
    category: "food" | "drink" | "daily";
    price: number;
    imageUrl: string;
  }) {
    return adminClient.post<GoodsCatalogItem>("/goods", payload);
  },
  updateGoods(
    goodsId: string,
    payload: Partial<{
      goodsCode: string;
      name: string;
      category: "food" | "drink" | "daily";
      price: number;
      imageUrl: string;
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
  },
  undoLog(id: string) {
    return adminClient.post<OperationLogRecord>(`/operation-logs/${id}/undo`);
  }
};
