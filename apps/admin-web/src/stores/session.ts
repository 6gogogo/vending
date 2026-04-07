import { defineStore } from "pinia";

export const useAdminSessionStore = defineStore("admin-session", {
  state: () => ({
    role: "admin" as const
  })
});
