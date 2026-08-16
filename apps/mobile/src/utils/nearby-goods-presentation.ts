export const NEARBY_GOODS_PREVIEW_LIMIT = 3;

type NearbyQuotaSummary = {
  taxonomyRevision?: number;
  remainingByGoods?: Record<string, number>;
};

const normalizeQuantity = (value: number | undefined) =>
  Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 0;

export const getNearbyGoodsAvailability = (
  goods: { goodsId: string; stock: number },
  quota?: NearbyQuotaSummary
) => ({
  stock: normalizeQuantity(goods.stock),
  // 树状额度可能由多个商品共享同一父级池；概览不得把共享余额复制成逐商品余额。
  available:
    quota?.taxonomyRevision === undefined
      ? normalizeQuantity(quota?.remainingByGoods?.[goods.goodsId])
      : undefined
});

export const buildNearbyGoodsPresentation = <T>(
  goods: readonly T[],
  previewLimit = NEARBY_GOODS_PREVIEW_LIMIT
) => {
  const normalizedLimit = Math.max(0, Math.floor(previewLimit));

  return {
    previewGoods: goods.slice(0, normalizedLimit),
    hiddenGoodsCount: Math.max(0, goods.length - normalizedLimit)
  };
};
