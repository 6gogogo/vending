import { BadRequestException } from "@nestjs/common";

const isLoopbackHost = (rawHost: string) => {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
};

export const resolveTrustProxySetting = (
  rawValue?: string,
  apiHost = "127.0.0.1"
): false | number => {
  const normalized = rawValue?.trim();

  if (!normalized) {
    return false;
  }

  const hops = Number(normalized);

  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new BadRequestException("TRUST_PROXY_HOPS 必须是 1 至 10 的整数。");
  }

  if (!isLoopbackHost(apiHost)) {
    throw new BadRequestException(
      "启用 TRUST_PROXY_HOPS 时 API_HOST 必须绑定回环地址，禁止公网直连伪造转发头。"
    );
  }

  return hops;
};
