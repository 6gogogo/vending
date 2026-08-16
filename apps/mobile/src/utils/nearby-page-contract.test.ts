import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { appCopy } from "../constants/copy";

const nearbyPagePath = new URL("../pages/tabs/nearby.vue", import.meta.url);
const manifestPath = new URL("../manifest.json", import.meta.url);

test("特殊用户附近柜机保持预约与扫码并列且不再展示找柜机提示", async () => {
  const source = await readFile(nearbyPagePath, "utf8");

  assert.match(source, /appCopy\.nearbyCabinets/);
  assert.equal(appCopy.nearbyCabinets.specialSubtitle, "可提前预约保留物资，也可到柜扫码直接领取。");
  assert.equal(appCopy.nearbyCabinets.choice.reserve, "提前预约 · 保留物资");
  assert.equal(appCopy.nearbyCabinets.choice.scan, "到柜扫码 · 直接领取");
  assert.match(
    source,
    /\.nearby-choice-summary text\s*\{[\s\S]*?white-space:\s*nowrap;/,
    "预约与扫码两个并列入口在手机宽度下必须保持单行"
  );
  assert.doesNotMatch(source, /找柜机提示/);
});

test("特殊用户柜机卡片只渲染有限预览并提供完整物资抽屉", async () => {
  const source = await readFile(nearbyPagePath, "utf8");

  assert.match(source, /entry\.previewGoods/);
  assert.match(source, /nearbyCopy\.goods\.viewAll\(entry\.visibleGoods\.length\)/);
  assert.match(source, /class="nearby-goods-sheet__list" scroll-y/);
});

test("树状额度概览不直接把共享余额渲染为逐商品额度", async () => {
  const source = await readFile(nearbyPagePath, "utf8");

  assert.match(source, /getNearbyGoodsAvailability\(goods, sessionStore\.quota\)/);
  assert.doesNotMatch(source, /remainingByGoods\?\.\[goods\.goodsId\]/);
});

test("微信构建声明前台手机定位权限", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    "mp-weixin"?: {
      permission?: Record<string, { desc?: string }>;
      requiredPrivateInfos?: string[];
    };
  };

  assert.equal(
    manifest["mp-weixin"]?.permission?.["scope.userLocation"]?.desc,
    "用于按距离展示附近柜机"
  );
  assert.ok(manifest["mp-weixin"]?.requiredPrivateInfos?.includes("getLocation"));
});
