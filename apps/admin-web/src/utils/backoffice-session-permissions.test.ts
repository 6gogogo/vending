import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFFICE_PROVIDER_PERMISSIONS,
  BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS
} from "@vm/shared-types";

import {
  hasBackofficeRouteAccess,
  hasBackofficeRouteRole,
  resolveBackofficeDefaultPath,
  resolveBackofficeSessionPermissions
} from "../stores/session";

test("服务商平台会话以前端下发的权限为上限，不展示实例业务权限", () => {
  const permissions = resolveBackofficeSessionPermissions(BACKOFFICE_PROVIDER_PERMISSIONS);

  assert.equal(permissions.includes("devices:view"), false);
  assert.deepEqual(permissions, [...BACKOFFICE_PROVIDER_PERMISSIONS]);
});

test("服务商进入实例后仅显示服务端为该实例下发的引导权限", () => {
  const permissions = resolveBackofficeSessionPermissions(BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS);

  assert.equal(permissions.includes("platform-overview:view"), false);
  assert.deepEqual(permissions, [...BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS]);
});

test("缺失服务端会话权限时前端保持关闭式菜单与路由控制", () => {
  assert.deepEqual(resolveBackofficeSessionPermissions(undefined), []);
});

test("管理员不会因误下发商家工作台权限而进入商家个人工作台", () => {
  assert.equal(
    resolveBackofficeDefaultPath("admin", ["merchant-workbench:view"]),
    "/login"
  );
  assert.equal(hasBackofficeRouteRole("admin", ["merchant"]), false);
});

test("商家工作台路由同时要求商家角色和会话权限", () => {
  assert.equal(
    hasBackofficeRouteAccess(
      "admin",
      ["merchant-workbench:view"],
      ["merchant-workbench:view"],
      ["merchant"]
    ),
    false
  );
  assert.equal(
    hasBackofficeRouteAccess(
      "merchant",
      ["merchant-workbench:view"],
      ["merchant-workbench:view"],
      ["merchant"]
    ),
    true
  );
  assert.equal(
    hasBackofficeRouteAccess("merchant", [], ["merchant-workbench:view"], ["merchant"]),
    false
  );
});

test("商家与补货员按各自角色进入可用的首个后台页面", () => {
  assert.equal(
    resolveBackofficeDefaultPath("merchant", ["merchant-workbench:view"]),
    "/merchant"
  );
  assert.equal(resolveBackofficeDefaultPath("restocker", ["devices:view"]), "/operations");
});

test("服务商与实例态超级管理员按会话权限进入对应工作台", () => {
  assert.equal(resolveBackofficeDefaultPath("super_admin", BACKOFFICE_PROVIDER_PERMISSIONS), "/platform");
  assert.equal(
    resolveBackofficeDefaultPath("super_admin", BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS),
    "/operations"
  );
});
