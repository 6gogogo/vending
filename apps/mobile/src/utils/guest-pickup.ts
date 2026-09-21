import { buildPickupDeviceUrl, buildPickupLoginUrl } from "./cabinet-entry";

export const resolveGuestPrimaryActionUrl = async (
  entry: { deviceCode?: string; scanned?: boolean },
  scan: () => Promise<string>
) => {
  try {
    // 扫码只进入浏览；在已扫码页面主动点击开门才进入登录，不发开门请求。
    if (entry.scanned && entry.deviceCode) return buildPickupLoginUrl(entry.deviceCode);
    const deviceCode = await scan();
    return deviceCode ? buildPickupDeviceUrl(deviceCode) : undefined;
  } catch (error) {
    const message = (error as { errMsg?: string })?.errMsg;
    if (typeof message === "string" && /cancel/i.test(message)) return undefined;
    throw error;
  }
};
