import type { EntitlementLimit } from "@vm/shared-types";

export const cloneEntitlementLimits = (
  limits: readonly EntitlementLimit[] | undefined
): EntitlementLimit[] => (limits ?? []).map((limit) => ({ ...limit }));

export const createEntitlementLimitId = (): string => {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  // 旧版浏览器和普通 HTTP 环境仍可用 getRandomValues 生成 UUID v4。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
};

export const createUserEntitlementLimit = (
  targetId = "",
  idFactory: () => string = createEntitlementLimitId
): EntitlementLimit => ({
  id: idFactory(),
  targetType: "taxonomy_node",
  targetId,
  quantity: 1
});
