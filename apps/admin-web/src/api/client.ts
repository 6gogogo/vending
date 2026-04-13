import { createJsonClient } from "@vm/shared-client";

import { useAdminSessionStore } from "../stores/session";

export const adminClient = createJsonClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api",
  getToken: () => useAdminSessionStore().token
});
