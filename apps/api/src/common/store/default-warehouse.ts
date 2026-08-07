import type { WarehouseRecord } from "@vm/shared-types";

export const DEFAULT_WAREHOUSE_CODE = "WAREHOUSE-LOCAL";
export const DEFAULT_WAREHOUSE_NAME = "本地仓库";

export const findActiveWarehouse = (warehouses: readonly WarehouseRecord[]) =>
  warehouses.find((warehouse) => warehouse.status === "active");

/**
 * 真实实例至少需要一个启用仓库，货品总览和库存调拨都以它作为本地库存入口。
 * 已有但全部停用时不擅自改变运营状态，必须由人工确认后另行处理。
 */
export const ensureDefaultWarehouse = (
  warehouses: WarehouseRecord[],
  now = new Date().toISOString()
) => {
  const existing = findActiveWarehouse(warehouses);

  if (existing) {
    return {
      created: false as const,
      warehouse: existing
    };
  }

  if (warehouses.length > 0) {
    throw new Error("检测到仓库记录但均已停用，已拒绝自动改变仓库运营状态。");
  }

  const warehouse: WarehouseRecord = {
    code: DEFAULT_WAREHOUSE_CODE,
    name: DEFAULT_WAREHOUSE_NAME,
    status: "active",
    createdAt: now,
    updatedAt: now
  };

  warehouses.push(warehouse);

  return {
    created: true as const,
    warehouse
  };
};
