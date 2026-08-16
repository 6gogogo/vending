import assert from "node:assert/strict";
import test from "node:test";

import {
  NEARBY_GOODS_PREVIEW_LIMIT,
  buildNearbyGoodsPresentation,
  getNearbyGoodsAvailability
} from "./nearby-goods-presentation";

test("附近柜机默认最多展示三种物资", () => {
  const goods = Array.from({ length: 12 }, (_, index) => `物资 ${index + 1}`);
  const result = buildNearbyGoodsPresentation(goods);

  assert.equal(NEARBY_GOODS_PREVIEW_LIMIT, 3);
  assert.deepEqual(result.previewGoods, ["物资 1", "物资 2", "物资 3"]);
  assert.equal(result.hiddenGoodsCount, 9);
});

test("附近柜机物资少于展示上限时不会出现隐藏数量", () => {
  const result = buildNearbyGoodsPresentation(["物资 1", "物资 2"]);

  assert.deepEqual(result.previewGoods, ["物资 1", "物资 2"]);
  assert.equal(result.hiddenGoodsCount, 0);
});

test("附近柜机超大物资列表仍保持固定预览数量", () => {
  const goods = Array.from({ length: 10_000 }, (_, index) => index);
  const result = buildNearbyGoodsPresentation(goods);

  assert.equal(result.previewGoods.length, 3);
  assert.equal(result.hiddenGoodsCount, 9_997);
});

test("树状额度概览不把同一共享池重复显示为逐商品可领取数", () => {
  const quota = {
    taxonomyRevision: 3,
    remainingByGoods: { sandwich: 2, noodles: 2 }
  };

  assert.deepEqual(
    getNearbyGoodsAvailability({ goodsId: "sandwich", stock: 6 }, quota),
    { stock: 6, available: undefined }
  );
  assert.deepEqual(
    getNearbyGoodsAvailability({ goodsId: "noodles", stock: 8 }, quota),
    { stock: 8, available: undefined }
  );
});

test("旧逐商品额度仍在附近柜机概览显示真实可领取数", () => {
  assert.deepEqual(
    getNearbyGoodsAvailability(
      { goodsId: "water", stock: 5 },
      { remainingByGoods: { water: 2 } }
    ),
    { stock: 5, available: 2 }
  );
});
