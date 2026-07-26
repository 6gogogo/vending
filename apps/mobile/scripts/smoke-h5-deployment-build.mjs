import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const h5BuildRoot = fileURLToPath(new URL("../dist/build/h5/", import.meta.url));
const indexHtml = readFileSync(join(h5BuildRoot, "index.html"), "utf8");
const assetReferences = [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((reference) => reference.includes("/assets/"));

assert.ok(assetReferences.length > 0, "移动 H5 构建产物必须包含静态资源引用");
assert.ok(
  assetReferences.every((reference) => reference.startsWith("/mobile/assets/")),
  "移动 H5 部署构建的静态资源必须统一使用 /mobile/ 前缀"
);

const assetsRoot = join(h5BuildRoot, "assets");
const bundledJavaScriptFiles = readdirSync(assetsRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => ({
    name: entry.name,
    source: readFileSync(join(assetsRoot, entry.name), "utf8")
  }));
const bundledJavaScript = bundledJavaScriptFiles.map(({ source }) => source).join("\n");

assert.doesNotMatch(
  bundledJavaScript,
  /VITE_SHOW_VERIFICATION_PREVIEW/,
  "生产 H5 构建不得保留可在运行时启用验证码预览的环境开关"
);

assert.doesNotMatch(
  bundledJavaScript,
  /\bpreviewCode\b/,
  "生产 H5 构建不得保留验证码预览响应字段的数据路径"
);

console.log("mobile H5 deployment smoke: passed");
