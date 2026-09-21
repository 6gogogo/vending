import { buildDeviceQueryUrl, buildPickupDeviceUrl, resolveCabinetEntry, resolvePickupLoginTarget } from "./cabinet-entry";

// 仅记录本次冷启动，不能持久化，否则会误拦截用户主动进入登录。
export const createGuestLaunchGuard = () => {
  let loginWasLaunchPage = false;
  return {
    launched(path?: string) {
      loginWasLaunchPage = ["pages/common/app-login", "pages/common/register"].includes((path ?? "").replace(/^\//, ""));
    },
    takeBrowseDestination(query: Record<string, unknown>) {
      if (!loginWasLaunchPage) return undefined;
      loginWasLaunchPage = false;
      const entry = resolveCabinetEntry(query);
      const target = Object.prototype.hasOwnProperty.call(query, "q") ? entry : resolvePickupLoginTarget(query) ?? entry;
      if (target) return {
        kind: "page" as const,
        url: target.mode === "query" ? buildDeviceQueryUrl(target.deviceCode) : buildPickupDeviceUrl(target.deviceCode)
      };
      return { kind: "tab" as const, url: "/pages/tabs/primary" };
    }
  };
};

export const guestLaunchGuard = createGuestLaunchGuard();
