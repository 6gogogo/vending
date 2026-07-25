import { loadPublicRuntimeConfig } from "./public-config";

declare global {
  interface Window {
    AMap?: any;
    __vmAmapLoaderPromise__?: Promise<any>;
    _AMapSecurityConfig?: {
      securityJsCode?: string;
    };
  }
}

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

  window.__vmAmapLoaderPromise__ = loadPublicRuntimeConfig()
    .then(
      ({ amapRuntimeMode, amapWebKey, amapSecurityJsCode }) =>
        new Promise((resolve, reject) => {
          if (amapRuntimeMode === "mock") {
            reject(
              new Error(
                "当前实例地图模式为模拟，未加载高德脚本，也不会发送地点搜索请求。" +
                  "请将 VM_FULL_SIMULATION_MAP_MODE 设为 real，并为 API 进程配置有效的 " +
                  "AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 后重启；在此之前可手工录入坐标。"
              )
            );
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
