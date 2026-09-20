import type { GoodsExpiryMode } from "@vm/shared-types";

/** 登记保质期尚未核实时，可按实例配置为仅后台提醒；不改写登记日期。 */
export const getGoodsExpiryMode = (environment: NodeJS.ProcessEnv = process.env): GoodsExpiryMode => {
  const mode = environment.VM_GOODS_EXPIRY_MODE?.trim() || "enforced";
  if (mode !== "enforced" && mode !== "warning_only") {
    throw new Error("VM_GOODS_EXPIRY_MODE 只支持 enforced 或 warning_only。");
  }
  return mode;
};
