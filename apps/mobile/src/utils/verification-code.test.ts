import assert from "node:assert/strict";
import test from "node:test";

import {
  isVerificationCode,
  normalizeVerificationCode
} from "./verification-code";

test("验证码合同统一接受 4 至 8 位数字", () => {
  assert.equal(isVerificationCode("1234"), true);
  assert.equal(isVerificationCode("123456"), true);
  assert.equal(isVerificationCode("12345678"), true);
  assert.equal(isVerificationCode("123"), false);
  assert.equal(isVerificationCode("123456789"), false);
  assert.equal(isVerificationCode("1234a"), false);
});

test("验证码校验前只移除首尾空白，不改写用户输入内容", () => {
  assert.equal(normalizeVerificationCode(" 12345678 "), "12345678");
  assert.equal(normalizeVerificationCode("12 34"), "12 34");
});
