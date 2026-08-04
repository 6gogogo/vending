import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveVisibleRoleManualIds,
  roleManualOrder,
  roleManuals
} from "./role-manual";

test("服务商可查看全部分角色手册", () => {
  assert.deepEqual(resolveVisibleRoleManualIds("super_admin"), roleManualOrder);
});

test("实例角色只能查看自己及下级角色手册", () => {
  assert.deepEqual(resolveVisibleRoleManualIds("admin"), [
    "admin",
    "merchant",
    "restocker",
    "app"
  ]);
  assert.deepEqual(resolveVisibleRoleManualIds("merchant"), [
    "merchant",
    "restocker",
    "app"
  ]);
  assert.deepEqual(resolveVisibleRoleManualIds("restocker"), ["restocker", "app"]);
  assert.deepEqual(resolveVisibleRoleManualIds(undefined), []);
});

test("用户手册只保留操作步骤和故障处理文案", () => {
  for (const manual of Object.values(roleManuals)) {
    const source = JSON.stringify(manual);
    assert.doesNotMatch(source, /设计自述|验收|数据平面|生产门禁/u);
    assert.ok(manual.sections.every((section) => section.steps.length > 0));
  }
});

test("实例内角色手册不暴露服务商身份", () => {
  for (const manualId of ["admin", "merchant", "restocker", "app"] as const) {
    assert.doesNotMatch(JSON.stringify(roleManuals[manualId]), /服务提供商|服务商/u);
  }
});
