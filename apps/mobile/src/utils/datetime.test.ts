import assert from "node:assert/strict";
import test from "node:test";

import { formatBeijingAvailabilityWindow } from "./datetime";

test("同一天的预约可用时段只重复一次日期", () => {
  assert.equal(
    formatBeijingAvailabilityWindow(
      "2026-08-16T08:30:00.000Z",
      "2026-08-16T09:30:00.000Z"
    ),
    "08-16 16:30–17:30"
  );
});

test("跨天预约可用时段同时显示开始和结束日期", () => {
  assert.equal(
    formatBeijingAvailabilityWindow(
      "2026-08-16T15:30:00.000Z",
      "2026-08-16T16:30:00.000Z"
    ),
    "08-16 23:30–08-17 00:30"
  );
});

test("预约时间无效时关闭式显示占位符", () => {
  assert.equal(formatBeijingAvailabilityWindow("invalid", "2026-08-16T09:30:00.000Z"), "-");
  assert.equal(formatBeijingAvailabilityWindow(undefined, undefined), "-");
});
