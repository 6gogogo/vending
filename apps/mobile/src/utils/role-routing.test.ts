import assert from "node:assert/strict";
import test from "node:test";

import {
  isStockOperatorRole,
  resolveTabIconPath,
  roleTabIcons,
  roleTabLabels
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
