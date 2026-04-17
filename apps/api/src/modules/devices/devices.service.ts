import { BadGatewayException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { DeviceGoods, DeviceMonitoringDetail, DeviceRecord, DeviceStatus, GoodsCategory } from "@vm/shared-types";

import { getBusinessDayKey } from "../../common/time/business-day";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { SmartVmGateway } from "./smartvm.gateway";

@Injectable()
export class DevicesService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway
  ) {}

  list(origin?: { longitude?: number; latitude?: number }) {
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
        ...this.decorateDevice(device),
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

  monitoringDetail(deviceCode: string): DeviceMonitoringDetail {
    const device = this.getByCode(deviceCode);
    const businessDateKey = getBusinessDayKey(new Date());
    const recentEvents = this.store.events
      .filter((entry) => entry.deviceCode === deviceCode)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12);
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

  private decorateDevice(device: DeviceRecord): DeviceRecord {
    return {
      ...device,
      doors: device.doors.map((door) => ({
        ...door,
        goods: door.goods.map((goods) => {
          const setting = this.store.getDeviceGoodsSetting(device.deviceCode, goods.goodsId);
          const nearestExpiryAt = this.store.getNearestExpiryAt(device.deviceCode, goods.goodsId);
          const expiringSoon =
            nearestExpiryAt !== undefined &&
            new Date(nearestExpiryAt).getTime() - Date.now() < 24 * 60 * 60_000 &&
            new Date(nearestExpiryAt).getTime() > Date.now();

          const thresholdEnabled = Boolean(setting?.enabled);

          return {
            ...goods,
            stock: this.store.getCurrentStock(device.deviceCode, goods.goodsId),
            expiresAt: nearestExpiryAt,
            thresholdEnabled,
            lowStockThreshold: thresholdEnabled ? setting?.lowStockThreshold : undefined,
            expiringSoon
          };
        })
      }))
    };
  }

  async getGoods(deviceCode: string, doorNum?: string) {
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

          return {
            ...remoteItem,
            category: localMatch?.category ?? "daily",
            stock: this.store.getCurrentStock(deviceCode, remoteItem.goodsId)
          };
        });
      }
    } catch {
      // 外部测试服务不稳定时，回退到本地种子数据，保证前端流程可继续调试。
    }

    return localDevice.doors
      .filter((door) => !doorNum || door.doorNum === doorNum)
      .flatMap((door) => door.goods);
  }

  async refreshDevice(deviceCode: string, actorUserId?: string) {
    const device = this.getByCode(deviceCode);
    const now = new Date().toISOString();
    device.lastSeenAt = now;
    this.store.updateDeviceRuntime(deviceCode, {
      lastRefreshAt: now
    });
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
      detail: `设备 ${device.deviceCode} 已执行手工刷新，最近心跳时间更新为 ${now}。`,
      metadata: {
        deviceCode: device.deviceCode
      }
    });

    return this.monitoringDetail(deviceCode);
  }

  async remoteOpen(deviceCode: string, payload?: { doorNum?: string }, actorUserId?: string) {
    const device = this.getByCode(deviceCode);
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");
    const eventId = this.store.createId("event");
    const createdAt = new Date().toISOString();
    let openResult: Awaited<ReturnType<SmartVmGateway["openDoor"]>>;

    try {
      openResult = await this.smartVmGateway.openDoor({
        userId: admin?.id ?? "admin-virtual",
        eventId,
        deviceCode,
        doorNum: payload?.doorNum ?? "1",
        phone: admin?.phone ?? "13800000001"
      });
    } catch (error) {
      const detail = this.smartVmGateway.extractErrorMessage(error);
      this.store.logOperation({
        category: "admin",
        type: "remote-open-device",
        status: "failed",
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
        description: `管理员向 ${device.name} 下发的远程开门指令失败。`,
        detail: `柜机平台返回：${detail}`,
        metadata: {
          deviceCode,
          doorNum: payload?.doorNum ?? "1",
          undoState: "not_undoable"
        }
      });
      throw new BadGatewayException(`柜机平台开柜失败：${detail}`);
    }

    this.store.events.unshift({
      eventId,
      orderNo: openResult.orderNo,
      userId: admin?.id ?? "admin-virtual",
      phone: admin?.phone ?? "13800000001",
      role: "admin",
      deviceCode,
      doorNum: payload?.doorNum ?? "1",
      status: "created",
      createdAt,
      updatedAt: createdAt,
      amount: 0,
      goods: []
    });

    this.store.updateDeviceRuntime(deviceCode, {
      lastCommandAt: createdAt,
      openedAfterLastCommand: false
    });

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
        doorNum: payload?.doorNum ?? "1"
      }
    });

    return {
      eventId,
      orderNo: openResult.orderNo,
      deviceCode,
      doorNum: payload?.doorNum ?? "1"
    };
  }

  findGoods(deviceCode: string, goodsId: string) {
    return this.getByCode(deviceCode).doors
      .flatMap((door) => door.goods)
      .find((goods) => goods.goodsId === goodsId);
  }

  adjustStock(deviceCode: string, goodsId: string, delta: number) {
    if (delta > 0) {
      const existing = this.store.getGoodsBatches(deviceCode, goodsId).at(0);
      this.store.createGoodsBatch({
        goodsId,
        deviceCode,
        quantity: delta,
        sourceType: "system",
        sourceUserName: "系统补录",
        expiresAt: existing?.expiresAt
      });
      return;
    }

    this.store.consumeGoodsBatches(deviceCode, goodsId, Math.abs(delta));
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
          this.store.createGoodsBatch({
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
        this.store.createGoodsBatch({
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
