import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";

import type {
  CabinetEventRecord,
  DeviceConnectivity,
  DeviceReadiness,
  DeviceRecord
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

interface OpenOperationTarget {
  deviceCode: string;
  doorNum: string;
}

const DEFAULT_STATUS_STALE_AFTER_MS = 5 * 60_000;
const MIN_STATUS_STALE_AFTER_MS = 30_000;
const MAX_STATUS_STALE_AFTER_MS = 24 * 60 * 60_000;

const UNRESOLVED_DOOR_EVENT_STATUSES = new Set<CabinetEventRecord["status"]>([
  "created",
  "opening",
  "opened",
  "stuck_open"
]);

/**
 * 统一封装“设备现在是否可操作”和“同一柜门是否已有命令在途”。
 * 首版仍是单进程内存锁；持久化事件检查用于服务重启后的保守阻断。
 */
@Injectable()
export class DeviceOperationCoordinator {
  private readonly inFlightOpenKeys = new Set<string>();
  private readonly inFlightUserKeys = new Set<string>();

  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  getReadiness(deviceCode: string, now = Date.now()): DeviceReadiness {
    const device = this.findDevice(deviceCode);
    const staleAfterMs = this.readBoundedMilliseconds(
      "SMARTVM_STATUS_STALE_AFTER_MS",
      DEFAULT_STATUS_STALE_AFTER_MS,
      MIN_STATUS_STALE_AFTER_MS,
      MAX_STATUS_STALE_AFTER_MS
    );

    // 全真模拟人工码验收的固定体验柜没有远端设备可上报心跳。仅该受控模拟夹具
    // 将当前 API 进程视为心跳来源，避免预约完成后因等待页面操作而错误变为离线。
    if (this.store.isManualAppAcceptanceFixtureDevice(device)) {
      const recordedAt = Date.parse(device.lastSeenAt);

      if (!Number.isFinite(recordedAt) || now > recordedAt) {
        device.lastSeenAt = new Date(now).toISOString();
      }
    }

    const runtime = this.store.getDeviceRuntime(device.deviceCode);
    const lastObservedAtMs = Date.parse(device.lastSeenAt);
    const heartbeatIsStale =
      device.status === "online" &&
      (!Number.isFinite(lastObservedAtMs) || now - lastObservedAtMs > staleAfterMs);
    const connectivity: DeviceConnectivity =
      device.status === "offline" ? "offline" : heartbeatIsStale ? "stale" : "online";
    const lastPlatformRecognizedAtMs = Date.parse(runtime.lastPlatformRecognizedAt ?? "");
    const platformRecognitionIsFresh =
      Number.isFinite(lastPlatformRecognizedAtMs) &&
      now >= lastPlatformRecognizedAtMs &&
      now - lastPlatformRecognizedAtMs <= staleAfterMs;
    const unresolvedDoorEvent = this.findUnresolvedDoorEvent(device.deviceCode);
    const doorState = runtime.doorState;
    const platformRecognitionAllowsOpen =
      platformRecognitionIsFresh && doorState !== "open" && !unresolvedDoorEvent;
    const statusBlocker =
      device.status === "maintenance"
        ? "maintenance"
        : connectivity === "offline" && !platformRecognitionAllowsOpen
          ? "offline"
          : undefined;
    const physicalDoorBlocker =
      doorState === "open"
        ? "door_open"
        : unresolvedDoorEvent
          ? "door_unconfirmed"
          : undefined;
    const blocker = statusBlocker === "maintenance"
      ? statusBlocker
      : physicalDoorBlocker ?? statusBlocker;
    const staleAt = Number.isFinite(lastObservedAtMs)
      ? new Date(lastObservedAtMs + staleAfterMs).toISOString()
      : undefined;

    return {
      reportedStatus: device.status,
      effectiveStatus:
        device.status === "maintenance"
          ? "maintenance"
          : connectivity === "online"
            ? "online"
            : "offline",
      connectivity,
      platformRecognition: platformRecognitionIsFresh ? "confirmed" : "unconfirmed",
      lastPlatformRecognizedAt: runtime.lastPlatformRecognizedAt,
      canOpen: !blocker,
      blocker,
      lastObservedAt: device.lastSeenAt,
      staleAfterMs,
      staleAt
    };
  }

  getEffectiveStatus(deviceCode: string, now = Date.now()) {
    return this.getReadiness(deviceCode, now).effectiveStatus;
  }

  assertOpenable(target: OpenOperationTarget, now = Date.now()) {
    const device = this.findDevice(target.deviceCode);
    const doorNum = this.normalizeDoorNum(target.doorNum);

    if (!device.doors.some((door) => door.doorNum === doorNum)) {
      throw new BadRequestException("该柜机不存在对应柜门。");
    }

    const readiness = this.getReadiness(device.deviceCode, now);

    if (readiness.blocker === "maintenance") {
      throw new BadRequestException("柜机当前处于维护状态，不能开门。");
    }

    if (readiness.blocker === "offline") {
      throw new BadRequestException("柜机当前离线，不能开门。");
    }

    if (readiness.blocker === "stale") {
      const staleMinutes = Math.max(1, Math.round(readiness.staleAfterMs / 60_000));
      throw new BadRequestException(
        `柜机状态已超过 ${staleMinutes} 分钟未更新，请先刷新状态后再开门。`
      );
    }

    if (readiness.blocker === "door_open") {
      throw new ConflictException("柜门当前已开启，不能重复开门。");
    }

    if (readiness.blocker === "door_unconfirmed") {
      const unresolvedEvent = this.findUnresolvedDoorEvent(device.deviceCode, doorNum);
      throw new ConflictException(
        unresolvedEvent
          ? `该柜门上一条开门操作（${unresolvedEvent.eventId}）结果仍待确认，请等待关门回调或由管理员现场确认柜门已关闭。`
          : "柜门物理状态尚未确认，请等待关门回调或由管理员现场确认柜门已关闭。"
      );
    }

    return readiness;
  }

  async runExclusiveOpen<Result>(
    target: OpenOperationTarget,
    operation: () => Promise<Result>,
    options?: { userId?: string }
  ): Promise<Result> {
    const deviceCode = target.deviceCode.trim();
    const doorNum = this.normalizeDoorNum(target.doorNum);
    const key = `${deviceCode}::${doorNum}`;

    if (this.inFlightOpenKeys.has(key)) {
      throw new ConflictException("该柜门正在处理另一项开门请求，请等待当前操作完成。");
    }

    const userKey = options?.userId?.trim();

    if (userKey && this.inFlightUserKeys.has(userKey)) {
      throw new ConflictException("当前账号正在处理另一项开柜请求，请等待结果确认后再操作。");
    }

    this.inFlightOpenKeys.add(key);
    if (userKey) {
      this.inFlightUserKeys.add(userKey);
    }

    try {
      this.assertOpenable({ deviceCode, doorNum });
      return await operation();
    } finally {
      this.inFlightOpenKeys.delete(key);
      if (userKey) {
        this.inFlightUserKeys.delete(userKey);
      }
    }
  }

  recordTrustedActivity(deviceCode: string, observedAt = new Date().toISOString()) {
    const normalizedDeviceCode = deviceCode?.trim();
    const device = this.store.devices.find((entry) => entry.deviceCode === normalizedDeviceCode);

    // 回调处理的首要职责是完成已绑定事件的状态推进。历史数据或精简测试夹具中
    // 可能没有对应的设备主记录，此时不能让附带的“刷新在线时间”反向中断回调。
    if (!device) {
      return false;
    }

    device.lastSeenAt = observedAt;

    if (device.status !== "maintenance") {
      device.status = "online";
    }

    return true;
  }

  private findDevice(deviceCode: string): DeviceRecord {
    const normalizedDeviceCode = deviceCode?.trim();
    const device = this.store.devices.find((entry) => entry.deviceCode === normalizedDeviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    return device;
  }

  private findUnresolvedDoorEvent(deviceCode: string, doorNum?: string) {
    return this.store.events.find((event) => {
      if (
        event.deviceCode !== deviceCode ||
        (doorNum !== undefined && event.doorNum !== doorNum)
      ) {
        return false;
      }

      if (event.physicalDoorState === "open") {
        return true;
      }

      // 超时、失败等终态仍完整保留在事件记录中，但不再因缺少物理门态回调
      // 永久锁死后续开柜。只有命令仍在处理或已经确认开门时继续阻断。
      return UNRESOLVED_DOOR_EVENT_STATUSES.has(event.status) &&
        event.physicalDoorState !== "closed";
    });
  }

  private normalizeDoorNum(value: string) {
    const doorNum = String(value ?? "").trim();

    if (!/^[1-9]\d*$/u.test(doorNum) || !Number.isSafeInteger(Number(doorNum))) {
      throw new BadRequestException("柜门编号必须为有效的正整数。");
    }

    return doorNum;
  }

  private readBoundedMilliseconds(key: string, fallback: number, min: number, max: number) {
    const parsed = Number(process.env[key]);

    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }
}
