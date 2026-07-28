import type { PublicRuntimeConfig } from "@vm/shared-types";

import { mobileClient } from "./client";
import {
  createCachedAsyncLoader,
  type CachedAsyncLoadOptions
} from "../utils/runtime-config-loader";

export type MobilePublicConfig = PublicRuntimeConfig;

const mobileRuntimeConfigLoader = createCachedAsyncLoader(() =>
  mobileClient.get<MobilePublicConfig>("/public-config")
);

export const loadMobileRuntimeConfig = (
  options?: CachedAsyncLoadOptions
): Promise<MobilePublicConfig> => mobileRuntimeConfigLoader.load(options);
