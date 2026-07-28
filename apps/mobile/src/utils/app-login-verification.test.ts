import assert from "node:assert/strict";
import test from "node:test";

import {
  isAppLoginVerificationCode,
  resolveAppLoginVerificationPresentation
} from "./app-login-verification";

test("人工验证码登录在配置加载后不展示短信获取入口", () => {
  assert.deepEqual(resolveAppLoginVerificationPresentation("manual"), {
    guideText: "向实例管理员获取一次性验证码后输入",
    codeHelper: "由实例管理员签发后输入",
    canRequestCode: false
  });
});

test("短信与模拟验证码保留获取入口，配置加载前不误发请求", () => {
  assert.equal(
    resolveAppLoginVerificationPresentation("aliyun_pnvs").canRequestCode,
    true
  );
  assert.equal(
    resolveAppLoginVerificationPresentation("mock").canRequestCode,
    true
  );
  assert.equal(
    resolveAppLoginVerificationPresentation(undefined).canRequestCode,
    false
  );
});

test("人工码严格要求 6 位，其他验证方式保留统一 4 至 8 位合同", () => {
  assert.equal(isAppLoginVerificationCode("123456", "manual"), true);
  assert.equal(isAppLoginVerificationCode("12345", "manual"), false);
  assert.equal(isAppLoginVerificationCode("1234567", "manual"), false);
  assert.equal(isAppLoginVerificationCode("1234", "mock"), true);
  assert.equal(isAppLoginVerificationCode("12345678", "aliyun_pnvs"), true);
});
