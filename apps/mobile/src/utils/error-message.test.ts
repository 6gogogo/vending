import assert from "node:assert/strict";
import test from "node:test";

import { appendErrorContext, getErrorMessage } from "./error-message";

test("错误说明拼接时只保留一个中文句号", () => {
  assert.equal(
    appendErrorContext("暂时无法连接服务，请检查网络后重试。", "恢复前不会允许继续操作。"),
    "暂时无法连接服务，请检查网络后重试。恢复前不会允许继续操作。"
  );
});

test("错误说明拼接兼容无标点和空错误消息", () => {
  assert.equal(
    appendErrorContext("请求被拒绝", "请核对权限后重试。"),
    "请求被拒绝。请核对权限后重试。"
  );
  assert.equal(
    appendErrorContext("", "请稍后重试。"),
    "请求失败。请稍后重试。"
  );
});

test("上传等业务错误不会被误判为网络加载失败", () => {
  assert.equal(
    getErrorMessage(new Error("upload failed: file too large")),
    "upload failed: file too large"
  );
  assert.equal(
    getErrorMessage(new Error("load failed")),
    "暂时无法连接服务，请检查网络后重试。"
  );
});
