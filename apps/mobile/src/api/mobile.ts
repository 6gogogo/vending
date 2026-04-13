import type {
  AlertTask,
  AppLoginResult,
  CabinetOpenRequest,
  CabinetOpenResult,
  DeviceMonitoringDetail,
  DeviceRecord,
  GoodsCategory,
  GoodsCategoryRecord,
  InventoryMovement,
  MerchantGoodsTemplate,
  MobileLoginResult,
  MobileSessionSnapshot,
  OperationLogCategory,
  OperationLogRecord,
  RegionRecord,
  RegistrationPhoneLookup,
  RegistrationApplication,
  UserManagementDetail,
  UserRecord,
  UserRole,
  WarehouseInventorySnapshot,
  WarehouseRecord
} from "@vm/shared-types";

import { mobileClient } from "./client";

export const mobileApi = {
  requestCode(phone: string) {
    return mobileClient.post<{
      phone: string;
      expiresInSeconds: number;
      provider: "mock" | "aliyun";
      previewCode?: string;
    }>(
      "/auth/request-code",
      { phone }
    );
  },
  mobileLogin(phone: string, code: string, requestedRole?: UserRole) {
    return mobileClient.post<MobileLoginResult>("/auth/mobile-login", {
      phone,
      code,
      requestedRole
    });
  },
  appLogin(phone: string, code: string) {
    return mobileClient.post<AppLoginResult>("/auth/app-login", {
      phone,
      code
    });
  },
  submitMobileProfile(payload: {
    draftToken: string;
    requestedRole?: UserRole;
    profile: {
      name: string;
      neighborhood?: string;
      note?: string;
      merchantName?: string;
      contactName?: string;
      address?: string;
      organization?: string;
      title?: string;
    };
  }) {
    return mobileClient.post<MobileLoginResult>("/auth/mobile-profile", payload);
  },
  mobileSession() {
    return mobileClient.get<MobileSessionSnapshot>("/auth/mobile-session");
  },
  appSession() {
    return mobileClient.get<MobileSessionSnapshot>("/auth/app-session");
  },
  getQuotaSummary(phone: string) {
    return mobileClient.get<MobileSessionSnapshot["quota"]>("/access-rules/summary", {
      query: { phone }
    });
  },
  listDevices(query?: { longitude?: number; latitude?: number }) {
    return mobileClient.get<DeviceRecord[]>("/devices", {
      query
    });
  },
  getDevice(deviceCode: string) {
    return mobileClient.get<DeviceRecord>(`/devices/${deviceCode}`);
  },
  queryGoods(deviceCode: string, doorNum = "1") {
    return mobileClient.post<Array<{
      goodsCode: string;
      goodsId: string;
      name: string;
      price: number;
      imageUrl: string;
      category: GoodsCategory;
      stock?: number;
      expiresAt?: string;
    }>>(`/devices/${deviceCode}/goods/query`, undefined, {
      query: { doorNum }
    });
  },
  openCabinet(payload: CabinetOpenRequest) {
    return mobileClient.post<CabinetOpenResult>("/cabinet-events/open", payload);
  },
  listRecords(userId: string, role?: UserRole) {
    return mobileClient.get<InventoryMovement[]>("/inventory-orders", {
      query: { userId, role }
    });
  },
  merchantSummary(userId: string) {
    return mobileClient.get<{
      donatedUnits: number;
      expiredUnits: number;
      pendingAlerts: number;
      records: InventoryMovement[];
    }>("/inventory-orders/merchant-summary", {
      query: { userId }
    });
  },
  createFeedback(payload: {
    title?: string;
    detail: string;
    deviceCode?: string;
    feedbackType: "机器故障" | "服务问题" | "其他";
  }) {
    return mobileClient.post<AlertTask>("/alerts/feedback", payload);
  },
  alerts(status?: AlertTask["status"]) {
    return mobileClient.get<AlertTask[]>("/alerts", {
      query: { status }
    });
  },
  resolveAlert(id: string, note?: string) {
    return mobileClient.patch<AlertTask>(`/alerts/${id}/resolve`, { note });
  },
  merchantTemplates() {
    return mobileClient.get<MerchantGoodsTemplate[]>("/merchant-goods-templates");
  },
  regions() {
    return mobileClient.get<RegionRecord[]>("/regions");
  },
  goodsCategories() {
    return mobileClient.get<GoodsCategoryRecord[]>("/goods-categories");
  },
  async uploadImage(filePath: string, token?: string) {
    const response = await new Promise<{ data: string; statusCode: number }>((resolve, reject) => {
      uni.uploadFile({
        url: `${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api"}/uploads/images`,
        filePath,
        name: "file",
        header: token
          ? {
              Authorization: `Bearer ${token}`
            }
          : undefined,
        success: resolve,
        fail: reject
      });
    });

    const parsed = JSON.parse(response.data) as {
      code: number;
      message: string;
      data: { url: string; filename: string; relativePath: string };
    };

    if (parsed.code !== 200) {
      throw new Error(parsed.message || "上传失败");
    }

    return parsed.data;
  },
  createMerchantTemplate(payload: {
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
  }) {
    return mobileClient.post<MerchantGoodsTemplate>("/merchant-goods-templates", payload);
  },
  updateMerchantTemplate(
    id: string,
    payload: Partial<{
      goodsId: string;
      goodsCode: string;
      goodsName: string;
      fullName: string;
      category: GoodsCategory;
      categoryName: string;
      packageForm: string;
      specification: string;
      manufacturer: string;
      defaultQuantity: number;
      defaultShelfLifeDays: number;
      imageUrl?: string;
      status: "active" | "inactive";
    }>
  ) {
    return mobileClient.patch<MerchantGoodsTemplate>(`/merchant-goods-templates/${id}`, payload);
  },
  createMerchantRestock(payload: {
    templateId: string;
    deviceCode: string;
    quantity?: number;
    productionDate: string;
    note?: string;
  }) {
    return mobileClient.post("/merchant-restocks", payload);
  },
  merchantRestockTraces() {
    return mobileClient.get<{
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
  registrationLookup(phone: string) {
    return mobileClient.get<RegistrationPhoneLookup>("/registration-applications/by-phone", {
      query: { phone }
    });
  },
  submitRegistration(payload: {
    phone: string;
    code: string;
    requestedRole?: UserRole;
    profile: {
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
    };
  }) {
    return mobileClient.post<RegistrationApplication>("/registration-applications", payload);
  },
  updateRegistration(
    id: string,
    payload: {
      phone: string;
      code: string;
      requestedRole?: UserRole;
      profile: {
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
      };
    }
  ) {
    return mobileClient.patch<RegistrationApplication>(`/registration-applications/${id}`, payload);
  },
  registrationApplications(status?: RegistrationApplication["status"]) {
    return mobileClient.get<RegistrationApplication[]>("/registration-applications", {
      query: { status }
    });
  },
  registrationApplicationDetail(id: string) {
    return mobileClient.get<RegistrationApplication>(`/registration-applications/${id}`);
  },
  reviewRegistration(id: string, payload: { decision: "approved" | "rejected"; reason?: string }) {
    return mobileClient.patch<RegistrationApplication>(`/registration-applications/${id}/review`, payload);
  },
  users(role?: UserRecord["role"]) {
    return mobileClient.get<UserRecord[]>("/users", {
      query: { role }
    });
  },
  userDetail(userId: string) {
    return mobileClient.get<UserManagementDetail>(`/users/${userId}`);
  },
  updateUser(
    userId: string,
    payload: {
      phone?: string;
      name?: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
    }
  ) {
    return mobileClient.patch<UserRecord>(`/users/${userId}`, payload);
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
    return mobileClient.post(`/users/${userId}/manual-adjustment`, payload);
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
    return mobileClient.patch<{ count: number; updated: UserRecord[] }>("/users/batch", payload);
  },
  listPolicies() {
    return mobileClient.get<Array<{
      id: string;
      name: string;
      weekdays: number[];
      startHour: number;
      endHour: number;
      goodsLimits: Array<{
        goodsId: string;
        goodsName: string;
        category: GoodsCategory;
        quantity: number;
      }>;
      applicableUserIds: string[];
      status: "active" | "inactive";
    }>>("/special-access-policies");
  },
  batchAssignPolicies(payload: {
    userIds: string[];
    policyIds: string[];
    mode: "bind" | "unbind" | "replace";
  }) {
    return mobileClient.post("/special-access-policies/batch-assign", payload);
  },
  deviceMonitoring(deviceCode: string) {
    return mobileClient.get<DeviceMonitoringDetail>(`/devices/${deviceCode}/monitoring`);
  },
  refreshDevice(deviceCode: string) {
    return mobileClient.post<DeviceMonitoringDetail>(`/devices/${deviceCode}/refresh`);
  },
  remoteOpenDevice(deviceCode: string, doorNum = "1") {
    return mobileClient.post<{ eventId: string; orderNo: string; deviceCode: string; doorNum: string }>(
      `/devices/${deviceCode}/remote-open`,
      { doorNum }
    );
  },
  logs(filters?: {
    category?: OperationLogCategory;
    subjectType?: "user" | "device" | "event" | "alert" | "goods";
    subjectId?: string;
  }) {
    return mobileClient.get<OperationLogRecord[]>("/operation-logs", {
      query: filters
    });
  },
  logDetail(id: string) {
    return mobileClient.get<OperationLogRecord>(`/operation-logs/${id}`);
  },
  undoLog(id: string) {
    return mobileClient.post<OperationLogRecord>(`/operation-logs/${id}/undo`);
  },
  warehouses() {
    return mobileClient.get<WarehouseRecord[]>("/warehouses");
  },
  warehouseInventory() {
    return mobileClient.get<WarehouseInventorySnapshot>("/warehouse-inventory");
  }
};
