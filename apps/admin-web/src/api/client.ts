import { createJsonClient } from "@vm/shared-client";

export const adminClient = createJsonClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api"
});
