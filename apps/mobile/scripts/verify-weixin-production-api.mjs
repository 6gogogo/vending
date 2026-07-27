import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedApiBaseUrl = "https://vending.5gogogo.top/api";
const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const clientBundlePath = resolve(
  scriptDirectory,
  "../dist/build/mp-weixin/api/client.js"
);

if (!existsSync(clientBundlePath)) {
  throw new Error(`未找到微信小程序 API 构建产物：${clientBundlePath}`);
}

const clientBundle = readFileSync(clientBundlePath, "utf8");

if (!clientBundle.includes(expectedApiBaseUrl)) {
  throw new Error(
    `微信体验版构建产物未固化公网 API ${expectedApiBaseUrl}，请检查 apps/mobile/.env.production。`
  );
}

console.log(`微信小程序构建产物已固化公网 API：${expectedApiBaseUrl}`);
