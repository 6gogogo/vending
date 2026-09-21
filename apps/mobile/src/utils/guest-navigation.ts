import { buildDeviceQueryUrl, buildPickupDeviceUrl, type PickupLoginTarget } from "./cabinet-entry";

export const resolveGuestReturnTab = (value: unknown) =>
  value === "records" ? "/pages/tabs/records"
    : value === "settings" ? "/pages/tabs/settings"
      : "/pages/tabs/primary";

export const resolveBrowseReturn = (target?: PickupLoginTarget, returnTab?: unknown) =>
  target
    ? { kind: "page" as const, url: target.mode === "query"
        ? buildDeviceQueryUrl(target.deviceCode) : buildPickupDeviceUrl(target.deviceCode) }
    : { kind: "tab" as const, url: resolveGuestReturnTab(returnTab) };

export const resumeGuestBrowsing = (session: {
  pickupTarget?: PickupLoginTarget;
  setPickupTarget: (target?: PickupLoginTarget) => void;
}, returnTab?: unknown) => {
  const destination = resolveBrowseReturn(session.pickupTarget, returnTab);
  // 取消登录即撤销这次待办，避免以后从其他入口登录时意外回到旧柜机。
  session.setPickupTarget(undefined);
  if (destination.kind === "page") uni.redirectTo({ url: destination.url });
  else uni.switchTab({ url: destination.url });
};
