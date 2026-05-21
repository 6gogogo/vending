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

const roleTabIcons: Record<UserRole, Array<{ iconPath: string; selectedIconPath: string }>> = {
  special: [
    { iconPath: "/static/tabs/home.png", selectedIconPath: "/static/tabs/home-active.png" },
    { iconPath: "/static/tabs/nearby.png", selectedIconPath: "/static/tabs/nearby-active.png" },
    { iconPath: "/static/tabs/records.png", selectedIconPath: "/static/tabs/records-active.png" },
    { iconPath: "/static/tabs/settings-tab.png", selectedIconPath: "/static/tabs/settings-tab-active.png" }
  ],
  merchant: [
    { iconPath: "/static/tabs/home.png", selectedIconPath: "/static/tabs/home-active.png" },
    { iconPath: "/static/tabs/restock.png", selectedIconPath: "/static/tabs/restock-active.png" },
    { iconPath: "/static/tabs/records.png", selectedIconPath: "/static/tabs/records-active.png" },
    { iconPath: "/static/tabs/settings-tab.png", selectedIconPath: "/static/tabs/settings-tab-active.png" }
  ],
  admin: [
    { iconPath: "/static/tabs/home.png", selectedIconPath: "/static/tabs/home-active.png" },
    { iconPath: "/static/tabs/device.png", selectedIconPath: "/static/tabs/device-active.png" },
    { iconPath: "/static/tabs/records.png", selectedIconPath: "/static/tabs/records-active.png" },
    { iconPath: "/static/tabs/settings-tab.png", selectedIconPath: "/static/tabs/settings-tab-active.png" }
  ]
};

const roleTabSelectedColor: Record<UserRole, string> = {
  special: "#2E7D46",
  merchant: "#FF8A2B",
  admin: "#2E7D46"
};

export const resolveHomePath = (_role?: UserRole) => sharedTabPaths[0];

export const syncRoleTabBar = (role?: UserRole) => {
  if (!role) {
    return;
  }

  const labels = roleTabLabels[role];
  const icons = roleTabIcons[role];

  if (typeof uni.setTabBarStyle === "function") {
    uni.setTabBarStyle({
      color: "#6C6257",
      selectedColor: roleTabSelectedColor[role],
      backgroundColor: "#FFFFFF",
      borderStyle: "white"
    });
  }

  labels.forEach((text, index) => {
    if (typeof uni.setTabBarItem !== "function") {
      return;
    }

    uni.setTabBarItem({
      index,
      text,
      ...icons[index]
    });
  });
};
