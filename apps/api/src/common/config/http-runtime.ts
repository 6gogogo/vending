import { BadRequestException } from "@nestjs/common";

export const resolveTrustProxySetting = (rawValue?: string): false | number => {
  const normalized = rawValue?.trim();

  if (!normalized) {
    return false;
  }

  const hops = Number(normalized);

  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new BadRequestException("TRUST_PROXY_HOPS 必须是 1 至 10 的整数。");
  }

  return hops;
};
