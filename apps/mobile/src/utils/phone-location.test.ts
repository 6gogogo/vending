import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPhoneLocationFailure,
  requestPhoneLocationWithTimeout
} from "./phone-location";

test("手机定位明确被拒绝时归类为权限问题", () => {
  const deniedMessages = [
    { errMsg: "getLocation:fail auth deny" },
    { errMsg: "getLocation:fail permission denied" },
    new Error("scope.userLocation 未授权"),
    "user denied location"
  ];

  for (const message of deniedMessages) {
    assert.equal(classifyPhoneLocationFailure(message), "permission-denied");
  }
});

test("手机定位超时或系统定位不可用时允许直接重试", () => {
  const unavailableMessages = [
    { errMsg: "getLocation:fail timeout" },
    { errMsg: "getLocation:fail system location disabled" },
    new Error("network unavailable")
  ];

  for (const message of unavailableMessages) {
    assert.equal(classifyPhoneLocationFailure(message), "unavailable");
  }
});

test("手机定位没有回调时按应用超时结束，不阻断后续柜机请求", async () => {
  await assert.rejects(
    requestPhoneLocationWithTimeout(() => undefined, 5),
    /getLocation:fail timeout/
  );
});

test("手机定位超时后忽略迟到回调", async () => {
  let callbacks:
    | { success: (value: { longitude: number }) => void; fail: (error: unknown) => void }
    | undefined;
  const request = requestPhoneLocationWithTimeout<{ longitude: number }>((nextCallbacks) => {
    callbacks = nextCallbacks;
  }, 5);

  await assert.rejects(request, /getLocation:fail timeout/);
  callbacks?.success({ longitude: 120 });
});
