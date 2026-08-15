import assert from "node:assert/strict";
import test from "node:test";

import {
  NEARBY_GOODS_PREVIEW_LIMIT,
  buildNearbyGoodsPresentation
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
