import type {
  CabinetAccessRule,
  CabinetEventRecord,
  DashboardSnapshot,
  DeviceRecord,
  UserRecord
} from "@vm/shared-types";

import { adminClient } from "./client";

const adminHeaders = {
  "x-role": "admin"
};

export const adminApi = {
  dashboard() {
    return adminClient.get<DashboardSnapshot>("/analytics/dashboard", {
      headers: adminHeaders
    });
  },
  users(role?: UserRecord["role"]) {
    return adminClient.get<UserRecord[]>("/users", {
      query: { role },
      headers: adminHeaders
    });
  },
  rules() {
    return adminClient.get<CabinetAccessRule[]>("/access-rules", {
      headers: adminHeaders
    });
  },
  updateRule(role: "special" | "merchant", payload: { dailyLimit: number; categoryLimit: Record<string, number> }) {
    return adminClient.patch<CabinetAccessRule>("/access-rules", payload, {
      query: { role },
      headers: adminHeaders
    });
  },
  alerts() {
    return adminClient.get<
      Array<{
        id: string;
        title: string;
        detail: string;
        dueAt: string;
        status: string;
      }>
    >("/alerts", {
      headers: adminHeaders
    });
  },
  resolveAlert(id: string) {
    return adminClient.patch(`/alerts/${id}/resolve`, undefined, {
      headers: adminHeaders
    });
  },
  devices() {
    return adminClient.get<DeviceRecord[]>("/devices", {
      headers: adminHeaders
    });
  },
  events() {
    return adminClient.get<CabinetEventRecord[]>("/cabinet-events", {
      headers: adminHeaders
    });
  },
  callbackLogs(limit = 20) {
    return adminClient.get<
      Array<{
        id: string;
        type: string;
        receivedAt: string;
        payload: Record<string, unknown>;
      }>
    >("/cabinet-events/callback-logs", {
      query: { limit },
      headers: adminHeaders
    });
  }
};
