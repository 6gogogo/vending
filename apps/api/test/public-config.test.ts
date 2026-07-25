import assert from "node:assert/strict";
import test from "node:test";

import { ConfigService } from "@nestjs/config";

import { AppController } from "../src/app.controller.js";
import type { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";

test("公开配置标明模拟数据平面，供界面持续显示模拟实例", () => {
  const controller = new AppController(
    new ConfigService({
      VM_DATA_PLANE: "simulation",
      VM_SIMULATION_PROFILE: "full",
      VM_FULL_SIMULATION_ENABLED: "true",
      VM_FULL_SIMULATION_MAP_MODE: "mock"
    }),
    {} as InMemoryStoreService
  );

  const response = controller.publicConfig();

  assert.equal(response.code, 200);
  assert.equal(response.data.runtimeDataPlane, "simulation");
  assert.equal(response.data.amapRuntimeMode, "mock");
});
