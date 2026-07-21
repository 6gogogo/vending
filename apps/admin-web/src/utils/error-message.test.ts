import assert from "node:assert/strict";
import test from "node:test";

import { getAdminErrorMessage } from "./error-message";

test("后台把底层网络异常转换为可执行的中文提示", () => {
  assert.equal(
    getAdminErrorMessage(new TypeError("Failed to fetch"), "加载失败"),
    "暂时无法连接服务，请检查连接后重试。"
  );
  assert.equal(
    getAdminErrorMessage(new Error("NetworkError when attempting to fetch resource."), "加载失败"),
    "暂时无法连接服务，请检查连接后重试。"
  );
});
test("后台不会把上传业务失败误判为网络异常", () => {
  assert.equal(getAdminErrorMessage(new Error("upload failed"), "上传失败"), "upload failed");
});

test("后台隐藏非 JSON 响应的解析细节并保留明确业务错误", () => {
  assert.equal(
    getAdminErrorMessage(new SyntaxError("Unexpected token '<'"), "加载失败"),
    "服务响应格式异常，请稍后重试。"
  );
  assert.equal(
    getAdminErrorMessage(new Error("柜机平台开柜失败：设备明确拒绝"), "开门失败"),
    "柜机平台开柜失败：设备明确拒绝"
  );
});
