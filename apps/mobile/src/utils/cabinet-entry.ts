import type { UserRole } from "@vm/shared-types";

export type CabinetEntryMode = "pickup" | "reservation";

export interface CabinetEntry {
  deviceCode: string;
  mode: CabinetEntryMode;
}

export interface PickupLoginTarget {
  deviceCode: string;
}

const DEVICE_CODE_PATTERN = /^[A-Za-z0-9-]+$/;
const WECHAT_CABINET_QR_PATTERN =
  /^https:\/\/vending\.5gogogo\.top\/cabinet\/([A-Za-z0-9-]+)\/?$/;

export const normalizeDeviceCode = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim();
  return DEVICE_CODE_PATTERN.test(normalized) ? normalized : "";
};

export const parseWechatCabinetQr = (value: unknown) => {
  if (typeof value !== "string" || !value) {
    return "";
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "";
  }

  return decoded.match(WECHAT_CABINET_QR_PATTERN)?.[1] ?? "";
};

export const resolveCabinetEntry = (query: Record<string, unknown>): CabinetEntry | undefined => {
  if (Object.prototype.hasOwnProperty.call(query, "q")) {
    const deviceCode = parseWechatCabinetQr(query.q);
    return deviceCode ? { deviceCode, mode: "pickup" } : undefined;
  }

  const deviceCode = normalizeDeviceCode(query.deviceCode);
  if (!deviceCode) {
    return undefined;
  }

  return {
    deviceCode,
    mode: query.scan === "1" ? "pickup" : "reservation"
  };
};

const requireDeviceCode = (deviceCode: string) => {
  const normalized = normalizeDeviceCode(deviceCode);
  if (!normalized) {
    throw new Error("柜机编号格式无效。");
  }
  return encodeURIComponent(normalized);
};

export const buildPickupLoginUrl = (deviceCode: string) =>
  `/pages/common/app-login?entry=pickup&deviceCode=${requireDeviceCode(deviceCode)}`;

export const buildPickupDeviceUrl = (deviceCode: string) =>
  `/pages/special/device-detail?deviceCode=${requireDeviceCode(deviceCode)}&scan=1`;

export const resolvePickupLoginTarget = (
  query: Record<string, unknown>
): PickupLoginTarget | undefined => {
  if (query.entry !== "pickup") {
    return undefined;
  }

  const deviceCode = normalizeDeviceCode(query.deviceCode);
  return deviceCode ? { deviceCode } : undefined;
};

export const resolvePickupPostLoginUrl = (
  role: UserRole,
  target?: PickupLoginTarget
) => role === "special" && target ? buildPickupDeviceUrl(target.deviceCode) : undefined;
