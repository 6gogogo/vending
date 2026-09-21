import { Inject, Injectable } from "@nestjs/common";
import type { PublicProduct } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class PublicCatalogService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(tenantId: string): PublicProduct[] {
    const products = new Map<string, PublicProduct>();
    // 只选取当前实例配置的商品种类，不读取库存、预约、批次或柜门状态。
    for (const device of this.store.devices) {
      if (this.store.getDeviceTenantId(device) !== tenantId) continue;
      for (const door of device.doors) {
        for (const configured of door.goods) {
          const goodsId = this.store.resolveGoodsId(configured.goodsId);
          if (products.has(goodsId)) continue;
          const item = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId) ?? configured;
          if (item.status === "inactive") continue;
          products.set(goodsId, { goodsId, name: item.name, imageUrl: item.imageUrl });
        }
      }
    }
    return [...products.values()];
  }
}
