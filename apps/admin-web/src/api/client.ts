import { createJsonClient } from "@vm/shared-client";

import { useAdminSessionStore } from "../stores/session";

const fallbackApiBaseUrl = "http://127.0.0.1:4000/api";
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

const isLocalHostname = (hostname: string) => localHostnames.has(hostname);

const isLocalApiBaseUrl = (baseUrl: string) => {
  try {
    const parsed = new URL(baseUrl, window.location.origin);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
};

const shouldForceLocalApiBaseUrl = (configuredBaseUrl: string) => {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const allowRemoteApi =
    String(import.meta.env.VITE_ALLOW_REMOTE_API_IN_LOCAL_DEV ?? "")
      .trim()
      .toLowerCase() === "true";

  return (
    !allowRemoteApi &&
    isLocalHostname(window.location.hostname) &&
    !isLocalApiBaseUrl(configuredBaseUrl)
  );
};

export const resolveAdminApiBaseUrl = () => {
  const configuredBaseUrl =
    String(import.meta.env.VITE_API_BASE_URL ?? "").trim() || fallbackApiBaseUrl;

  if (shouldForceLocalApiBaseUrl(configuredBaseUrl)) {
    console.warn(
      `本地开发后台已阻止连接远程 API：${configuredBaseUrl}，当前改用 ${fallbackApiBaseUrl}。如需本地调试远程 API，请显式设置 VITE_ALLOW_REMOTE_API_IN_LOCAL_DEV=true。`
    );
    return fallbackApiBaseUrl;
  }

  return configuredBaseUrl;
};

export const adminApiBaseUrl = resolveAdminApiBaseUrl();

export const adminClient = createJsonClient({
  baseUrl: adminApiBaseUrl,
  getToken: () => useAdminSessionStore().token
});
