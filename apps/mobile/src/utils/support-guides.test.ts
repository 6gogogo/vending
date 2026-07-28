import assert from "node:assert/strict";
import test from "node:test";

import { getSupportGuideTopics } from "./support-guides";

test("特殊群体帮助中心使用人工码和预约制说明，不保留短信冷却或支付旧流程", () => {
  const topics = getSupportGuideTopics("special");
  const login = topics.find((topic) => topic.id === "login-code");
  const pickup = topics.find((topic) => topic.id === "pickup");

  assert.ok(login);
  assert.ok(pickup);
  assert.match(login.steps.join("\n"), /6 位一次性验证码/);
  assert.match(login.steps.join("\n"), /不发送短信/);
  assert.doesNotMatch(login.steps.join("\n"), /等待 60 秒冷却|重新获取验证码/);
  assert.match(pickup.steps.join("\n"), /提交预约取货/);
  assert.match(pickup.steps.join("\n"), /不会创建支付单/);
  assert.doesNotMatch(pickup.steps.join("\n"), /预结算|待支付|补扣/);
});

test("实例管理员帮助中心提供人工码与预约前置检查", () => {
  const manualCode = getSupportGuideTopics("admin").find((topic) => topic.id === "manual-code");

  assert.ok(manualCode);
  assert.match(manualCode.steps.join("\n"), /当前实例/);
  assert.match(manualCode.steps.join("\n"), /6 位一次性验证码/);
  assert.match(manualCode.steps.join("\n"), /已使用/);
});
