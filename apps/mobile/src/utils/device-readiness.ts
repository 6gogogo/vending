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

  if (device.runtime?.doorState !== "closed") {
    return { canOpen: false, blocker: "door_unconfirmed" };
  }

  return { canOpen: true, blocker: undefined };
};

export const getDeviceStatusPresentation = (device: DeviceRecord): DeviceStatusPresentation => {
  const readiness = device.readiness ?? fallbackReadiness(device);
  // 新版 API 已把首次联机试开、命令历史和物理门状态统一折算进 readiness。
  // 只有旧响应缺少 readiness 时才使用上方关闭式兼容逻辑。
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

  if (blocker === "offline" || device.status === "offline") {
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
      label: "柜门状态待确认",
      tone: "warning",
      actionHint: "尚未确认柜门已经关闭。请先刷新设备状态，确认关门后再开柜，避免重复开门。"
    };
  }

  return {
    canOpen: readiness.canOpen,
    label: "在线",
    tone: "success",
    actionHint: "设备状态正常，可继续选择物资并开柜。"
  };
};

export const canOpenDevice = (device: DeviceRecord) =>
  getDeviceStatusPresentation(device).canOpen;
