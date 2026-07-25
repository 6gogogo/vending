import { adminCopy } from "../constants/copy";
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
    return Promise.reject(new Error(adminCopy.map.unsupported));
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
            reject(new Error(adminCopy.map.mockMode));
            return;
          }

          if (!amapWebKey) {
            reject(new Error(adminCopy.map.missingWebKey));
            return;
          }

          if (amapSecurityJsCode) {
            window._AMapSecurityConfig = {
              securityJsCode: amapSecurityJsCode
            };
          }

          document
            .querySelector<HTMLScriptElement>("script[data-vm-amap='true']")
            ?.remove();

          const script = document.createElement("script");
          script.src = `https://webapi.amap.com/maps?v=2.0&key=${amapWebKey}&plugin=AMap.PlaceSearch,AMap.AutoComplete,AMap.Geocoder`;
          script.async = true;
          script.defer = true;
          script.dataset.vmAmap = "true";
          const rejectScriptLoad = () => {
            script.remove();
            reject(new Error(adminCopy.map.scriptLoadFailed));
          };
          script.onload = () => {
            if (!window.AMap) {
              rejectScriptLoad();
              return;
            }

            resolve(window.AMap);
          };
          script.onerror = rejectScriptLoad;
          document.head.appendChild(script);
        })
    )
    .catch((error) => {
      window.__vmAmapLoaderPromise__ = undefined;
      throw error;
    });

  return window.__vmAmapLoaderPromise__;
};
