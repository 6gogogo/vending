import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFFICE_PROVIDER_PERMISSIONS,
  BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS
} from "@vm/shared-types";

import { resolveBackofficeSessionPermissions } from "../stores/session";

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
