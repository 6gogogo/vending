import assert from "node:assert/strict";
import test from "node:test";

import {
  isManualVerificationCode,
  manualCodeFromRandomValue,
  validatePlatformTenantDraft
} from "./backoffice-provisioning";

test("客户实例草稿同时校验编码、手机号和首管理员密码", () => {
  assert.equal(
    validatePlatformTenantDraft({
      code: "tenant-demo",
      name: "公益智助柜测试实例",
      contactPhone: "18800000001",
      firstAdmin: {
        name: "测试管理员",
        phone: "18800000002",
        username: "tenant-demo-admin",
        password: "safe-password-123"
      }
    }),
    undefined
  );
  assert.equal(
    validatePlatformTenantDraft({
      code: "A",
      name: "公益智助柜测试实例",
      contactPhone: "",
      firstAdmin: {
        name: "测试管理员",
        phone: "18800000002",
        username: "tenant-demo-admin",
        password: "safe-password-123"
      }
    }),
    "实例编码需为 2 至 50 位小写字母、数字或连字符。"
  );
  assert.equal(
    validatePlatformTenantDraft({
      code: "tenant-demo",
      name: "公益智助柜测试实例",
      contactPhone: "",
      firstAdmin: {
        name: "测试管理员",
        phone: "18800000002",
        username: "tenant-demo-admin",
        password: "too-short"
      }
    }),
    "首管理员后台密码至少需要 12 位。"
  );
});

test("人工码只能是 6 位数字且随机值始终映射到 100000 至 999999", () => {
  assert.equal(isManualVerificationCode("654321"), true);
  assert.equal(isManualVerificationCode("12345"), false);
  assert.equal(isManualVerificationCode("1234567"), false);
  assert.equal(isManualVerificationCode("12a456"), false);
  assert.equal(manualCodeFromRandomValue(0), "100000");
  assert.equal(manualCodeFromRandomValue(899_999), "999999");
  assert.equal(manualCodeFromRandomValue(900_000), "100000");
  assert.match(manualCodeFromRandomValue(0xffff_ffff), /^\d{6}$/u);
});
