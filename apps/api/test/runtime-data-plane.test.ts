import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLivePlatformTenantConfiguration,
  assertProductionRuntimeDataPlane,
  createSimulationPlatformTenant,
  resolveLivePlatformTenantConfiguration,
  resolveRuntimeDataPlane,
  resolveRuntimeDataPlaneInstanceId
} from "../src/common/config/runtime-data-plane.js";

test("完全沿用旧模拟路径时可缺省 simulation，但一旦设置新平面边界必须显式选择", () => {
  assert.equal(resolveRuntimeDataPlane({}), "simulation");
  assert.equal(resolveRuntimeDataPlaneInstanceId({}), "simulation-default");

  assert.throws(
    () => resolveRuntimeDataPlane({ VM_DATA_ROOT: "/srv/vending/live" }),
    /VM_DATA_PLANE 不能为空/
  );
  assert.throws(
    () => resolveRuntimeDataPlane({ VM_DATA_PLANE_ID: "live-instance-01" }),
    /VM_DATA_PLANE 不能为空/
  );
  assert.equal(
    resolveRuntimeDataPlane({
      VM_DATA_PLANE: "simulation",
      VM_DATA_ROOT: "/tmp/simulation"
    }),
    "simulation"
  );
});

test("真实平面必须显式提供稳定实例标识", () => {
  assert.throws(
    () => resolveRuntimeDataPlaneInstanceId({ VM_DATA_PLANE: "live" }),
    /真实平面必须显式设置/
  );
  assert.equal(
    resolveRuntimeDataPlaneInstanceId({
      VM_DATA_PLANE: "live",
      VM_DATA_PLANE_ID: "live-instance-01"
    }),
    "live-instance-01"
  );
});

test("真实平面只能在 production 运行态启动，避免跳过真实通道门禁", () => {
  const liveEnvironment = {
    VM_DATA_PLANE: "live",
    VM_DATA_PLANE_ID: "live-instance-01"
  };

  assert.throws(
    () =>
      assertProductionRuntimeDataPlane({
        ...liveEnvironment,
        NODE_ENV: "development"
      }),
    /真实数据平面必须在 NODE_ENV 或 APP_ENV 为 production/
  );
  assert.equal(
    assertProductionRuntimeDataPlane({
      ...liveEnvironment,
      NODE_ENV: "production"
    }),
    "live"
  );
});

test("真实平面的唯一客户实例由部署配置绑定，模拟平面继续使用 tenant-a", () => {
  const environment = {
    VM_DATA_PLANE: "live",
    VM_DATA_PLANE_ID: "live-tenant-test",
    VM_PLATFORM_TENANT_NAME: "真实租户测试实例",
    PUBLIC_BASE_URL: "https://live-tenant.example.test"
  };

  assert.deepEqual(resolveLivePlatformTenantConfiguration(environment), {
    id: "live-tenant-test",
    name: "真实租户测试实例",
    instanceUrl: "https://live-tenant.example.test"
  });
  assert.equal(createSimulationPlatformTenant().id, "tenant-a");
  assert.throws(
    () =>
      assertLivePlatformTenantConfiguration(
        [
          {
            id: "tenant-a",
            name: "真实租户测试实例",
            instanceUrl: "https://live-tenant.example.test"
          }
        ],
        environment
      ),
    /客户实例 ID 必须与 VM_DATA_PLANE_ID 一致/
  );
  assert.throws(
    () =>
      resolveLivePlatformTenantConfiguration({
        ...environment,
        VM_PLATFORM_TENANT_NAME: ""
      }),
    /缺少必填配置：VM_PLATFORM_TENANT_NAME/
  );
});
