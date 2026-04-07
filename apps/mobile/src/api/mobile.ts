import type {
  CabinetOpenRequest,
  CabinetOpenResult,
  DeviceRecord,
  InventoryMovement,
  UserRole
} from "@vm/shared-types";

import { mobileClient } from "./client";

interface LoginResponse {
  token: string;
  user: {
    id: string;
    role: UserRole;
    name: string;
    phone: string;
    tags: string[];
  };
  quota?: {
    remainingToday: Record<string, number>;
    usedCount?: number;
  };
}

export const mobileApi = {
  requestCode(phone: string) {
    return mobileClient.post<{ phone: string; expiresInSeconds: number; previewCode: string }>(
      "/auth/request-code",
      { phone }
    );
  },
  login(phone: string, code: string) {
    return mobileClient.post<LoginResponse>("/auth/login", { phone, code });
  },
  getQuotaSummary(phone: string) {
    return mobileClient.get<{
      remainingToday: Record<string, number>;
      usedCount?: number;
    }>("/access-rules/summary", {
      query: { phone }
    });
  },
  listDevices() {
    return mobileClient.get<DeviceRecord[]>("/devices");
  },
  queryGoods(deviceCode: string, doorNum = "1") {
    return mobileClient.post(`/devices/${deviceCode}/goods/query`, undefined, {
      query: { doorNum }
    });
  },
  openCabinet(payload: CabinetOpenRequest, role: UserRole) {
    return mobileClient.post<CabinetOpenResult>("/cabinet-events/open", payload, {
      headers: {
        "x-role": role
      }
    });
  },
  listRecords(userId: string, role: UserRole) {
    return mobileClient.get<InventoryMovement[]>("/inventory-orders", {
      query: { userId, role },
      headers: {
        "x-role": role
      }
    });
  },
  merchantSummary(userId: string) {
    return mobileClient.get<{
      donatedUnits: number;
      expiredUnits: number;
      pendingAlerts: number;
      records: InventoryMovement[];
    }>("/inventory-orders/merchant-summary", {
      query: { userId },
      headers: {
        "x-role": "merchant"
      }
    });
  },
  alerts(role: Extract<UserRole, "merchant" | "admin">) {
    return mobileClient.get<
      Array<{
        id: string;
        title: string;
        detail: string;
        dueAt: string;
        status: string;
      }>
    >("/alerts", {
      headers: {
        "x-role": role
      }
    });
  }
};
