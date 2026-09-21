import { buildPickupLoginUrl } from "./cabinet-entry";

export const resolveGuestPickupLoginUrl = async (
  entry: { deviceCode?: string; scanned?: boolean },
  scan: () => Promise<string>
) => {
  try {
    // 已经从柜机二维码进入的游客不重复扫码；普通浏览入口必须先扫码。
    const deviceCode = entry.scanned && entry.deviceCode ? entry.deviceCode : await scan();
    return deviceCode ? buildPickupLoginUrl(deviceCode) : undefined;
  } catch (error) {
    const message = (error as { errMsg?: string })?.errMsg;
    if (typeof message === "string" && /cancel/i.test(message)) return undefined;
    throw error;
  }
};
