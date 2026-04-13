import { defineStore } from "pinia";

import type {
  MobileAuthDraft,
  MobileSessionSnapshot,
  RegistrationApplication,
  RegistrationApplicationProfile,
  UserRole
} from "@vm/shared-types";

import { mobileApi } from "../api/mobile";
import {
  clearStoredMobileSession,
  readStoredMobileSession,
  writeStoredMobileSession
} from "../utils/session-storage";

interface SessionUser {
  id: string;
  role: UserRole;
  name: string;
  phone: string;
  tags: string[];
}

interface SessionState {
  token?: string;
  user?: SessionUser;
  quota?: {
    role?: UserRole;
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
  draft?: MobileAuthDraft;
  application?: RegistrationApplication;
  profileDraft?: RegistrationApplicationProfile;
  bootstrapped: boolean;
}

export const useSessionStore = defineStore("mobile-session", {
  state: (): SessionState => ({
    token: undefined,
    user: undefined,
    quota: undefined,
    draft: undefined,
    application: undefined,
    profileDraft: undefined,
    bootstrapped: false
  }),
  getters: {
    role: (state) => state.user?.role,
    isLoggedIn: (state) => Boolean(state.token && state.user)
  },
  actions: {
    hydrate() {
      const stored = readStoredMobileSession();

      if (!stored) {
        this.bootstrapped = true;
        return;
      }

      this.token = stored.token;
      this.user = stored.user;
      this.quota = stored.quota;
      this.draft = stored.draft;
      this.application = stored.application as RegistrationApplication | undefined;
      this.profileDraft = stored.profileDraft as RegistrationApplicationProfile | undefined;
      this.bootstrapped = true;
    },
    persist() {
      writeStoredMobileSession({
        token: this.token,
        user: this.user,
        quota: this.quota,
        draft: this.draft,
        application: this.application,
        profileDraft: this.profileDraft
      });
    },
    async bootstrap() {
      if (this.bootstrapped) {
        return this.user;
      }

      this.hydrate();

      if (!this.token) {
        return this.user;
      }

      try {
        const snapshot = await mobileApi.appSession();
        this.setSession(snapshot);
      } catch {
        this.clear();
      }

      return this.user;
    },
    setSession(payload: MobileSessionSnapshot) {
      this.token = payload.token;
      this.user = payload.user;
      this.quota = payload.quota;
      this.draft = undefined;
      this.application = undefined;
      this.profileDraft = undefined;
      this.bootstrapped = true;
      this.persist();
    },
    setQuota(quota: SessionState["quota"]) {
      this.quota = quota;
      this.persist();
    },
    setDraft(payload: {
      draft: MobileAuthDraft;
      application?: RegistrationApplication;
      profileDraft?: RegistrationApplicationProfile;
    }) {
      this.token = undefined;
      this.user = undefined;
      this.quota = undefined;
      this.draft = payload.draft;
      this.application = payload.application;
      this.profileDraft = payload.profileDraft ?? payload.application?.profile;
      this.bootstrapped = true;
      this.persist();
    },
    setApplication(application?: RegistrationApplication) {
      this.application = application;
      this.profileDraft = application?.profile;
      this.persist();
    },
    setProfileDraft(profileDraft?: RegistrationApplicationProfile) {
      this.profileDraft = profileDraft;
      this.persist();
    },
    clearDraft() {
      this.draft = undefined;
      this.application = undefined;
      this.profileDraft = undefined;
      this.persist();
    },
    clear() {
      this.token = undefined;
      this.user = undefined;
      this.quota = undefined;
      this.draft = undefined;
      this.application = undefined;
      this.profileDraft = undefined;
      this.bootstrapped = true;
      clearStoredMobileSession();
    }
  }
});
