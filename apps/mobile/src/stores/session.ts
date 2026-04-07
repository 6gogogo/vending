import { defineStore } from "pinia";

import type { UserRole } from "@vm/shared-types";

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
    remainingToday: Record<string, number>;
    usedCount?: number;
  };
}

export const useSessionStore = defineStore("mobile-session", {
  state: (): SessionState => ({
    token: undefined,
    user: undefined,
    quota: undefined
  }),
  getters: {
    role: (state) => state.user?.role
  },
  actions: {
    setSession(payload: {
      token: string;
      user: SessionUser;
      quota?: {
        remainingToday: Record<string, number>;
        usedCount?: number;
      };
    }) {
      this.token = payload.token;
      this.user = payload.user;
      this.quota = payload.quota;
    },
    setQuota(quota: SessionState["quota"]) {
      this.quota = quota;
    },
    clear() {
      this.token = undefined;
      this.user = undefined;
      this.quota = undefined;
    }
  }
});
