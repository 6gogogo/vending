import { createJsonClient } from "@vm/shared-client";

import { uniRequestFetch } from "./uni-request";

export const mobileClient = createJsonClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api",
  fetchImpl: uniRequestFetch
});
