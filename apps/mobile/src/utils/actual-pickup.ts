import type { CabinetEventRecord, CabinetOpenRequest, MobileSessionSnapshot } from "@vm/shared-types";

export const getDailyPickupState = (quota: MobileSessionSnapshot["quota"]) => {
  const used = quota?.dailyPickup?.used ?? ((quota?.usedCount ?? 0) > 0 ? 1 : 0);
  const remaining = quota?.dailyPickup?.remaining ?? (used ? 0 : 1);
  const availableQuantity = quota?.remainingFreeTotal ?? quota?.remainingDaily ?? 0;
  return { used, remaining, canPickup: remaining > 0 && availableQuantity > 0 };
};

/** 新版扫码只请求开门，商品与数量由平台结算回调决定。 */
export const buildActualPickupRequest = (phone: string, deviceCode: string): CabinetOpenRequest => ({
  phone, deviceCode, doorNum: "1", openMode: "scan", pickupMode: "actual"
});

export const matchesActualPickupEvent = (
  event: CabinetEventRecord, userId: string, request: CabinetOpenRequest
) => event.userId === userId && event.deviceCode === request.deviceCode &&
  event.doorNum === (request.doorNum || "1") && event.pickupMode === "actual";
