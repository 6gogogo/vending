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

test("移动端对未知或缺失的柜门状态保持关闭式阻断", () => {
  for (const device of [createDevice("unknown"), createDevice()]) {
    const presentation = getDeviceStatusPresentation(device);

    assert.equal(presentation.canOpen, false);
    assert.equal(presentation.label, "柜门状态待确认");
    assert.match(presentation.actionHint, /确认关门后再开柜/);
  }
});

test("移动端只在柜门明确关闭时允许继续开柜", () => {
  const presentation = getDeviceStatusPresentation(createDevice("closed"));

  assert.equal(presentation.canOpen, true);
  assert.equal(presentation.label, "在线");
});
