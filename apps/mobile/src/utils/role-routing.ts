import type { UserRole } from "@vm/shared-types";

export const sharedTabPaths = [
  "/pages/tabs/primary",
  "/pages/tabs/nearby",
  "/pages/tabs/records",
  "/pages/tabs/settings"
] as const;

export const roleTabLabels: Record<UserRole, [string, string, string, string]> = {
  special: ["首页", "附近柜机", "记录", "我的"],
  merchant: ["首页", "补货", "记录", "我的"],
  admin: ["首页", "柜机", "记录", "我的"]
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
