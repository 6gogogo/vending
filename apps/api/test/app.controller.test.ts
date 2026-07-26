import assert from "node:assert/strict";
import test from "node:test";

import { AppController } from "../src/app.controller";

test("健康检查只返回最小 liveness 契约", () => {
  const controller = new AppController({
    get: () => undefined
  } as never, {} as never, {
    getRuntimeConfig: () => ({
      provider: "mock",
      previewEnabled: false
    })
  } as never);

  const response = controller.health();

  assert.deepEqual(Object.keys(response).sort(), ["code", "data", "message"]);
  assert.equal(response.code, 200);
  assert.equal(response.message, "成功");
  assert.deepEqual(Object.keys(response.data).sort(), ["status", "timestamp"]);
  assert.equal(response.data.status, "正常");
  assert.equal(Number.isNaN(Date.parse(response.data.timestamp)), false);
});
