import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedApiBaseUrl = "https://vending.5gogogo.top/api";
const maxLocalSourceBytes = 1.5 * 1024 * 1024;
const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = resolve(scriptDirectory, "../src/manifest.json");
const buildOutputPath = resolve(scriptDirectory, "../dist/build/mp-weixin");
const projectConfigPath = resolve(
  buildOutputPath,
  "project.config.json"
);
const clientBundlePath = resolve(
  buildOutputPath,
  "api/client.js"
);

const getDirectorySize = (directoryPath) =>
  readdirSync(directoryPath, { withFileTypes: true }).reduce(
    (totalBytes, entry) => {
      const entryPath = resolve(directoryPath, entry.name);
      return (
        totalBytes +
        (entry.isDirectory() ? getDirectorySize(entryPath) : statSync(entryPath).size)
      );
    },
    0
  );

if (!existsSync(manifestPath)) {
  throw new Error(`未找到微信小程序 manifest 配置：${manifestPath}`);
}

if (!existsSync(projectConfigPath)) {
  throw new Error(`未找到微信小程序项目配置产物：${projectConfigPath}`);
}

if (!existsSync(clientBundlePath)) {
  throw new Error(`未找到微信小程序 API 构建产物：${clientBundlePath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expectedAppId = manifest["mp-weixin"]?.appid;
const builtProjectConfig = JSON.parse(readFileSync(projectConfigPath, "utf8"));
const clientBundle = readFileSync(clientBundlePath, "utf8");
const localSourceBytes = getDirectorySize(buildOutputPath);

if (typeof expectedAppId !== "string" || expectedAppId.length === 0) {
  throw new Error(
    "apps/mobile/src/manifest.json 缺少 mp-weixin.appid，无法生成可上传的微信小程序产物。"
  );
}

if (builtProjectConfig.appid !== expectedAppId) {
  throw new Error(
    `微信小程序构建产物 AppID 不匹配：期望 ${expectedAppId}，实际 ${builtProjectConfig.appid ?? "未设置"}。`
  );
}

if (!clientBundle.includes(expectedApiBaseUrl)) {
  throw new Error(
    `微信体验版构建产物未固化公网 API ${expectedApiBaseUrl}，请检查 apps/mobile/.env.production。`
  );
}

if (localSourceBytes > maxLocalSourceBytes) {
  throw new Error(
    `微信小程序生产构建目录过大：${(localSourceBytes / 1024).toFixed(2)} KiB，` +
      `必须控制在 ${(maxLocalSourceBytes / 1024).toFixed(0)} KiB 以内，为开发者工具上传处理预留空间。`
  );
}

console.log(`微信小程序构建产物 AppID 已校验：${expectedAppId}`);
console.log(`微信小程序构建产物已固化公网 API：${expectedApiBaseUrl}`);
console.log(
  `微信小程序生产构建大小已校验：${(localSourceBytes / 1024).toFixed(2)} KiB`
);
