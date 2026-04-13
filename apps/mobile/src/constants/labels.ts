import type { GoodsCategory, UserRole } from "@vm/shared-types";

export const categoryLabelMap: Record<GoodsCategory, string> = {
  food: "食品",
  drink: "饮料",
  daily: "日用品"
};

export const roleLabelMap: Record<UserRole, string> = {
  admin: "管理员",
  merchant: "爱心商户",
  special: "普通用户"
};
