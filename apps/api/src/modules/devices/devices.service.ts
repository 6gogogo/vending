import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";

import type {
  CabinetEventRecord,
  DeviceGoods,
  DeviceMonitoringDetail,
  DeviceRecord,
  DeviceRuntimeState,
  DeviceStatus,
  GoodsCategory,
  PaymentRefundRecoverySummary,
  SmartVmRouterStatusResult,
  UserRole
} from "@vm/shared-types";

import { isProductionRuntime } from "../../common/config/runtime-environment";
import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { DeviceOperationCoordinator } from "./device-operation-coordinator";
import { SmartVmGateway } from "./smartvm.gateway";

@Injectable()
export class DevicesService {
  private readonly deviceOperations: DeviceOperationCoordinator;

  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService) private readonly inventoryBatchChanges: InventoryBatchChangesService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway,
    @Optional() @Inject(DeviceOperationCoordinator) deviceOperations?: DeviceOperationCoordinator
  ) {
    this.deviceOperations = deviceOperations ?? new DeviceOperationCoordinator(store);
  }

  list(origin?: { longitude?: number; latitude?: number }, viewerRole?: UserRole) {
    this.store.syncDeviceStocksFromBatches();
    const devices = this.store.devices.map((device) => {
      const distanceMeters =
        origin?.longitude !== undefined &&
        origin?.latitude !== undefined &&
        device.longitude !== undefined &&
        device.latitude !== undefined
          ? this.calculateDistanceMeters(origin.latitude, origin.longitude, device.latitude, device.longitude)
          : undefined;

      return {
        ...this.decorateDevice(device, viewerRole),
        distanceMeters,
        runtime: this.store.getDeviceRuntime(device.deviceCode)
      };
    });

    if (origin?.longitude === undefined || origin?.latitude === undefined) {
      return devices;
    }

    // 有定位时优先返回最近柜机，尽量减少行动不便用户的步行和来回试错成本。
    return devices.sort((left, right) => {
      if (left.distanceMeters === undefined && right.distanceMeters === undefined) {
        return left.deviceCode.localeCompare(right.deviceCode);
      }

      if (left.distanceMeters === undefined) {
        return 1;
      }

      if (right.distanceMeters === undefined) {
        return -1;
      }

      return left.distanceMeters - right.distanceMeters;
    });
  }

  getByCode(deviceCode: string) {
    this.store.syncDeviceStocksFromBatches(deviceCode);
    const device = this.store.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    return device;
  }

  getViewByCode(deviceCode: string, viewerRole?: UserRole) {
    const device = this.getByCode(deviceCode);

    return {
      ...this.decorateDevice(device, viewerRole),
      runtime: this.store.getDeviceRuntime(device.deviceCode)
    };
  }

  upsertDevice(
    payload: {
      deviceCode: string;
      name: string;
      location: string;
      address?: string;
      longitude?: number;
      latitude?: number;
      doorNum?: string;
      doorLabel?: string;
    },
    actorUserId?: string
  ) {
    const deviceCode = payload.deviceCode.trim();
    const name = payload.name.trim();
    const location = payload.location.trim();
    const address = payload.address?.trim() || location;
    const doorNum = payload.doorNum?.trim() || "1";
    const doorLabel = payload.doorLabel?.trim() || `门 ${doorNum}`;

    if (!deviceCode) {
      throw new BadRequestException("柜机编号不能为空。");
    }

    if (!name) {
      throw new BadRequestException("柜机名称不能为空。");
    }

    if (!location) {
      throw new BadRequestException("柜机位置不能为空。");
    }

    if (payload.longitude !== undefined && !Number.isFinite(payload.longitude)) {
      throw new BadRequestException("柜机经度格式不正确。");
    }

    if (payload.latitude !== undefined && !Number.isFinite(payload.latitude)) {
      throw new BadRequestException("柜机纬度格式不正确。");
    }

    const now = new Date().toISOString();
    const existing = this.store.devices.find((entry) => entry.deviceCode === deviceCode);

    if (existing) {
      existing.name = name;
      existing.location = location;
      existing.address = address;
      existing.longitude = payload.longitude;
      existing.latitude = payload.latitude;

      if (!existing.doors.some((door) => door.doorNum === doorNum)) {
        existing.doors.push({
          doorNum,
          label: doorLabel,
          goods: []
        });
      }

      this.store.logOperation({
        category: "device",
        type: "update-device",
        status: "success",
        actor: this.getAdminActor(actorUserId),
        primarySubject: {
          type: "device",
          id: existing.deviceCode,
          label: existing.name
        },
        description: `管理员更新了柜机 ${existing.name} 的基础信息。`,
        detail: `设备 ${existing.deviceCode} 已更新为 ${existing.location}，状态 ${existing.status}。`,
        metadata: {
          deviceCode: existing.deviceCode
        }
      });

      return {
        ...this.decorateDevice(existing),
        runtime: this.store.getDeviceRuntime(existing.deviceCode)
      };
    }

    const created: DeviceRecord = {
      deviceCode,
      name,
      location,
      address,
      longitude: payload.longitude,
      latitude: payload.latitude,
      status: "offline",
      lastSeenAt: now,
      doors: [
        {
          doorNum,
          label: doorLabel,
          goods: []
        }
      ]
    };

    this.store.devices.unshift(created);
    this.store.updateDeviceRuntime(deviceCode, {
      deviceCode,
      // 录入后台只证明设备档案存在，不能替代平台返回的可信物理关门状态。
      doorState: "unknown",
      openedAfterLastCommand: false
    });

    this.store.logOperation({
      category: "device",
      type: "create-device",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: created.deviceCode,
        label: created.name
      },
      description: `管理员新增了柜机 ${created.name}。`,
      detail: `设备 ${created.deviceCode} 已创建，可在柜机详情页继续维护位置和货品。`,
      metadata: {
        deviceCode: created.deviceCode
      }
    });

    return {
      ...this.decorateDevice(created),
      runtime: this.store.getDeviceRuntime(created.deviceCode)
    };
  }

  removeDevice(deviceCode: string, actorUserId?: string) {
    const existing = this.getByCode(deviceCode);
    const removed = this.store.removeActiveDeviceState(deviceCode);

    if (!removed) {
      throw new NotFoundException("未找到对应柜机。");
    }

    this.store.logOperation({
      category: "device",
      type: "remove-device",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: existing.deviceCode,
        label: existing.name
      },
      description: `管理员移除了柜机 ${existing.name}。`,
      detail: `设备 ${existing.deviceCode} 已从当前运行柜机列表中删除，同时清理了库存批次、阈值设置与未完成预警。`,
      metadata: {
        deviceCode: existing.deviceCode,
        undoState: "not_undoable"
      }
    });

    return {
      deviceCode: existing.deviceCode,
      name: existing.name
    };
  }

  monitoringDetail(deviceCode: string): DeviceMonitoringDetail {
    const device = this.getByCode(deviceCode);
    const businessDateKey = getBusinessDayKey(new Date());
    const recentEvents = this.store.events
      .filter((entry) => entry.deviceCode === deviceCode)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
      .map((event) => this.attachPaymentRecoveryState(event));
    const recentLogs = this.store.logs
      .filter(
        (entry) =>
          entry.primarySubject?.id === deviceCode ||
          entry.secondarySubject?.id === deviceCode ||
          entry.metadata?.deviceCode === deviceCode
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 12);
    const businessDayRecords = this.store.inventory.filter(
      (entry) =>
        entry.deviceCode === deviceCode && getBusinessDayKey(entry.happenedAt) === businessDateKey
    );
    const businessDayServedUsers = Object.values(
      businessDayRecords.reduce<Record<string, {
        userId: string;
        userName: string;
        role: DeviceMonitoringDetail["businessDayServedUsers"][number]["role"];
        goods: Map<string, number>;
        totalQuantity: number;
        lastServedAt: string;
      }>>((accumulator, entry) => {
        if (!["pickup", "donation", "manual-restock", "manual-deduction"].includes(entry.type)) {
          return accumulator;
        }

        const user = this.store.users.find((candidate) => candidate.id === entry.userId);
        const existing =
          accumulator[entry.userId] ??
          {
            userId: entry.userId,
            userName: user?.name ?? entry.userId,
            role: user?.role ?? "special",
            goods: new Map<string, number>(),
            totalQuantity: 0,
            lastServedAt: entry.happenedAt
          };

        existing.goods.set(entry.goodsName, (existing.goods.get(entry.goodsName) ?? 0) + entry.quantity);
        existing.totalQuantity += entry.quantity;
        if (entry.happenedAt > existing.lastServedAt) {
          existing.lastServedAt = entry.happenedAt;
        }
        accumulator[entry.userId] = existing;
        return accumulator;
      }, {})
    )
      .map((entry) => ({
        userId: entry.userId,
        userName: entry.userName,
        role: entry.role,
        goodsSummary: Array.from(entry.goods.entries())
          .map(([goodsName, quantity]) => `${goodsName} x${quantity}`)
          .join("，"),
        totalQuantity: entry.totalQuantity,
        lastServedAt: entry.lastServedAt
      }))
      .sort((left, right) => right.lastServedAt.localeCompare(left.lastServedAt));
    const stockChanges = device.doors
      .flatMap((door) => door.goods)
      .map((goods) => {
        const setting = this.store.getDeviceGoodsSetting(deviceCode, goods.goodsId);
        const deltaSinceStartOfBusinessDay = businessDayRecords.reduce((sum, entry) => {
          if (entry.goodsId !== goods.goodsId) {
            return sum;
          }

          if (entry.type === "pickup" || entry.type === "expired" || entry.type === "manual-deduction") {
            return sum - entry.quantity;
          }

          if (entry.type === "donation" || entry.type === "manual-restock") {
            return sum + entry.quantity;
          }

          return sum;
        }, 0);

        return {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          currentStock: this.store.getCurrentStock(deviceCode, goods.goodsId),
          deltaSinceStartOfBusinessDay,
          thresholdEnabled: Boolean(setting?.enabled),
          lowStockThreshold: setting?.enabled ? setting.lowStockThreshold : undefined,
          nearestExpiryAt: this.store.getNearestExpiryAt(deviceCode, goods.goodsId)
        };
      });

    return {
      device: this.decorateDevice(device),
      runtime: this.store.getDeviceRuntime(deviceCode),
      businessDateKey,
      servedUsers: new Set(
        this.store.inventory
          .filter((entry) => entry.deviceCode === deviceCode && entry.type === "pickup")
          .map((entry) => entry.userId)
      ).size,
      totalStock: device.doors
        .flatMap((door) => door.goods)
        .reduce((sum, goods) => sum + this.store.getCurrentStock(deviceCode, goods.goodsId), 0),
      pendingTasks: this.store.alerts
        .filter((entry) => entry.deviceCode === deviceCode && entry.status !== "resolved")
        .sort((left, right) => left.dueAt.localeCompare(right.dueAt)),
      recentEvents,
      recentLogs,
      businessDayServedUsers,
      stockChanges
    };
  }

  private attachPaymentRecoveryState(event: CabinetEventRecord): CabinetEventRecord {
    return {
      ...event,
      paymentRecovery: {
        pendingRefund: this.findPendingRefundRecovery(event, event.orderNo)
      },
      adjustments: event.adjustments?.map((adjustment) => ({
        ...adjustment,
        paymentRecovery: {
          pendingRefund: this.findPendingRefundRecovery(event, adjustment.orderNo)
        }
      }))
    };
  }

  private findPendingRefundRecovery(
    event: CabinetEventRecord,
    businessOrderNo: string
  ): PaymentRefundRecoverySummary | undefined {
    const paymentOrderIds = new Set(
      this.store.paymentOrders
        .filter(
          (order) =>
            order.eventId === event.eventId &&
            (order.adjustmentOrderNo ?? order.orderNo) === businessOrderNo
        )
        .map((order) => order.id)
    );
    const refund = this.store.paymentRefunds
      .filter(
        (entry) =>
          entry.status === "pending" &&
          (
            entry.businessOrderNo === businessOrderNo ||
            paymentOrderIds.has(entry.paymentOrderId)
          )
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    if (!refund) {
      return undefined;
    }

    return {
      id: refund.id,
      paymentOrderId: refund.paymentOrderId,
      refundNo: refund.refundNo,
      provider: refund.provider,
      status: refund.status,
      amount: refund.amount,
      sourceRequestId: refund.sourceRequestId,
      providerOutcome: refund.providerOutcome,
      businessApplyState: refund.businessApplyState,
      failReason: refund.failReason,
      createdAt: refund.createdAt,
      updatedAt: refund.updatedAt
    };
  }

  private decorateDevice(device: DeviceRecord, viewerRole?: UserRole): DeviceRecord {
    const readiness = this.deviceOperations.getReadiness(device.deviceCode);

    return {
      ...device,
      readiness,
      doors: device.doors.map((door) => ({
        ...door,
        goods: door.goods.map((goods) => {
          const setting = this.store.getDeviceGoodsSetting(device.deviceCode, goods.goodsId);
          const nearestExpiryAt =
            viewerRole === "special"
              ? this.store.getNearestAvailableExpiryAt(device.deviceCode, goods.goodsId)
              : this.store.getNearestExpiryAt(device.deviceCode, goods.goodsId);
          const expiringSoon =
            nearestExpiryAt !== undefined &&
            new Date(nearestExpiryAt).getTime() - Date.now() < 24 * 60 * 60_000 &&
            new Date(nearestExpiryAt).getTime() > Date.now();

          const thresholdEnabled = Boolean(setting?.enabled);

          return {
            ...goods,
            stock: this.getStockForViewer(device.deviceCode, goods.goodsId, viewerRole),
            expiresAt: nearestExpiryAt,
            thresholdEnabled,
            lowStockThreshold: thresholdEnabled ? setting?.lowStockThreshold : undefined,
            expiringSoon
          };
        })
      }))
    };
  }

  async getGoods(deviceCode: string, doorNum?: string, viewerRole?: UserRole) {
    const localDevice = this.getByCode(deviceCode);

    try {
      const remoteGoods = await this.smartVmGateway.getGoodsInfo({
        deviceCode,
        doorNum
      });

      if (remoteGoods?.length) {
        for (const remoteItem of remoteGoods) {
          const localMatch = localDevice.doors
            .flatMap((door) => door.goods)
            .find((goods) => goods.goodsId === remoteItem.goodsId);
          const category = localMatch?.category ?? "daily";

          const catalogItem = this.store.ensureGoodsCatalogItem({
            goodsCode: remoteItem.goodsCode,
            goodsId: remoteItem.goodsId,
            name: remoteItem.name,
            fullName: remoteItem.name,
            category,
            price: remoteItem.price,
            imageUrl: remoteItem.imageUrl,
            status: "active"
          });

          this.store.ensureDeviceGoodsEntry(deviceCode, {
            goodsCode: catalogItem.goodsCode,
            goodsId: catalogItem.goodsId,
            name: catalogItem.name,
            fullName: catalogItem.fullName,
            category: catalogItem.category,
            categoryName: catalogItem.categoryName,
            price: catalogItem.price,
            imageUrl: catalogItem.imageUrl,
            packageForm: catalogItem.packageForm,
            specification: catalogItem.specification,
            manufacturer: catalogItem.manufacturer
          });
        }

        return remoteGoods.map((remoteItem) => {
          const localMatch = localDevice.doors
            .flatMap((door) => door.goods)
            .find((goods) => goods.goodsId === remoteItem.goodsId);
          const availableExpiryAt =
            viewerRole === "special"
              ? this.store.getNearestAvailableExpiryAt(deviceCode, remoteItem.goodsId)
              : remoteItem.expiresAt;

          return {
            ...remoteItem,
            category: localMatch?.category ?? "daily",
            stock: this.getStockForViewer(deviceCode, remoteItem.goodsId, viewerRole),
            expiresAt: availableExpiryAt
          };
        });
      }
    } catch {
      // 外部测试服务不稳定时，回退到本地种子数据，保证前端流程可继续调试。
    }

    return localDevice.doors
      .filter((door) => !doorNum || door.doorNum === doorNum)
      .flatMap((door) =>
        door.goods.map((goods) => ({
          ...goods,
          stock: this.getStockForViewer(deviceCode, goods.goodsId, viewerRole),
          expiresAt:
            viewerRole === "special"
              ? this.store.getNearestAvailableExpiryAt(deviceCode, goods.goodsId)
              : goods.expiresAt
        }))
      );
  }

  private getStockForViewer(deviceCode: string, goodsId: string, viewerRole?: UserRole) {
    return viewerRole === "special"
      ? this.store.getAvailableStock(deviceCode, goodsId)
      : this.store.getCurrentStock(deviceCode, goodsId);
  }

  async refreshDevice(deviceCode: string, actorUserId?: string) {
    const device = this.getByCode(deviceCode);
    const now = new Date().toISOString();
    let remoteStatus: SmartVmRouterStatusResult | undefined;
    const runtimePatch: Partial<DeviceRuntimeState> = {
      lastRefreshAt: now
    };

    try {
      remoteStatus = await this.smartVmGateway.getRouterStatus({ deviceCode });
    } catch (error) {
      const detail = this.smartVmGateway.extractErrorMessage(error);
      this.store.updateDeviceRuntime(deviceCode, runtimePatch);
      this.store.logOperation({
        category: "device",
        type: "manual-refresh-device",
        status: "failed",
        actor: this.getAdminActor(actorUserId),
        primarySubject: {
          type: "device",
          id: device.deviceCode,
          label: device.name
        },
        description: `管理员刷新 ${device.name} 的平台状态失败。`,
        detail: `柜机平台返回：${detail}`,
        metadata: {
          deviceCode: device.deviceCode,
          undoState: "not_undoable"
        }
      });
      throw new BadGatewayException(`柜机平台状态读取失败：${detail}`);
    }

    const remoteDeviceStatus = this.resolveRemoteDeviceStatus(remoteStatus);
    const remoteDoorState = this.resolveRemoteDoorState(remoteStatus);

    if (remoteDeviceStatus) {
      device.status = remoteDeviceStatus;
      if (remoteDeviceStatus === "online") {
        device.lastSeenAt = now;
      }
    }

    if (remoteDoorState) {
      runtimePatch.doorState = remoteDoorState;
    }

    const recoveredPhysicalDoorEventCount =
      remoteStatus && remoteDoorState === "closed"
        ? this.reconcilePendingDoorEventsAfterTrustedClose(deviceCode, now)
        : 0;

    if (remoteStatus && remoteDoorState === "closed") {
      runtimePatch.lastClosedAt = now;
    }

    this.store.updateDeviceRuntime(deviceCode, runtimePatch);
    this.store.logOperation({
      category: "device",
      type: "manual-refresh-device",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: device.deviceCode,
        label: device.name
      },
      description: `管理员刷新了 ${device.name} 的设备状态。`,
      detail: remoteStatus
        ? `设备 ${device.deviceCode} 已从平台读取状态：${remoteDeviceStatus ? `设备${remoteDeviceStatus}` : "设备状态未返回"}，${remoteDoorState ? `门${remoteDoorState}` : "门状态未返回"}；恢复未决门事件 ${recoveredPhysicalDoorEventCount} 笔。`
        : `设备 ${device.deviceCode} 已刷新本地状态；当前未配置 SmartVM 凭据，未读取平台状态。`,
      metadata: {
        deviceCode: device.deviceCode,
        remoteStatus,
        recoveredPhysicalDoorEventCount,
        doorRecoveryEvidence: remoteStatus
          ? remoteDoorState === "closed"
            ? "trusted-remote-closed"
            : remoteDoorState
              ? `trusted-remote-${remoteDoorState}`
              : "remote-door-state-missing"
          : "smartvm-not-configured"
      }
    });

    return this.monitoringDetail(deviceCode);
  }

  private reconcilePendingDoorEventsAfterTrustedClose(deviceCode: string, observedAt: string) {
    let recoveredCount = 0;

    for (const event of this.store.events) {
      if (
        event.deviceCode !== deviceCode ||
        (event.physicalDoorState !== "unknown" && event.physicalDoorState !== "open")
      ) {
        continue;
      }

      event.physicalDoorState = "closed";

      if (
        event.status === "created" ||
        event.status === "opening" ||
        event.status === "opened" ||
        event.status === "stuck_open"
      ) {
        event.status = "closed";
      }

      // settled / refunded 等业务终态只协调物理门状态，绝不因设备刷新而回退账务状态。
      event.updatedAt = observedAt;
      recoveredCount += 1;
    }

    return recoveredCount;
  }

  private normalizeSmartVmState(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }

    return String(value).trim();
  }

  private resolveRemoteDeviceStatus(status?: SmartVmRouterStatusResult): Extract<DeviceStatus, "online" | "offline"> | undefined {
    const normalized = this.normalizeSmartVmState(status?.online ?? status?.routerInfo?.online ?? status?.vendingInfo?.online);

    if (normalized === "0") {
      return "online";
    }

    if (normalized === "1") {
      return "offline";
    }

    return undefined;
  }

  private resolveRemoteDoorState(status?: SmartVmRouterStatusResult): DeviceRuntimeState["doorState"] | undefined {
    const normalized = this.normalizeSmartVmState(status?.doorState ?? status?.vendingInfo?.doorState);

    if (normalized === "0") {
      return "open";
    }

    if (normalized === "1") {
      return "closed";
    }

    return undefined;
  }

  async remoteOpen(
    deviceCode: string,
    payload: { doorNum?: string; reason: string },
    actorUserId?: string
  ) {
    const reason = payload?.reason?.trim();
    const nonWhitespaceReasonLength = reason ? [...reason.replace(/\s/gu, "")].length : 0;

    if (!reason || nonWhitespaceReasonLength < 4 || reason.length > 200) {
      throw new BadRequestException("远程开门原因需包含至少 4 个非空字符，且总长度不能超过 200 个字符。");
    }

    const device = this.getByCode(deviceCode);

    if (device.status === "offline") {
      throw new BadRequestException("柜机当前离线，不能远程开门。");
    }

    if (this.store.getDeviceRuntime(deviceCode).doorState === "open") {
      throw new BadRequestException("柜门当前已开启，不能重复远程开门。");
    }

    const requestedDoorNum: unknown = payload?.doorNum ?? "1";

    if (typeof requestedDoorNum !== "string") {
      throw new BadRequestException("柜门编号必须为有效的正整数。");
    }

    const doorNum = requestedDoorNum.trim();
    const numericDoorNum = Number(doorNum);

    if (!/^[1-9]\d*$/u.test(doorNum) || !Number.isSafeInteger(numericDoorNum)) {
      throw new BadRequestException("柜门编号必须为有效的正整数。");
    }

    if (!device.doors.some((door) => door.doorNum === doorNum)) {
      throw new BadRequestException("该柜机不存在对应柜门。");
    }

    return this.deviceOperations.runExclusiveOpen({ deviceCode, doorNum }, async () => {
      const admin =
        this.store.users.find((entry) => entry.id === actorUserId) ??
        this.store.users.find((entry) => entry.role === "admin");
      const eventId = this.store.createId("event");
      const createdAt = new Date().toISOString();
      const commandEvent: CabinetEventRecord = {
        eventId,
        orderNo: `pending-${eventId}`,
        userId: admin?.id ?? "admin-virtual",
        phone: admin?.phone ?? "13800000001",
        role: "admin",
        deviceCode,
        doorNum,
        status: "created",
        createdAt,
        updatedAt: createdAt,
        amount: 0,
        goods: []
      };
      this.store.events.unshift(commandEvent);
      this.store.updateDeviceRuntime(deviceCode, {
        lastCommandAt: createdAt,
        openedAfterLastCommand: false
      });
      // 先保存稳定 eventId 的命令意图，再向远端下发，进程重启后仍可识别在途命令。
      this.store.persist();

      let openResult: Awaited<ReturnType<SmartVmGateway["openDoor"]>>;

      try {
        openResult = await this.smartVmGateway.openDoor({
          userId: admin?.id ?? "admin-virtual",
          eventId,
          deviceCode,
          doorNum,
          phone: admin?.phone ?? "13800000001"
        });
      } catch (error) {
        const detail = this.smartVmGateway.extractErrorMessage(error);
        const smartVmExchange = this.smartVmGateway.extractExchangeTrace(error);
        const definitelyRejected =
          this.smartVmGateway.isDefiniteOpenDoorRejection?.(error) ?? false;

        if (commandEvent.status === "created" || commandEvent.status === "opening") {
          commandEvent.status = definitelyRejected ? "failed" : commandEvent.status;
          commandEvent.updatedAt = new Date().toISOString();
        }

        const commandRejected = definitelyRejected || commandEvent.status === "failed";
        const outcomeUnknown =
          commandEvent.status === "created" || commandEvent.status === "opening";

        this.store.logOperation({
          category: "admin",
          type: "remote-open-device",
          status: commandRejected ? "failed" : outcomeUnknown ? "pending" : "success",
          actor: this.getAdminActor(actorUserId),
          primarySubject: {
            type: "device",
            id: device.deviceCode,
            label: device.name
          },
          secondarySubject: {
            type: "event",
            id: eventId,
            label: eventId
          },
          description: commandRejected
            ? `管理员向 ${device.name} 下发的远程开门指令被平台拒绝。`
            : outcomeUnknown
              ? `管理员向 ${device.name} 下发的远程开门指令结果待确认。`
              : `管理员向 ${device.name} 下发的远程开门指令已由设备回调确认。`,
          detail: commandRejected
            ? `柜机平台明确拒绝：${detail}`
            : outcomeUnknown
              ? `柜机平台结果未知：${detail}；为避免重复开门，命令租约仍保留。`
              : `柜机网关响应异常，但设备回调已确认事件状态为 ${commandEvent.status}。`,
          relatedEventId: eventId,
          metadata: {
            deviceCode,
            doorNum,
            reason,
            commandOutcome: commandRejected
              ? "rejected"
              : outcomeUnknown
                ? "unknown"
                : "callback_confirmed",
            smartVmExchange,
            undoState: "not_undoable"
          }
        });
        this.store.persist();
        if (outcomeUnknown) {
          throw new ConflictException({
            message: "柜机平台响应异常，开门结果待确认，请勿重复操作。",
            code: "operation_indeterminate",
            operationId: eventId,
            retryable: false
          });
        }

        if (commandRejected) {
          throw new ConflictException({
            message: "柜机平台已拒绝开门请求。",
            code: "operation_rejected",
            operationId: eventId,
            retryable: false
          });
        }

        throw new ConflictException({
          message: "柜机开门状态已由平台回调确认，请刷新状态后继续。",
          code: "operation_confirmed",
          operationId: eventId,
          retryable: false
        });
      }

      commandEvent.orderNo = openResult.orderNo;
      commandEvent.updatedAt = new Date().toISOString();
      this.store.logOperation({
        category: "admin",
        type: "remote-open-device",
        status: "pending",
        actor: this.getAdminActor(actorUserId),
        primarySubject: {
          type: "device",
          id: device.deviceCode,
          label: device.name
        },
        secondarySubject: {
          type: "event",
          id: eventId,
          label: openResult.orderNo
        },
        description: `管理员向 ${device.name} 下发了远程开门指令。`,
        detail: `设备 ${device.deviceCode} 已收到远程开门请求，等待门状态回调。`,
        relatedEventId: eventId,
        relatedOrderNo: openResult.orderNo,
        metadata: {
          deviceCode,
          doorNum,
          reason,
          smartVmExchange: openResult.smartVmExchange
        }
      });
      this.store.persist();

      return {
        eventId,
        orderNo: openResult.orderNo,
        deviceCode,
        doorNum
      };
    });
  }

  findGoods(deviceCode: string, goodsId: string) {
    return this.getByCode(deviceCode).doors
      .flatMap((door) => door.goods)
      .find((goods) => goods.goodsId === goodsId);
  }

  adjustStock(deviceCode: string, goodsId: string, delta: number) {
    if (delta > 0) {
      const existing = this.store.getGoodsBatches(deviceCode, goodsId).at(0);
      this.inventoryBatchChanges.recordBatchOnly({
        goodsId,
        deviceCode,
        quantity: delta,
        sourceType: "system",
        sourceUserName: "系统补录",
        expiresAt: existing?.expiresAt
      });
      return;
    }

    this.inventoryBatchChanges.consumeBatchesOnly({
      deviceCode,
      goodsId,
      quantity: Math.abs(delta),
      allowExpiredBatches: true
    });
  }

  addOrUpdateGoods(deviceCode: string, goods: DeviceGoods) {
    return this.store.ensureDeviceGoodsEntry(deviceCode, goods);
  }

  addGoodsToDevice(
    deviceCode: string,
    payload: {
      goodsId: string;
      doorNum?: string;
    },
    actorUserId?: string
  ) {
    const device = this.getByCode(deviceCode);
    const goods = this.store.goodsCatalog.find(
      (entry) => entry.goodsId === payload.goodsId && entry.status !== "inactive"
    );

    if (!goods) {
      throw new NotFoundException("未找到对应货品。");
    }

    const targetDoor =
      device.doors.find((door) => door.doorNum === (payload.doorNum ?? "1")) ??
      device.doors[0];

    this.store.ensureDeviceGoodsEntry(deviceCode, {
      goodsId: goods.goodsId,
      goodsCode: goods.goodsCode,
      name: goods.name,
      fullName: goods.fullName,
      category: goods.category,
      categoryName: goods.categoryName,
      price: goods.price,
      imageUrl: goods.imageUrl,
      packageForm: goods.packageForm,
      specification: goods.specification,
      manufacturer: goods.manufacturer
    });

    this.store.logOperation({
      category: "goods",
      type: "add-device-goods",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: device.deviceCode,
        label: device.name
      },
      secondarySubject: {
        type: "goods",
        id: goods.goodsId,
        label: goods.name
      },
      metadata: {
        deviceCode,
        goodsId: goods.goodsId,
        goodsName: goods.name,
        doorNum: targetDoor?.doorNum ?? payload.doorNum ?? "1",
        undoState: "not_undoable"
      }
    });

    return this.monitoringDetail(deviceCode);
  }

  removeGoodsFromDevice(
    deviceCode: string,
    goodsId: string,
    payload?: { doorNum?: string },
    actorUserId?: string
  ) {
    const device = this.getByCode(deviceCode);
    const currentStock = this.store.getCurrentStock(deviceCode, goodsId);

    if (currentStock > 0) {
      throw new NotFoundException("当前货品库存未清零，不能移除。");
    }

    const goods =
      this.findGoods(deviceCode, goodsId) ?? this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);

    if (!goods) {
      throw new NotFoundException("未找到对应货品。");
    }

    const removed = this.store.removeDeviceGoodsEntry(deviceCode, goodsId, payload?.doorNum);

    if (!removed) {
      throw new NotFoundException("未找到对应货品。");
    }

    this.store.logOperation({
      category: "goods",
      type: "remove-device-goods",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: device.deviceCode,
        label: device.name
      },
      secondarySubject: {
        type: "goods",
        id: goodsId,
        label: goods.name
      },
      metadata: {
        deviceCode,
        goodsId,
        goodsName: goods.name,
        doorNum: payload?.doorNum ?? "1",
        undoState: "not_undoable"
      }
    });

    return this.monitoringDetail(deviceCode);
  }

  updateLocation(
    deviceCode: string,
    payload: {
      location?: string;
      address?: string;
      longitude?: number;
      latitude?: number;
    },
    actorUserId?: string
  ) {
    const device = this.getByCode(deviceCode);
    if (payload.location !== undefined) {
      device.location = payload.location;
    }
    if (payload.address !== undefined) {
      device.address = payload.address;
    }
    if (payload.longitude !== undefined) {
      device.longitude = payload.longitude;
    }
    if (payload.latitude !== undefined) {
      device.latitude = payload.latitude;
    }

    this.store.logOperation({
      category: "device",
      type: "update-device-location",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: device.deviceCode,
        label: device.name
      },
      description: `管理员更新了 ${device.name} 的地图位置。`,
      detail: `${device.name} 已更新位置为 ${device.location}${device.longitude !== undefined && device.latitude !== undefined ? `（${device.longitude}, ${device.latitude}）` : ""}。`,
      metadata: {
        deviceCode: device.deviceCode,
        longitude: device.longitude,
        latitude: device.latitude
      }
    });

    return {
      ...device,
      runtime: this.store.getDeviceRuntime(device.deviceCode)
    };
  }

  upsertMockDevice(payload: {
    deviceCode: string;
    name: string;
    location: string;
    address?: string;
    longitude?: number;
    latitude?: number;
    status?: DeviceStatus;
    doorNum?: string;
    goods: Array<{
      goodsId: string;
      goodsCode?: string;
      name: string;
      category: GoodsCategory;
      stock: number;
      price?: number;
      imageUrl?: string;
      expiresAt?: string;
    }>;
  }, actorUserId?: string) {
    if (!this.isLocalMockDeviceApiEnabled()) {
      throw new ForbiddenException(
        "模拟柜机接口未启用，仅可在本机联调环境显式开启。"
      );
    }

    const now = new Date().toISOString();
    const doorNum = payload.doorNum ?? "1";
    const normalizedGoods: DeviceGoods[] = payload.goods.map((goods) => ({
      goodsId: goods.goodsId,
      goodsCode: goods.goodsCode ?? goods.goodsId,
      name: goods.name,
      category: goods.category,
      stock: goods.stock,
      price: goods.price ?? 0,
      imageUrl:
        goods.imageUrl ??
        "https://dummyimage.com/160x160/d8e8ff/0b1220.png&text=%E6%A8%A1%E6%8B%9F%E7%89%A9%E8%B5%84",
      expiresAt: goods.expiresAt
    }));

    const existing = this.store.devices.find((entry) => entry.deviceCode === payload.deviceCode);

    if (existing) {
      if (existing.isMock !== true) {
        throw new ForbiddenException("不能用模拟柜机接口覆盖真实设备档案。");
      }

      existing.name = payload.name;
      existing.location = payload.location;
      existing.address = payload.address;
      existing.longitude = payload.longitude;
      existing.latitude = payload.latitude;
      existing.status = payload.status ?? "online";
      existing.lastSeenAt = now;

      const targetDoor =
        existing.doors.find((door) => door.doorNum === doorNum) ??
        (() => {
          const createdDoor = {
            doorNum,
            label: `门 ${doorNum}`,
            goods: []
          };
          existing.doors.push(createdDoor);
          return createdDoor;
        })();

      targetDoor.goods = normalizedGoods;
      for (let index = this.store.goodsBatches.length - 1; index >= 0; index -= 1) {
        if (this.store.goodsBatches[index].deviceCode === existing.deviceCode) {
          this.store.goodsBatches.splice(index, 1);
        }
      }
      for (const goods of normalizedGoods) {
        this.store.ensureGoodsCatalogItem({
          goodsCode: goods.goodsCode,
          goodsId: goods.goodsId,
          name: goods.name,
          category: goods.category,
          price: goods.price,
          imageUrl: goods.imageUrl,
          status: "active"
        });
        if (goods.stock > 0) {
          this.inventoryBatchChanges.recordBatchOnly({
            goodsId: goods.goodsId,
            deviceCode: existing.deviceCode,
            quantity: goods.stock,
            expiresAt: goods.expiresAt,
            sourceType: "system",
            sourceUserName: "系统补录"
          });
        }
      }
      this.store.syncDeviceStocksFromBatches(existing.deviceCode);
      this.store.updateDeviceRuntime(existing.deviceCode, {
        deviceCode: existing.deviceCode,
        doorState: "closed",
        lastClosedAt: now,
        lastRefreshAt: now,
        openedAfterLastCommand: true
      });
      this.store.logOperation({
        category: "device",
        type: "upsert-mock-device",
        status: "success",
        actor: this.getAdminActor(actorUserId),
        primarySubject: {
          type: "device",
          id: existing.deviceCode,
          label: existing.name
        },
        description: `管理员更新了模拟柜机 ${existing.name}。`,
        detail: `设备 ${existing.deviceCode} 的模拟货道数据已重新写入。`,
        metadata: {
          deviceCode: existing.deviceCode
        }
      });
      return existing;
    }

    const created: DeviceRecord = {
      deviceCode: payload.deviceCode,
      isMock: true,
      name: payload.name,
      location: payload.location,
      address: payload.address,
      longitude: payload.longitude,
      latitude: payload.latitude,
      status: payload.status ?? "online",
      lastSeenAt: now,
      doors: [
        {
          doorNum,
          label: `门 ${doorNum}`,
          goods: normalizedGoods
        }
      ]
    };

    this.store.devices.unshift(created);
    for (const goods of normalizedGoods) {
      this.store.ensureGoodsCatalogItem({
        goodsCode: goods.goodsCode,
        goodsId: goods.goodsId,
        name: goods.name,
        category: goods.category,
        price: goods.price,
        imageUrl: goods.imageUrl,
        status: "active"
      });
      if (goods.stock > 0) {
        this.inventoryBatchChanges.recordBatchOnly({
          goodsId: goods.goodsId,
          deviceCode: created.deviceCode,
          quantity: goods.stock,
          expiresAt: goods.expiresAt,
          sourceType: "system",
          sourceUserName: "系统补录"
        });
      }
    }
    this.store.syncDeviceStocksFromBatches(created.deviceCode);
    this.store.updateDeviceRuntime(created.deviceCode, {
      deviceCode: created.deviceCode,
      doorState: "closed",
      lastClosedAt: now,
      lastRefreshAt: now,
      openedAfterLastCommand: true
    });
    this.store.logOperation({
      category: "device",
      type: "create-mock-device",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: created.deviceCode,
        label: created.name
      },
      description: `管理员新增了模拟柜机 ${created.name}。`,
      detail: `设备 ${created.deviceCode} 已创建，并写入初始货道与库存数据。`,
      metadata: {
        deviceCode: created.deviceCode
      }
    });
    return created;
  }

  private isLocalMockDeviceApiEnabled() {
    if (isProductionRuntime() || this.isLiveDataPlane()) {
      return false;
    }

    const explicitlyEnabled = ["1", "true", "yes", "on"].includes(
      (process.env.ENABLE_LOCAL_MOCK_DEVICE_API ?? "").trim().toLowerCase()
    );
    const apiHost = (process.env.API_HOST ?? "127.0.0.1").trim().toLowerCase();
    const isLoopbackHost =
      apiHost === "localhost" ||
      apiHost === "::1" ||
      apiHost.startsWith("127.");

    return explicitlyEnabled && isLoopbackHost;
  }

  private isLiveDataPlane() {
    const store = this.store as unknown as {
      isLiveDataPlane?: () => boolean;
    };

    return typeof store.isLiveDataPlane === "function" && store.isLiveDataPlane();
  }

  private getAdminActor(actorUserId?: string) {
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }

  private calculateDistanceMeters(
    startLatitude: number,
    startLongitude: number,
    endLatitude: number,
    endLongitude: number
  ) {
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const earthRadius = 6_371_000;
    const deltaLatitude = toRadians(endLatitude - startLatitude);
    const deltaLongitude = toRadians(endLongitude - startLongitude);
    const a =
      Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
      Math.cos(toRadians(startLatitude)) *
        Math.cos(toRadians(endLatitude)) *
        Math.sin(deltaLongitude / 2) *
        Math.sin(deltaLongitude / 2);

    return Math.round(2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }
}
