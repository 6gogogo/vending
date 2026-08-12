import type { UserRole } from "@vm/shared-types";

export const MOBILE_SESSION_STORAGE_KEY = "vm-mobile-session";

export interface StoredMobileSessionState {
  token?: string;
  user?: {
    id: string;
    role: UserRole;
    name: string;
    phone: string;
    tags: string[];
  };
  quota?: {
    role?: UserRole;
    remainingToday: Record<string, number>;
    remainingByGoods?: Record<string, number>;
    receivableByGoods?: Record<string, number>;
    taxonomyRevision?: number;
    usedCount?: number;
    remainingDaily?: number;
    remainingFreeTotal?: number;
    activeWindows?: Array<{
      policyId: string;
      policyName: string;
      weekdays: number[];
      dateKey: string;
      startHour: number;
      endHour: number;
      goodsLimits: Array<{
        goodsId: string;
        goodsName: string;
        category: "food" | "drink" | "daily";
        quantity: number;
      }>;
    }>;
  };
  draft?: {
    token: string;
    phone: string;
    requestedRole?: UserRole;
    linkedUserId?: string;
    applicationId?: string;
  };
  application?: Record<string, unknown>;
  profileDraft?: {
    name: string;
    neighborhood?: string;
    note?: string;
    merchantName?: string;
    contactName?: string;
    address?: string;
    organization?: string;
    title?: string;
  };
}

export const readStoredMobileSession = (): StoredMobileSessionState | undefined => {
  try {
    const raw = uni.getStorageSync(MOBILE_SESSION_STORAGE_KEY);
    return raw ? (raw as StoredMobileSessionState) : undefined;
  } catch {
    return undefined;
  }
};

export const writeStoredMobileSession = (value: StoredMobileSessionState) => {
  uni.setStorageSync(MOBILE_SESSION_STORAGE_KEY, value);
};

export const clearStoredMobileSession = () => {
  uni.removeStorageSync(MOBILE_SESSION_STORAGE_KEY);
};
