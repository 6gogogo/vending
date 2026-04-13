import type { UserRole } from "@vm/shared-types";

export const sharedTabPaths = [
  "/pages/tabs/primary",
  "/pages/tabs/nearby",
  "/pages/tabs/records",
  "/pages/tabs/settings"
] as const;

export const roleTabLabels: Record<UserRole, [string, string, string, string]> = {
  special: ["验证领取", "附近柜机", "领取详情", "设置"],
  merchant: ["模板补货", "附近柜机", "货物流向", "设置"],
  admin: ["待办事件", "柜机列表", "人员日志", "设置"]
};

export const resolveHomePath = (_role?: UserRole) => sharedTabPaths[0];

export const syncRoleTabBar = (role?: UserRole) => {
  if (!role) {
    return;
  }

  const labels = roleTabLabels[role];

  labels.forEach((text, index) => {
    if (typeof uni.setTabBarItem !== "function") {
      return;
    }

    uni.setTabBarItem({
      index,
      text
    });
  });
};
