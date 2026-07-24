/**
 * 预约取货模式只允许特殊群体凭有效预约开柜。它不移除历史支付账本，
 * 但会阻断新的付款链路，避免当前公益领取流程产生应付金额。
 */
export const RESERVATION_ONLY_PICKUP_ENV_KEY = "VM_RESERVATION_ONLY_PICKUP";

const truthyValues = new Set(["1", "true", "yes", "on"]);

export const isReservationOnlyPickup = (
  environment: Partial<Pick<NodeJS.ProcessEnv, typeof RESERVATION_ONLY_PICKUP_ENV_KEY>> = process.env
) =>
  truthyValues.has(
    environment[RESERVATION_ONLY_PICKUP_ENV_KEY]?.trim().toLowerCase() ?? ""
  );
