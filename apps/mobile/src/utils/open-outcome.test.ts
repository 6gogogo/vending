import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@vm/shared-client";

import { isOpenOutcomeUncertain } from "./open-outcome";

test("开门结果未知、超时和网络中断均阻止重复开门", () => {
  for (const message of [
    "柜机平台响应异常，开门结果待确认，请勿重复操作",
    "请求超时，请检查网络后重试",
    "暂时无法连接服务，请检查网络后重试",
    "该柜门已有未结束的开门操作，请等待当前操作完成",
    "正在处理另一项开门请求，请等待结果确认",
    "Failed to fetch",
    "Network Error"
  ]) {
    assert.equal(isOpenOutcomeUncertain(message), true, message);
  }
});

test("明确业务拒绝不被误判为结果未知", () => {
  assert.equal(
    isOpenOutcomeUncertain(
      "柜机平台开柜失败：设备明确拒绝",
      new ApiError("柜机平台开柜失败：设备明确拒绝", 502)
    ),
    false
  );
  assert.equal(isOpenOutcomeUncertain("当前柜机处于维护状态"), false);
});

test("柜机平台明确拒绝的 409 按确定结果处理", () => {
  assert.equal(
    isOpenOutcomeUncertain(
      "柜机平台已拒绝开门请求。",
      new ApiError("柜机平台已拒绝开门请求。", 409, {
        code: "operation_rejected",
        retryable: false
      })
    ),
    false
  );
});

test("结果不确定或已确认受理的 409 仍禁止取消预约和重复开门", () => {
  for (const code of ["operation_indeterminate", "operation_confirmed"] as const) {
    assert.equal(
      isOpenOutcomeUncertain(
        `HTTP 409 ${code}`,
        new ApiError(`HTTP 409 ${code}`, 409, { code, retryable: false })
      ),
      true,
      code
    );
  }
});

test("非幂等开门的 408、409、5xx 和非 JSON 响应均按结果未知处理", () => {
  for (const status of [408, 409, 500, 502]) {
    assert.equal(
      isOpenOutcomeUncertain(`HTTP ${status}`, new ApiError(`HTTP ${status}`, status)),
      true
    );
  }
  assert.equal(
    isOpenOutcomeUncertain("Unexpected token '<'", new SyntaxError("Unexpected token '<'")),
    true
  );
});
