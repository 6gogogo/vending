import type { DeviceReadiness, DeviceRecord } from "@vm/shared-types";

export type DeviceStatusTone = "success" | "warning" | "danger";

export interface DeviceStatusPresentation {
  canOpen: boolean;
  label: string;
  tone: DeviceStatusTone;
  actionHint: string;
}

const fallbackReadiness = (device: DeviceRecord): Pick<DeviceReadiness, "canOpen" | "blocker"> => {
  if (device.status === "maintenance") {
    return { canOpen: false, blocker: "maintenance" };
  }

  if (device.status === "offline") {
    return { canOpen: false, blocker: "offline" };
  }

  if (device.runtime?.doorState === "open") {
    return { canOpen: false, blocker: "door_open" };
  }

  return { canOpen: true, blocker: undefined };
};

export const getDeviceStatusPresentation = (device: DeviceRecord): DeviceStatusPresentation => {
  const readiness = device.readiness ?? fallbackReadiness(device);
  const blocker = readiness.blocker;

  if (blocker === "stale") {
    return {
      canOpen: false,
      label: "状态待刷新",
      tone: "warning",
      actionHint: "设备监控数据长时间未更新，请刷新后再开柜；仍未恢复时请选择其他柜机或反馈。"
    };
  }

  if (blocker === "maintenance" || device.status === "maintenance") {
    return {
      canOpen: false,
      label: "维护中",
      tone: "warning",
      actionHint: "设备正在维护，暂时不能开柜。请选择其他柜机，需要帮助时可提交反馈。"
    };
  }

  if (blocker === "offline" || (!device.readiness && device.status === "offline")) {
    return {
      canOpen: false,
      label: "离线",
      tone: "danger",
      actionHint: "设备当前离线，暂时不能开柜。请选择其他柜机，或反馈给工作人员。"
    };
  }

  if (blocker === "door_open") {
    return {
      canOpen: false,
      label: "柜门尚未关闭",
      tone: "danger",
      actionHint: "柜门当前仍处于打开状态。请先关闭柜门并刷新状态，确认关门后再开柜。"
    };
  }

  if (blocker === "door_unconfirmed") {
    return {
      canOpen: false,
      label: "开门结果待确认",
      tone: "warning",
      actionHint: "上一条开门操作尚未收到可信关门结果，请勿重复开柜，并联系工作人员核对。"
    };
  }

  const doorStateUnknown =
    device.runtime?.doorState !== "open" && device.runtime?.doorState !== "closed";
  const platformOnly =
    device.readiness?.platformRecognition === "confirmed" &&
    device.readiness.connectivity !== "online";

  return {
    canOpen: readiness.canOpen,
    label: platformOnly ? "平台已识别" : "在线",
    tone: platformOnly || doorStateUnknown ? "warning" : "success",
    actionHint: platformOnly
      ? "平台已识别当前柜机，但物理在线状态仍以设备回调为准；提交后请等待本次结果。"
      : doorStateUnknown
        ? "柜门尚无历史状态；提交后请等待设备回调，不要重复开柜。"
      : "设备状态正常，可继续选择物资并开柜。"
  };
};

export const canOpenDevice = (device: DeviceRecord) =>
  getDeviceStatusPresentation(device).canOpen;
