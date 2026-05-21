import { defineConfig } from "vite";
import uniPluginModule from "@dcloudio/vite-plugin-uni";

const uniPlugin =
  typeof uniPluginModule === "function"
    ? uniPluginModule
    : (uniPluginModule as { default: typeof uniPluginModule }).default;

export default defineConfig({
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
