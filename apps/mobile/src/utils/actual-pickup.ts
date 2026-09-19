import type { CabinetEventRecord, CabinetOpenRequest } from "@vm/shared-types";

/** 新版扫码只请求开门，商品与数量由平台结算回调决定。 */
export const buildActualPickupRequest = (phone: string, deviceCode: string): CabinetOpenRequest => ({
  phone, deviceCode, doorNum: "1", openMode: "scan", pickupMode: "actual"
});

export const matchesActualPickupEvent = (
  event: CabinetEventRecord, userId: string, request: CabinetOpenRequest
) => event.userId === userId && event.deviceCode === request.deviceCode &&
  event.doorNum === (request.doorNum || "1") && event.pickupMode === "actual";
