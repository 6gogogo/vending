import { mobileClient } from "./client";

export interface MobilePublicConfig {
  runtimeDataPlane?: "simulation" | "live";
}

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
