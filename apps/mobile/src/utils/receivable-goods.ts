import type { DeviceRecord, MobileSessionSnapshot } from "@vm/shared-types";

type QuotaSummary = MobileSessionSnapshot["quota"];

const getRemainingByGoods = (quota?: QuotaSummary) => quota?.remainingByGoods ?? {};

export const getReceivableLimit = (quota: QuotaSummary | undefined, goodsId: string) =>
  getRemainingByGoods(quota)[goodsId] ?? 0;

export const getReceivableDeviceGoods = (device: DeviceRecord, quota: QuotaSummary | undefined) =>
  device.doors
    .flatMap((door) => door.goods)
    .filter((goods) => (goods.stock ?? 0) > 0);

export const getReceivableGoodsOptions = (
  quota: QuotaSummary | undefined,
  devices: DeviceRecord[]
) => {
  const options = new Map<string, { goodsId: string; goodsName: string }>();

  for (const window of quota?.activeWindows ?? []) {
    for (const goods of window.goodsLimits) {
      if (getReceivableLimit(quota, goods.goodsId) > 0) {
        options.set(goods.goodsId, {
          goodsId: goods.goodsId,
          goodsName: goods.goodsName
        });
      }
    }
  }

  for (const device of devices) {
    for (const goods of getReceivableDeviceGoods(device, quota)) {
      if (!options.has(goods.goodsId)) {
        options.set(goods.goodsId, {
          goodsId: goods.goodsId,
          goodsName: goods.name
        });
      }
    }
  }

  return Array.from(options.values());
};
