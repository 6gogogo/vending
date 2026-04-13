import { createJsonClient } from "@vm/shared-client";

import { uniRequestFetch } from "./uni-request";
import { readStoredMobileSession } from "../utils/session-storage";

export const mobileClient = createJsonClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000/api",
  fetchImpl: uniRequestFetch,
  getToken: () => readStoredMobileSession()?.token
});
