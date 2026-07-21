import type { GoodsCategory, OperationLogStatus, UserRole } from "@vm/shared-types";

export const categoryLabelMap: Record<GoodsCategory, string> = {
  food: "食品",
  drink: "饮料",
  daily: "日用品"
};

export const roleLabelMap: Record<UserRole, string> = {
  admin: "管理员",
  merchant: "商家",
  special: "用户"
};

export const operationLogStatusLabelMap: Record<OperationLogStatus, string> = {
  success: "成功",
  pending: "处理中",
  warning: "警告",
  failed: "失败"
};
