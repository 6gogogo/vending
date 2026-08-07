import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceRecord } from "@vm/shared-types";

import { getDeviceStatusPresentation } from "./device-readiness";

const createDevice = (doorState?: "open" | "closed" | "unknown"): DeviceRecord => ({
  deviceCode: "device-readiness-test",
  name: "测试柜机",
  location: "测试位置",
  status: "online",
  doors: [{ doorNum: "1", label: "门 1", goods: [] }],
  lastSeenAt: new Date().toISOString(),
  runtime:
    doorState === undefined
      ? undefined
      : {
          deviceCode: "device-readiness-test",
          doorState,
          openedAfterLastCommand: false
        }
});

test("移动端对打开的柜门给出明确阻断提示", () => {
  const presentation = getDeviceStatusPresentation(createDevice("open"));

  assert.equal(presentation.canOpen, false);
  assert.equal(presentation.label, "柜门尚未关闭");
  assert.match(presentation.actionHint, /关闭柜门并刷新状态/);
});

test("移动端对未知或缺失的柜门状态保持可开柜并提示等待回传", () => {
  for (const device of [createDevice("unknown"), createDevice()]) {
    const presentation = getDeviceStatusPresentation(device);

    assert.equal(presentation.canOpen, true);
    assert.equal(presentation.label, "在线");
    assert.match(presentation.actionHint, /不阻止开柜/);
  }
});

test("移动端在柜门明确关闭时允许继续开柜", () => {
  const presentation = getDeviceStatusPresentation(createDevice("closed"));

  assert.equal(presentation.canOpen, true);
  assert.equal(presentation.label, "在线");
});

test("移动端兼容旧服务端的 door_unconfirmed 响应但不据此阻断", () => {
  const device = createDevice("unknown");
  device.runtime!.lastCommandAt = new Date().toISOString();
  device.readiness = {
    reportedStatus: "online",
    effectiveStatus: "online",
    connectivity: "online",
    canOpen: false,
    blocker: "door_unconfirmed",
    lastObservedAt: device.lastSeenAt,
    staleAfterMs: 300_000
  };

  const presentation = getDeviceStatusPresentation(device);
  assert.equal(presentation.canOpen, true);
  assert.equal(presentation.label, "在线");
  assert.match(presentation.actionHint, /最近一次开门状态/);
});

test("移动端尊重服务端签发的首次联机试开就绪度", () => {
  const device = createDevice("unknown");
  device.readiness = {
    reportedStatus: "online",
    effectiveStatus: "online",
    connectivity: "online",
    canOpen: true,
    lastObservedAt: device.lastSeenAt,
    staleAfterMs: 300_000
  };

  const presentation = getDeviceStatusPresentation(device);
  assert.equal(presentation.canOpen, true);
  assert.equal(presentation.label, "在线");
});
