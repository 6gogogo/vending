import { defineStore } from "pinia";

import { ApiError } from "@vm/shared-client";
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
import type { PickupLoginTarget } from "../utils/cabinet-entry";

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
  draft?: MobileAuthDraft;
  application?: RegistrationApplication;
  profileDraft?: RegistrationApplicationProfile;
  pickupTarget?: PickupLoginTarget;
  bootstrapped: boolean;
}

const pendingBootstraps = new WeakMap<object, Promise<SessionState["user"]>>();

export const useSessionStore = defineStore("mobile-session", {
  state: (): SessionState => ({
    token: undefined,
    user: undefined,
    quota: undefined,
    draft: undefined,
    application: undefined,
    profileDraft: undefined,
    pickupTarget: undefined,
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
      this.pickupTarget = stored.pickupTarget;
      this.bootstrapped = !stored.token;
    },
    resetBootstrap() {
      this.bootstrapped = false;
    },
    persist() {
      writeStoredMobileSession({
        token: this.token,
        user: this.user,
        quota: this.quota,
        draft: this.draft,
        application: this.application,
        profileDraft: this.profileDraft,
        pickupTarget: this.pickupTarget
      });
    },
    async bootstrap() {
      if (this.bootstrapped) {
        return this.user;
      }

      const pendingBootstrap = pendingBootstraps.get(this);
      if (pendingBootstrap) {
        return pendingBootstrap;
      }

      const bootstrap = (async () => {
        this.hydrate();

        if (!this.token) {
          this.bootstrapped = true;
          return this.user;
        }

        try {
          const result = await mobileApi.appSession();
          if (result.state === "approved") {
            this.setSession(result);
          } else if (result.state === "needs_profile") {
            this.setDraft({
              draft: result.draft,
              profileDraft: result.profile
            });
          } else {
            this.setDraft({
              draft: result.draft,
              application: result.application,
              profileDraft: result.application.profile
            });
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            this.clear();
          } else {
            // 断网、超时或服务维护不等于退出登录；保留本地会话供下次启动继续校验。
            this.bootstrapped = true;
          }
        }

        return this.user;
      })();
      pendingBootstraps.set(this, bootstrap);

      try {
        return await bootstrap;
      } finally {
        if (pendingBootstraps.get(this) === bootstrap) {
          pendingBootstraps.delete(this);
        }
      }
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
      this.token = payload.draft.applicationId ? payload.draft.token : undefined;
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
    setPickupTarget(target?: PickupLoginTarget) {
      this.pickupTarget = target;
      this.persist();
    },
    consumePickupTarget() {
      const target = this.pickupTarget;
      this.pickupTarget = undefined;
      this.persist();
      return target;
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
      this.pickupTarget = undefined;
      this.bootstrapped = true;
      clearStoredMobileSession();
    }
  }
});
