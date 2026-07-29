import assert from "node:assert/strict";
import test from "node:test";

import { resolveRegistrationVerificationPresentation } from "./registration-verification";

test("人工验证码实例不开放自助注册或注册短信发送", () => {
  assert.deepEqual(resolveRegistrationVerificationPresentation("manual"), {
    canSubmitSelfService: false,
    title: "请联系实例管理员建档",
    detail:
      "当前实例使用人工验证码。管理员会先完成账号建档和审核，再为已启用账号签发一次性登录码；本页不会发送短信或提交自助注册申请。"
  });
});

test("短信和模拟验证码实例仍保留自助注册，配置加载前保持关闭", () => {
  assert.equal(
    resolveRegistrationVerificationPresentation("aliyun_pnvs").canSubmitSelfService,
    true
  );
  assert.equal(
    resolveRegistrationVerificationPresentation("mock").canSubmitSelfService,
    true
  );
  assert.equal(
    resolveRegistrationVerificationPresentation(undefined).canSubmitSelfService,
    false
  );
});
