import { adminApiBaseUrl } from "../api/client";

declare global {
  interface Window {
    AMap?: any;
    __vmAmapLoaderPromise__?: Promise<any>;
    _AMapSecurityConfig?: {
      securityJsCode?: string;
    };
  }
}

const loadPublicConfig = async () => {
  const response = await fetch(`${adminApiBaseUrl}/public-config`);

  const parsed = (await response.json()) as {
    code: number;
    message: string;
    data?: {
      amapRuntimeMode?: "mock" | "real";
      amapWebKey?: string;
      amapSecurityJsCode?: string;
    };
  };

  if (!response.ok || parsed.code !== 200) {
    throw new Error(parsed.message || "读取地图配置失败");
  }

  return parsed.data ?? {};
};

export const loadAmap = () => {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("当前环境不支持地图加载"));
  }

  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }

  if (window.__vmAmapLoaderPromise__) {
    return window.__vmAmapLoaderPromise__;
  }

  window.__vmAmapLoaderPromise__ = loadPublicConfig()
    .then(
      ({ amapRuntimeMode, amapWebKey, amapSecurityJsCode }) =>
        new Promise((resolve, reject) => {
          if (amapRuntimeMode === "mock") {
            reject(new Error("当前为全真模拟地图：未加载高德脚本，请手工录入坐标。"));
            return;
          }

          if (!amapWebKey) {
            reject(new Error("后端未配置 AMAP_WEB_KEY"));
            return;
          }

          if (amapSecurityJsCode) {
            window._AMapSecurityConfig = {
              securityJsCode: amapSecurityJsCode
            };
          }

          const existing = document.querySelector<HTMLScriptElement>("script[data-vm-amap='true']");

          if (existing) {
            existing.addEventListener("load", () => resolve(window.AMap));
            existing.addEventListener("error", () =>
              reject(new Error("高德地图脚本加载失败，请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与当前域名白名单"))
            );
            return;
          }

          const script = document.createElement("script");
          script.src = `https://webapi.amap.com/maps?v=2.0&key=${amapWebKey}&plugin=AMap.PlaceSearch,AMap.AutoComplete,AMap.Geocoder`;
          script.async = true;
          script.defer = true;
          script.dataset.vmAmap = "true";
          script.onload = () => resolve(window.AMap);
          script.onerror = () =>
            reject(new Error("高德地图脚本加载失败，请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与当前域名白名单"));
          document.head.appendChild(script);
        })
    )
    .catch((error) => {
      window.__vmAmapLoaderPromise__ = undefined;
      throw error;
    });

  return window.__vmAmapLoaderPromise__;
};
