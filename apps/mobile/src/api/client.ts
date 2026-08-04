import { createJsonClient } from "@vm/shared-client";

import { uniRequestFetch } from "./uni-request";
import { readStoredMobileSession } from "../utils/session-storage";

const fallbackApiBaseUrl = "http://127.0.0.1:4000/api";
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
const buildEnv = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env;

const isLocalHostname = (hostname: string) => localHostnames.has(hostname);

const isLocalApiBaseUrl = (baseUrl: string) => {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const parsed = new URL(baseUrl, window.location.origin);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
};

const shouldForceLocalApiBaseUrl = (configuredBaseUrl: string) => {
  if (!buildEnv?.DEV || typeof window === "undefined") {
    return false;
  }

  const allowRemoteApi =
    String(buildEnv.VITE_ALLOW_REMOTE_API_IN_LOCAL_DEV ?? "")
      .trim()
      .toLowerCase() === "true";

  return (
    !allowRemoteApi &&
    isLocalHostname(window.location.hostname) &&
    !isLocalApiBaseUrl(configuredBaseUrl)
  );
};

export const resolveMobileApiBaseUrl = () => {
  const configuredBaseUrl =
    String(buildEnv?.VITE_API_BASE_URL ?? "").trim() || fallbackApiBaseUrl;

  if (shouldForceLocalApiBaseUrl(configuredBaseUrl)) {
    console.warn(
      `本地开发小程序 H5 已阻止连接远程 API：${configuredBaseUrl}，当前改用 ${fallbackApiBaseUrl}。如需本地调试远程 API，请显式设置 VITE_ALLOW_REMOTE_API_IN_LOCAL_DEV=true。`
    );
    return fallbackApiBaseUrl;
  }

  return configuredBaseUrl;
};

export const mobileApiBaseUrl = resolveMobileApiBaseUrl();

export const mobileClient = createJsonClient({
  baseUrl: mobileApiBaseUrl,
  fetchImpl: uniRequestFetch,
  getToken: () => readStoredMobileSession()?.token
});
