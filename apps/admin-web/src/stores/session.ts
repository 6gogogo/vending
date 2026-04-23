import { defineStore } from "pinia";

const storageKey = "vm-admin-session";

interface AdminSessionUser {
  id: string;
  role: "admin";
  name: string;
  phone: string;
  tags: string[];
}

interface AdminSessionAuth {
  username: string;
  usesDefaultPassword: boolean;
  passwordUpdatedAt: string;
}

interface AdminSessionState {
  token?: string;
  user?: AdminSessionUser;
  auth?: AdminSessionAuth;
  validatedToken?: string;
}

const readStoredState = (): AdminSessionState => {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(storageKey);

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as AdminSessionState;
  } catch {
    return {};
  }
};

export const useAdminSessionStore = defineStore("admin-session", {
  state: (): AdminSessionState => ({
    ...readStoredState(),
    validatedToken: undefined
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token && state.user),
    needsValidation: (state) => Boolean(state.token && state.token !== state.validatedToken)
  },
  actions: {
    setSession(payload: { token: string; user: AdminSessionUser; auth: AdminSessionAuth }) {
      this.token = payload.token;
      this.user = payload.user;
      this.auth = payload.auth;
      this.validatedToken = payload.token;
      this.persist();
    },
    markValidated(token: string) {
      this.validatedToken = token;
    },
    clearSession() {
      this.token = undefined;
      this.user = undefined;
      this.auth = undefined;
      this.validatedToken = undefined;
      this.persist();
    },
    persist() {
      if (typeof window === "undefined") {
        return;
      }

      if (!this.token || !this.user) {
        window.localStorage.removeItem(storageKey);
        return;
      }

      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          token: this.token,
          user: this.user,
          auth: this.auth
        })
      );
    }
  }
});
