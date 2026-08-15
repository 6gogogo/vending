export const NEARBY_GOODS_PREVIEW_LIMIT = 3;

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
