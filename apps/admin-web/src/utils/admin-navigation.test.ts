import assert from "node:assert/strict";
import test from "node:test";
import type { BackofficePermission } from "@vm/shared-types";
import { adminDestinations, canAccessAdminDestination, canAccessAdminSection, isAdminDestinationActive, resolveWorkspaceSection } from "./admin-navigation";

test("详情页匹配所属菜单，分类树不会误选货品菜单", () => {
  assert.equal(isAdminDestinationActive("/goods/item-1", "/goods"), true);
  assert.equal(isAdminDestinationActive("/goods-taxonomy", "/goods"), false);
  assert.equal(isAdminDestinationActive("/users-old", "/users"), false);
});

test("未知、数组和无权限的分区回落到可用入口", () => {
  assert.equal(resolveWorkspaceSection("rules", ["directory", "rules"]), "rules");
  assert.equal(resolveWorkspaceSection("rules", ["directory"]), "directory");
  assert.equal(resolveWorkspaceSection(["directory", "rules"], ["directory"]), "directory");
  assert.equal(resolveWorkspaceSection(undefined, []), "");
});

test("导航与检索同时遵守角色和服务端会话权限", () => {
  const permissions = new Set<BackofficePermission>(["devices:view", "users:view", "merchant-workbench:view"]);
  const can = (permission: BackofficePermission) => permissions.has(permission);
  const visible = (role: "admin" | "merchant" | "restocker" | undefined) => adminDestinations.filter(item => canAccessAdminDestination(item, role, can)).map(item => item.path);
  assert.deepEqual(visible("restocker"), ["/operations", "/manual"]);
  assert.deepEqual(visible("merchant"), ["/merchant", "/operations", "/manual"]);
  assert.deepEqual(visible("admin"), ["/users", "/operations", "/manual"]);
  assert.deepEqual(visible(undefined), []);
});

test("功能搜索不会向只读人员账号展示审核、地区维护和验证码管理", () => {
  const sections = adminDestinations.find(item => item.path === "/users")!.sections!;
  const readonly = (permission: BackofficePermission) => permission === "users:view";
  assert.deepEqual(sections.filter(section => canAccessAdminSection(section, readonly)).map(section => section.value), ["directory", "setup"]);
  const reviewer = (permission: BackofficePermission) => permission === "users:view" || permission === "users:review";
  assert.deepEqual(sections.filter(section => canAccessAdminSection(section, reviewer)).map(section => section.value), ["directory", "registrations", "rules"]);
});
