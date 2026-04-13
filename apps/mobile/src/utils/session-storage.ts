export const MOBILE_SESSION_STORAGE_KEY = "vm-mobile-session";

export interface StoredMobileSessionState {
  token?: string;
  user?: {
    id: string;
    role: "admin" | "merchant" | "special";
    name: string;
    phone: string;
    tags: string[];
  };
  quota?: {
    role?: "admin" | "merchant" | "special";
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
    requestedRole?: "admin" | "merchant" | "special";
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
