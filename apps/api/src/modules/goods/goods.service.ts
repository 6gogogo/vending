import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { GoodsAlertPolicy, GoodsOverviewSnapshot, UserRole } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { SmartVmGateway } from "../devices/smartvm.gateway";

const LOW_STOCK_THRESHOLD = 2;

@Injectable()
export class GoodsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway
  ) {}

  listCatalog() {
    return [...this.store.goodsCatalog].sort((left, right) => left.goodsId.localeCompare(right.goodsId));
  }

  listAlertPolicies() {
    return this.store.goodsAlertPolicies;
  }

  createAlertPolicy(payload: Omit<GoodsAlertPolicy, "id">, actorUserId?: string) {
    const created: GoodsAlertPolicy = {
      id: this.store.createId("goods-policy"),
      ...payload
    };

    this.store.goodsAlertPolicies.unshift(created);
    this.store.logOperation({
      category: "goods",
      type: "create-goods-alert-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyId: created.id,
        policyName: created.name,
        deviceCount: created.applicableDeviceCodes.length
      }
    });
    return created;
  }

  updateAlertPolicy(id: string, payload: Partial<Omit<GoodsAlertPolicy, "id">>, actorUserId?: string) {
    const policy = this.store.goodsAlertPolicies.find((entry) => entry.id === id);

    if (!policy) {
      throw new NotFoundException("未找到对应的货品预警模板。");
    }

    Object.assign(policy, payload);
    this.store.logOperation({
      category: "goods",
      type: "update-goods-alert-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyId: policy.id,
        policyName: policy.name,
        deviceCount: policy.applicableDeviceCodes.length
      }
    });
    return policy;
  }

  batchAssignAlertPolicies(
    payload: {
      deviceCodes: string[];
      policyIds: string[];
      mode: "bind" | "unbind" | "replace";
    },
    actorUserId?: string
  ) {
    const targetPolicies = this.store.goodsAlertPolicies.filter((policy) =>
      payload.policyIds.includes(policy.id)
    );

    if (payload.mode === "replace") {
      for (const policy of this.store.goodsAlertPolicies) {
        policy.applicableDeviceCodes = policy.applicableDeviceCodes.filter(
          (deviceCode) => !payload.deviceCodes.includes(deviceCode)
        );
      }
    }

    for (const policy of targetPolicies) {
      if (payload.mode === "unbind") {
        policy.applicableDeviceCodes = policy.applicableDeviceCodes.filter(
          (deviceCode) => !payload.deviceCodes.includes(deviceCode)
        );
        continue;
      }

      policy.applicableDeviceCodes = Array.from(
        new Set([...policy.applicableDeviceCodes, ...payload.deviceCodes])
      );
    }

    this.store.logOperation({
      category: "goods",
      type: "batch-assign-goods-alert-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyIds: payload.policyIds,
        deviceCodes: payload.deviceCodes,
        mode: payload.mode
      }
    });

    return this.listAlertPolicies();
  }

  getLowStockThreshold(deviceCode: string, goodsId: string) {
    const matchingThresholds = this.store.goodsAlertPolicies
      .filter(
        (policy) =>
          policy.status === "active" && policy.applicableDeviceCodes.includes(deviceCode)
      )
      .flatMap((policy) => policy.thresholds)
      .filter((threshold) => threshold.goodsId === goodsId);

    return matchingThresholds.at(-1)?.lowStockThreshold ?? LOW_STOCK_THRESHOLD;
  }

  getOverview(): GoodsOverviewSnapshot {
    const goodsByDevice = this.store.devices.flatMap((device) =>
      device.doors.flatMap((door) =>
        door.goods.map((goods) => {
          const lowStockThreshold = this.getLowStockThreshold(device.deviceCode, goods.goodsId);

          return {
          deviceCode: device.deviceCode,
          deviceName: device.name,
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          stock: goods.stock,
          lowStockThreshold,
          status:
            goods.stock <= 0
              ? ("empty" as const)
              : goods.stock <= lowStockThreshold
                ? ("low" as const)
                : ("ok" as const)
          };
        })
      )
    );

    return {
      totalKinds: this.store.goodsCatalog.length,
      lowStockKinds: goodsByDevice.filter((item) => item.status === "low").length,
      outOfStockKinds: goodsByDevice.filter((item) => item.status === "empty").length,
      flaggedGoods: goodsByDevice
        .filter((item) => item.status !== "ok")
        .sort((left, right) => {
          if (left.status === right.status) {
            return left.deviceCode.localeCompare(right.deviceCode);
          }

          if (left.status === "empty") {
            return -1;
          }

          if (right.status === "empty") {
            return 1;
          }

          return left.deviceCode.localeCompare(right.deviceCode);
        }),
      byDevice: this.store.devices.map((device) => {
        const deviceGoods = goodsByDevice.filter((item) => item.deviceCode === device.deviceCode);

        return {
          deviceCode: device.deviceCode,
          deviceName: device.name,
          totalStock: deviceGoods.reduce((sum, item) => sum + item.stock, 0),
          kinds: deviceGoods.length,
          lowStockItems: deviceGoods.filter((item) => item.status !== "ok").length
        };
      }),
      byGoods: this.store.goodsCatalog
        .map((goods) => {
          const distribution = goodsByDevice
            .filter((item) => item.goodsId === goods.goodsId)
            .sort((left, right) => left.deviceCode.localeCompare(right.deviceCode));

          return {
            goodsId: goods.goodsId,
            goodsName: goods.name,
            category: goods.category,
            totalStock: distribution.reduce((sum, item) => sum + item.stock, 0),
            lowStockDevices: distribution.filter((item) => item.status === "low").length,
            outOfStockDevices: distribution.filter((item) => item.status === "empty").length,
            deviceDistribution: distribution
          };
        })
        .sort((left, right) => left.goodsId.localeCompare(right.goodsId)),
      recentLogs: this.store.logs
        .filter((entry) =>
          ["pickup", "restock", "inventory", "goods", "alert"].includes(entry.category)
        )
        .slice(0, 12)
    };
  }

  async syncDeviceGoods(deviceCode: string, doorNum = "1", actorUserId?: string) {
    const device = this.store.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const remoteGoods =
      (await this.smartVmGateway.getGoodsInfo({
        deviceCode,
        doorNum
      })) ?? [];

    const targetDoor =
      device.doors.find((door) => door.doorNum === doorNum) ??
      (() => {
        const createdDoor = {
          doorNum,
          label: `门 ${doorNum}`,
          goods: []
        };
        device.doors.push(createdDoor);
        return createdDoor;
      })();

    if (!remoteGoods.length) {
      return targetDoor.goods;
    }

    targetDoor.goods = remoteGoods.map((remoteItem) => {
      const existingCatalog = this.store.goodsCatalog.find((entry) => entry.goodsId === remoteItem.goodsId);
      const existingLocal = targetDoor.goods.find((entry) => entry.goodsId === remoteItem.goodsId);

      if (!existingCatalog) {
        this.store.goodsCatalog.push({
          goodsCode: remoteItem.goodsCode,
          goodsId: remoteItem.goodsId,
          name: remoteItem.name,
          price: remoteItem.price,
          imageUrl: remoteItem.imageUrl,
          category: existingLocal?.category ?? "daily"
        });
      } else {
        existingCatalog.goodsCode = remoteItem.goodsCode;
        existingCatalog.name = remoteItem.name;
        existingCatalog.price = remoteItem.price;
        existingCatalog.imageUrl = remoteItem.imageUrl;
      }

      return {
        goodsCode: remoteItem.goodsCode,
        goodsId: remoteItem.goodsId,
        name: remoteItem.name,
        price: remoteItem.price,
        imageUrl: remoteItem.imageUrl,
        category: existingCatalog?.category ?? existingLocal?.category ?? "daily",
        stock: existingLocal?.stock ?? 0,
        expiresAt: existingLocal?.expiresAt
      };
    });

    this.store.logOperation({
      category: "goods",
      type: "sync-device-goods",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "device",
        id: device.deviceCode,
        label: device.name
      },
      detail: `设备 ${device.deviceCode} 已同步 ${targetDoor.goods.length} 个货品种类，本地库存数量保持不变。`,
      metadata: {
        deviceCode: device.deviceCode,
        count: targetDoor.goods.length
      }
    });

    return targetDoor.goods;
  }

  private getActor(actorUserId?: string) {
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role as UserRole
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
