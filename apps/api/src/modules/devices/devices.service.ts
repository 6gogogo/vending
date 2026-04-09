import { Inject, Injectable, NotFoundException } from "@nestjs/common";

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

  list() {
    this.store.syncDeviceStocksFromBatches();
    return this.store.devices.map((device) => ({
      ...device,
      runtime: this.store.getDeviceRuntime(device.deviceCode)
    }));
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
      device,
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

  async getGoods(deviceCode: string, doorNum?: string) {
    const localDevice = this.getByCode(deviceCode);

    try {
      const remoteGoods = await this.smartVmGateway.getGoodsInfo({
        deviceCode,
        doorNum
      });

      if (remoteGoods?.length) {
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
    const openResult = await this.smartVmGateway.openDoor({
      userId: admin?.id ?? "admin-virtual",
      eventId,
      deviceCode,
      payStyle: "2",
      doorNum: payload?.doorNum ?? "1",
      phone: admin?.phone ?? "13800000001"
    });

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

  upsertMockDevice(payload: {
    deviceCode: string;
    name: string;
    location: string;
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
}
