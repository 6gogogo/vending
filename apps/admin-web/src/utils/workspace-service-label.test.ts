import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTenantEntryAction,
  resolveTenantLifecycleLabel,
  resolveWorkspaceServiceLabel
} from "./workspace-service-label";

test("服务商平台身份始终显示为正式平台，实例标签只由实例服务模式决定", () => {
  assert.equal(
    resolveWorkspaceServiceLabel({
      scope: "provider",
      tenantServiceMode: "simulation"
    }),
    "正式服务商平台"
  );
  assert.equal(
    resolveWorkspaceServiceLabel({
      scope: "tenant",
      tenantServiceMode: "production"
    }),
    "正式服务"
  );
  assert.equal(
    resolveWorkspaceServiceLabel({
      scope: "tenant",
      tenantServiceMode: "simulation"
    }),
    "模拟服务"
  );
  assert.equal(
    resolveWorkspaceServiceLabel({
      scope: "tenant"
    }),
    "实例服务状态待确认"
  );
});

test("正式实例完成生产开通前不显示为可进入，模拟实例仍可演练", () => {
  assert.deepEqual(
    resolveTenantEntryAction({
      serviceMode: "production",
      status: "trial"
    }),
    {
      disabled: true,
      label: "待生产开通"
    }
  );
  assert.deepEqual(
    resolveTenantEntryAction({
      serviceMode: "production",
      status: "active"
    }),
    {
      disabled: false,
      label: "进入实例"
    }
  );
  assert.deepEqual(
    resolveTenantEntryAction({
      serviceMode: "simulation",
      status: "trial"
    }),
    {
      disabled: false,
      label: "进入实例"
    }
  );
  assert.deepEqual(
    resolveTenantEntryAction({
      serviceMode: "simulation",
      status: "paused"
    }),
    {
      disabled: true,
      label: "实例已暂停"
    }
  );
});

test("待开通和模拟演练不会共用含混的试运行标签", () => {
  assert.equal(
    resolveTenantLifecycleLabel({
      serviceMode: "production",
      status: "trial"
    }),
    "待开通"
  );
  assert.equal(
    resolveTenantLifecycleLabel({
      serviceMode: "simulation",
      status: "trial"
    }),
    "演练中"
  );
  assert.equal(
    resolveTenantLifecycleLabel({
      serviceMode: "production",
      status: "active"
    }),
    "运行中"
  );
  assert.equal(
    resolveTenantLifecycleLabel({
      serviceMode: "simulation",
      status: "paused"
    }),
    "已暂停"
  );
});
