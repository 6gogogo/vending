import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { DeviceRecord, PublicDevice, PublicDeviceGoods } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class PublicCatalogService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(tenantId: string): PublicDevice[] {
    return this.store.devices
      .filter((device) => this.store.getDeviceTenantId(device) === tenantId)
      .map((device) => this.present(device));
  }

  detail(deviceCode: string, tenantId: string): PublicDevice {
    const device = this.store.devices.find((entry) =>
      entry.deviceCode === deviceCode && this.store.getDeviceTenantId(entry) === tenantId
    );
    if (!device) throw new NotFoundException("未找到对应柜机。");
    return this.present(device);
  }

  private present(device: DeviceRecord): PublicDevice {
    const now = Date.now();
    return {
      deviceCode: device.deviceCode,
      name: device.name,
      location: device.location,
      address: device.address,
      status: device.status,
      doors: device.doors.map((door) => {
        const goods = new Map<string, PublicDeviceGoods>();
        for (const configured of door.goods) {
          const goodsId = this.store.resolveGoodsId(configured.goodsId);
          if (goods.has(goodsId)) continue;
          const item = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId) ?? configured;
          const status = item.status === "inactive" ? "inactive" : "active";
          goods.set(goodsId, {
            goodsId,
            name: item.name,
            category: item.category,
            imageUrl: item.imageUrl,
            status,
            // 与领取端共享预约、负库存和保质期口径；查询不刷新设备或改写账本。
            stock: status === "inactive" ? 0 : this.store.getReservableStock(device.deviceCode, goodsId, now)
          });
        }
        return { doorNum: door.doorNum, label: door.label, goods: [...goods.values()] };
      })
    };
  }
}
