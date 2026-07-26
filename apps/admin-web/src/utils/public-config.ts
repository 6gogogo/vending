import type { PublicRuntimeConfig } from "@vm/shared-types";

import { adminApiBaseUrl } from "../api/client";

export type AdminPublicConfig = PublicRuntimeConfig;

export const loadPublicRuntimeConfig = async (): Promise<AdminPublicConfig> => {
  const response = await fetch(`${adminApiBaseUrl}/public-config`);
  const parsed = (await response.json()) as {
    code: number;
    message: string;
    data?: AdminPublicConfig;
  };

  if (!response.ok || parsed.code !== 200) {
    throw new Error(parsed.message || "读取公开运行配置失败");
  }

  return parsed.data ?? {};
};
