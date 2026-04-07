import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { DeviceGoods, DeviceRecord, DeviceStatus, GoodsCategory } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { SmartVmGateway } from "./smartvm.gateway";

@Injectable()
export class DevicesService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway
  ) {}

  list() {
    return this.store.devices;
  }

  getByCode(deviceCode: string) {
    const device = this.store.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      throw new NotFoundException("Device not found.");
    }

    return device;
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
            stock: localMatch?.stock ?? 0
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

  findGoods(deviceCode: string, goodsId: string) {
    return this.getByCode(deviceCode).doors
      .flatMap((door) => door.goods)
      .find((goods) => goods.goodsId === goodsId);
  }

  adjustStock(deviceCode: string, goodsId: string, delta: number) {
    const goods = this.findGoods(deviceCode, goodsId);

    if (goods) {
      goods.stock = Math.max(0, goods.stock + delta);
    }
  }

  addOrUpdateGoods(deviceCode: string, goods: DeviceGoods) {
    const device = this.getByCode(deviceCode);
    const primaryDoor = device.doors[0];
    const existing = primaryDoor.goods.find((entry) => entry.goodsId === goods.goodsId);

    if (existing) {
      Object.assign(existing, goods);
      return existing;
    }

    primaryDoor.goods.push(goods);
    return goods;
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
  }) {
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
    return created;
  }
}
