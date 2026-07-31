import assert from "node:assert/strict";
import test from "node:test";

import {
  canRequestBackofficePasswordResetCode,
  resolveBackofficePasswordResetCodeActionLabel
} from "./backoffice-password-reset-runtime";

const readyState = {
  status: "ready" as const,
  provider: "mock" as const,
  username: "admin",
  phone: "13000000000",
  requestingCode: false,
  cooldownSeconds: 0
};

test("后台找回发码在运行配置未就绪、失败或人工模式时失败关闭", () => {
  assert.equal(
    canRequestBackofficePasswordResetCode({ ...readyState, status: "loading" }),
    false
  );
  assert.equal(
    canRequestBackofficePasswordResetCode({ ...readyState, status: "error" }),
    false
  );
  assert.equal(
    canRequestBackofficePasswordResetCode({ ...readyState, provider: undefined }),
    false
  );
  assert.equal(
    canRequestBackofficePasswordResetCode({ ...readyState, provider: "unsupported" }),
    false
  );
  assert.equal(
    canRequestBackofficePasswordResetCode({ ...readyState, provider: "manual" }),
    false
  );
  assert.equal(
    canRequestBackofficePasswordResetCode({ ...readyState, username: "" }),
    false
  );
  assert.equal(canRequestBackofficePasswordResetCode(readyState), true);
});

test("后台找回发码按钮明确显示配置、人工签发和冷却状态", () => {
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel({
      ...readyState,
      status: "loading"
    }),
    "正在读取验证方式"
  );
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel({ ...readyState, status: "error" }),
    "验证方式不可用"
  );
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel({
      ...readyState,
      provider: "unsupported"
    }),
    "验证方式不可用"
  );
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel({
      ...readyState,
      provider: "manual"
    }),
    "请向管理员获取"
  );
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel({
      ...readyState,
      requestingCode: true
    }),
    "发送中..."
  );
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel({
      ...readyState,
      cooldownSeconds: 26
    }),
    "26 秒后可重发"
  );
  assert.equal(
    resolveBackofficePasswordResetCodeActionLabel(readyState),
    "获取找回验证码"
  );
});
