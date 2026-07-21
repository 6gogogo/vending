import assert from "node:assert/strict";
import test from "node:test";

import type { OperationLogRecord } from "@vm/shared-types";

import { formatOperationLog } from "../src/common/logging/operation-log-template";

const createDoorStatusLog = (
  rawStatus: string,
  status: OperationLogRecord["status"] = "success"
) =>
  formatOperationLog({
    id: `door-${rawStatus.toLowerCase()}`,
    category: "device",
    type: "door-status-callback",
    status,
    occurredAt: "2026-07-17T04:44:12.000Z",
    actor: {
      type: "system",
      name: "设备回调"
    },
    primarySubject: {
      type: "device",
      id: "91120149",
      label: "测试平台柜机 91120149"
    },
    detail: "",
    description: "",
    metadata: {
      status: rawStatus
    }
  });

test("门状态 CLOSED 在主文案中显示中文，原始码只保留在详情", () => {
  const formatted = createDoorStatusLog("CLOSED");

  assert.equal(formatted.description, "系统确认“测试平台柜机 91120149”的柜门已关闭。");
  assert.doesNotMatch(formatted.description, /CLOSED/);
  assert.match(formatted.detail, /平台原始状态 CLOSED/);
});

test("门状态 FAIL 在主文案中说明开门失败，原始码只保留在详情", () => {
  const formatted = createDoorStatusLog("FAIL", "failed");

  assert.equal(formatted.description, "系统记录“测试平台柜机 91120149”开门失败。");
  assert.doesNotMatch(formatted.description, /FAIL/);
  assert.match(formatted.detail, /平台原始状态 FAIL/);
  assert.match(formatted.detail, /状态 失败/);
});

test("门状态 SUCCESS 在主文案中说明柜门已打开", () => {
  const formatted = createDoorStatusLog("SUCCESS");

  assert.equal(formatted.description, "系统确认“测试平台柜机 91120149”的柜门已打开。");
  assert.doesNotMatch(formatted.description, /SUCCESS/);
  assert.match(formatted.detail, /平台原始状态 SUCCESS/);
});

test("门状态 OPENDING 在主文案中说明柜门正在开启", () => {
  const formatted = createDoorStatusLog("OPENDING", "pending");

  assert.equal(formatted.description, "系统确认“测试平台柜机 91120149”的柜门正在开启。");
  assert.doesNotMatch(formatted.description, /OPENDING/);
  assert.match(formatted.detail, /平台原始状态 OPENDING/);
  assert.match(formatted.detail, /状态 待处理/);
});

test("未识别门状态不进入主文案，仍在详情中保留排查信息", () => {
  const formatted = createDoorStatusLog("VENDOR_NEW_STATE", "warning");

  assert.equal(
    formatted.description,
    "系统收到了“测试平台柜机 91120149”的门状态回调，当前结果待确认。"
  );
  assert.doesNotMatch(formatted.description, /VENDOR_NEW_STATE/);
  assert.match(formatted.detail, /平台原始状态 VENDOR_NEW_STATE/);
});

test("创建柜机预警时去除告警标题中重复的柜机名称", () => {
  const formatted = formatOperationLog({
    id: "alert-open-failed",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-07-17T04:44:13.000Z",
    actor: {
      type: "system",
      name: "系统巡检"
    },
    primarySubject: {
      type: "alert",
      id: "alert-001",
      label: "测试平台柜机 91120149开门失败"
    },
    secondarySubject: {
      type: "device",
      id: "91120149",
      label: "测试平台柜机 91120149"
    },
    detail: "",
    description: ""
  });

  assert.equal(
    formatted.description,
    "系统为“测试平台柜机 91120149”创建了预警：开门失败。"
  );
  assert.equal(formatted.description.match(/测试平台柜机 91120149/g)?.length, 1);
});
