import assert from "node:assert/strict";
import test from "node:test";

import {
  isStockOperatorRole,
  resolveTabIconPath,
  roleTabIcons,
  roleTabLabels,
  syncRoleTabBar
} from "./role-routing";

test("商家与补货员共用库存作业入口，但管理员和普通用户不属于补货角色", () => {
  assert.equal(isStockOperatorRole("merchant"), true);
  assert.equal(isStockOperatorRole("restocker"), true);
  assert.equal(isStockOperatorRole("admin"), false);
  assert.equal(isStockOperatorRole("special"), false);
});

test("补货员使用独立身份文案并进入补货作业标签", () => {
  assert.deepEqual(roleTabLabels.restocker, [
    "首页",
    "补货",
    "记录",
    "我的"
  ]);
});

test("底部导航图标使用相对静态资源路径，兼容部署在 /mobile/ 子路径", () => {
  for (const icons of Object.values(roleTabIcons)) {
    for (const icon of icons) {
      assert.equal(icon.iconPath.startsWith("/"), false);
      assert.equal(icon.selectedIconPath.startsWith("/"), false);
    }
  }

  assert.equal(
    resolveTabIconPath("static/tabs/home.png", "/mobile/"),
    "/mobile/static/tabs/home.png"
  );
  assert.equal(
    resolveTabIconPath("static/tabs/home.png", "/"),
    "/static/tabs/home.png"
  );
});

test("登录等非底部导航页面不会调用底部导航接口", () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
    getCurrentPages?: () => Array<{ route?: string }>;
  };
  const originalUni = runtimeGlobals.uni;
  const originalGetCurrentPages = runtimeGlobals.getCurrentPages;
  let styleCallCount = 0;

  runtimeGlobals.uni = {
    setTabBarStyle: () => {
      styleCallCount += 1;
    }
  };
  runtimeGlobals.getCurrentPages = () => [
    { route: "pages/common/app-login" }
  ];

  try {
    syncRoleTabBar("special");
    assert.equal(styleCallCount, 0);
  } finally {
    runtimeGlobals.uni = originalUni;
    runtimeGlobals.getCurrentPages = originalGetCurrentPages;
  }
});

test("进入底部导航页面后仍会同步当前角色样式", () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
    getCurrentPages?: () => Array<{ route?: string }>;
  };
  const originalUni = runtimeGlobals.uni;
  const originalGetCurrentPages = runtimeGlobals.getCurrentPages;
  let styleCallCount = 0;

  runtimeGlobals.uni = {
    setTabBarStyle: () => {
      styleCallCount += 1;
    }
  };
  runtimeGlobals.getCurrentPages = () => [
    { route: "pages/tabs/primary" }
  ];

  try {
    syncRoleTabBar("special");
    assert.equal(styleCallCount, 1);
  } finally {
    runtimeGlobals.uni = originalUni;
    runtimeGlobals.getCurrentPages = originalGetCurrentPages;
  }
});
