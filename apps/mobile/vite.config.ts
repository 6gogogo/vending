import { defineConfig } from "vite";
import uniPluginModule from "@dcloudio/vite-plugin-uni";
import { resolveMobileH5PublicBase } from "./src/config/h5-public-base";

const uniPlugin =
  typeof uniPluginModule === "function"
    ? uniPluginModule
    : (uniPluginModule as { default: typeof uniPluginModule }).default;

export default defineConfig({
  base:
    process.env.UNI_PLATFORM === "h5"
      ? resolveMobileH5PublicBase(process.env.VITE_MOBILE_H5_PUBLIC_BASE)
      : undefined,
  plugins: uniPlugin(),
  resolve:
    process.env.UNI_PLATFORM === "h5"
      ? {
          alias: {
            vue: "@dcloudio/uni-h5-vue"
          }
        }
      : undefined
});
