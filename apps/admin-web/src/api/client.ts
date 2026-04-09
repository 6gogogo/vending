import { createJsonClient } from "@vm/shared-client";

import { useAdminSessionStore } from "../stores/session";

export const adminClient = createJsonClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api",
  getToken: () => useAdminSessionStore().token
});
