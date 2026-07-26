import assert from "node:assert/strict";
import test from "node:test";

import {
  isStockOperatorRole,
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
