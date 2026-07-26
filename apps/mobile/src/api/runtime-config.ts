import type { PublicRuntimeConfig } from "@vm/shared-types";

import { mobileClient } from "./client";

export type MobilePublicConfig = PublicRuntimeConfig;

let publicConfigRequest: Promise<MobilePublicConfig> | undefined;

export const loadMobileRuntimeConfig = async (): Promise<MobilePublicConfig> => {
  publicConfigRequest ??= mobileClient.get<MobilePublicConfig>("/public-config");

  try {
    return await publicConfigRequest;
  } catch (error) {
    publicConfigRequest = undefined;
    throw error;
  }
};
