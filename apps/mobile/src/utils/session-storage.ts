import type { RegistrationApplicationProfile, UserRole } from "@vm/shared-types";

import type { PickupLoginTarget } from "./cabinet-entry";

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
  profileDraft?: RegistrationApplicationProfile;
  /** 首次扫码后的原柜机目标，跨资料填写、审核和小程序重启保留。 */
  pickupTarget?: PickupLoginTarget;
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
