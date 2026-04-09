import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  DeviceGoodsSetting,
  GoodsAlertPolicy,
  GoodsBatchSource,
  GoodsCatalogItem,
  GoodsDetailSnapshot,
  GoodsOverviewItem,
  GoodsOverviewSnapshot,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { SmartVmGateway } from "../devices/smartvm.gateway";

@Injectable()
export class GoodsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway
  ) {}

  listCatalog() {
    return [...this.store.goodsCatalog].sort((left, right) => left.goodsId.localeCompare(right.goodsId));
  }

  getDetail(goodsId: string): GoodsDetailSnapshot {
    const goods = this.findCatalogItem(goodsId);
    const distribution = this.buildDistributionForGoods(goodsId);
    const batches = this.store
      .getGoodsBatches(undefined, goodsId)
      .slice()
      .sort((left, right) => {
        const leftExpiry = left.expiresAt ?? "9999-12-31T23:59:59.999Z";
        const rightExpiry = right.expiresAt ?? "9999-12-31T23:59:59.999Z";

        if (leftExpiry !== rightExpiry) {
          return leftExpiry.localeCompare(rightExpiry);
        }

        return right.createdAt.localeCompare(left.createdAt);
      });

    return {
      goods,
      totalStock: distribution.reduce((sum, item) => sum + item.stock, 0),
      nearestExpiryAt: batches
        .filter((entry) => entry.remainingQuantity > 0 && entry.expiresAt)
        .map((entry) => entry.expiresAt as string)
        .sort((left, right) => left.localeCompare(right))
        .at(0),
      deviceDistribution: distribution,
      batches,
      deviceSettings: this.store.devices
        .map((device) => {
          const setting = this.store.getDeviceGoodsSetting(device.deviceCode, goodsId);
          const currentStock = this.store.getCurrentStock(device.deviceCode, goodsId);
          const nearestExpiryAt = this.store.getNearestExpiryAt(device.deviceCode, goodsId);

          return {
            deviceCode: device.deviceCode,
            deviceName: device.name,
            enabled: setting?.enabled ?? false,
            lowStockThreshold: setting?.lowStockThreshold,
            currentStock,
            nearestExpiryAt
          };
        }),
      recentLogs: this.store.logs
        .filter(
          (entry) =>
            entry.primarySubject?.id === goodsId ||
            entry.secondarySubject?.id === goodsId ||
            entry.metadata?.goodsId === goodsId
        )
        .slice(0, 20)
    };
  }

  createCatalogItem(
    payload: Pick<GoodsCatalogItem, "goodsCode" | "goodsId" | "name" | "category" | "price" | "imageUrl">,
    actorUserId?: string
  ) {
    const existed = this.store.goodsCatalog.find((entry) => entry.goodsId === payload.goodsId);

    if (existed) {
      throw new BadRequestException("该货品编号已存在。");
    }

    const created = this.store.ensureGoodsCatalogItem({
      ...payload,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "goods",
      type: "create-goods-catalog",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: created.goodsId,
        label: created.name
      },
      metadata: {
        goodsId: created.goodsId,
        goodsName: created.name,
        undoState: "undoable",
        createdSnapshot: structuredClone(created)
      }
    });

    return created;
  }

  updateCatalogItem(
    goodsId: string,
    payload: Partial<Pick<GoodsCatalogItem, "goodsCode" | "name" | "category" | "price" | "imageUrl" | "status">>,
    actorUserId?: string
  ) {
    const goods = this.findCatalogItem(goodsId);
    const before = structuredClone(goods);

    Object.assign(goods, payload, {
      updatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "goods",
      type: "update-goods-catalog",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: goods.goodsId,
        label: goods.name
      },
      metadata: {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        undoState: "undoable",
        beforeSnapshot: before,
        afterSnapshot: structuredClone(goods)
      }
    });

    return goods;
  }

  addBatch(
    goodsId: string,
    payload: {
      deviceCode: string;
      quantity: number;
      expiresAt?: string;
      sourceType?: GoodsBatchSource;
      sourceUserId?: string;
      sourceUserName?: string;
      note?: string;
    },
    actorUserId?: string
  ) {
    const goods = this.findCatalogItem(goodsId);

    if (payload.quantity <= 0) {
      throw new BadRequestException("批次数量必须大于 0。");
    }

    this.store.ensureDeviceGoodsEntry(payload.deviceCode, {
      goodsId: goods.goodsId,
      goodsCode: goods.goodsCode,
      name: goods.name,
      category: goods.category,
      price: goods.price,
      imageUrl: goods.imageUrl
    });

    const batch = this.store.createGoodsBatch({
      goodsId,
      deviceCode: payload.deviceCode,
      quantity: payload.quantity,
      expiresAt: payload.expiresAt,
      sourceType: payload.sourceType ?? "admin",
      sourceUserId: payload.sourceUserId ?? actorUserId,
      sourceUserName:
        payload.sourceUserName ??
        this.store.users.find((entry) => entry.id === (payload.sourceUserId ?? actorUserId))?.name,
      note: payload.note
    });

    this.store.inventory.unshift({
      id: this.store.createId("movement"),
      userId: payload.sourceUserId ?? actorUserId ?? this.store.users.find((entry) => entry.role === "admin")?.id ?? "system",
      deviceCode: payload.deviceCode,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: payload.quantity,
      unitPrice: goods.price,
      type: "manual-restock",
      happenedAt: batch.createdAt,
      expiresAt: payload.expiresAt
    });

    this.store.logOperation({
      category: "goods",
      type: "manual-add-batch",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: goods.goodsId,
        label: goods.name
      },
      secondarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: this.getDeviceLabel(payload.deviceCode)
      },
      metadata: {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        deviceCode: payload.deviceCode,
        quantity: payload.quantity,
        batchId: batch.batchId,
        expiresAt: payload.expiresAt,
        sourceType: batch.sourceType,
        undoState: "undoable"
      }
    });

    return batch;
  }

  removeBatch(
    batchId: string,
    payload: {
      quantity: number;
      note?: string;
    },
    actorUserId?: string
  ) {
    if (payload.quantity <= 0) {
      throw new BadRequestException("去除数量必须大于 0。");
    }

    const removed = this.store.removeBatchQuantity(batchId, payload.quantity);

    if (!removed) {
      throw new NotFoundException("未找到对应批次。");
    }

    const goods = this.findCatalogItem(removed.batch.goodsId);

    this.store.inventory.unshift({
      id: this.store.createId("movement"),
      userId: actorUserId ?? this.store.users.find((entry) => entry.role === "admin")?.id ?? "system",
      deviceCode: removed.batch.deviceCode,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: removed.actualQuantity,
      unitPrice: goods.price,
      type: "manual-deduction",
      happenedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "goods",
      type: "manual-remove-batch",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: goods.goodsId,
        label: goods.name
      },
      secondarySubject: {
        type: "device",
        id: removed.batch.deviceCode,
        label: this.getDeviceLabel(removed.batch.deviceCode)
      },
      metadata: {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        deviceCode: removed.batch.deviceCode,
        quantity: removed.actualQuantity,
        batchId: removed.batch.batchId,
        note: payload.note ?? "",
        undoState: "undoable"
      }
    });

    return {
      batchId: removed.batch.batchId,
      goodsId: goods.goodsId,
      deviceCode: removed.batch.deviceCode,
      removedQuantity: removed.actualQuantity,
      remainingQuantity: removed.batch.remainingQuantity
    };
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
        deviceCount: created.applicableDeviceCodes.length,
        undoState: "not_undoable"
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
        deviceCount: policy.applicableDeviceCodes.length,
        undoState: "not_undoable"
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
      this.removePolicySettings(
        (setting) => payload.deviceCodes.includes(setting.deviceCode) && Boolean(setting.sourcePolicyId)
      );
      for (const policy of this.store.goodsAlertPolicies) {
        policy.applicableDeviceCodes = policy.applicableDeviceCodes.filter(
          (deviceCode) => !payload.deviceCodes.includes(deviceCode)
        );
      }
    }

    if (payload.mode === "unbind") {
      this.removePolicySettings(
        (setting) =>
          payload.deviceCodes.includes(setting.deviceCode) &&
          payload.policyIds.includes(setting.sourcePolicyId ?? "")
      );
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

      for (const deviceCode of payload.deviceCodes) {
        for (const threshold of policy.thresholds) {
          const existsOnDevice =
            this.store.getGoodsBatches(deviceCode, threshold.goodsId).length > 0 ||
            this.store.devices
              .find((entry) => entry.deviceCode === deviceCode)
              ?.doors.some((door) => door.goods.some((goods) => goods.goodsId === threshold.goodsId));

          if (!existsOnDevice) {
            continue;
          }

          this.store.upsertDeviceGoodsSetting({
            deviceCode,
            goodsId: threshold.goodsId,
            enabled: true,
            lowStockThreshold: threshold.lowStockThreshold,
            sourcePolicyId: policy.id,
            updatedAt: new Date().toISOString()
          });
        }
      }
    }

    this.store.logOperation({
      category: "goods",
      type: "batch-assign-goods-alert-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyIds: payload.policyIds,
        deviceCodes: payload.deviceCodes,
        mode: payload.mode,
        undoState: "not_undoable"
      }
    });

    return this.listAlertPolicies();
  }

  updateDeviceThreshold(
    deviceCode: string,
    goodsId: string,
    payload: {
      enabled: boolean;
      lowStockThreshold?: number;
    },
    actorUserId?: string
  ) {
    this.findCatalogItem(goodsId);

    const setting = this.store.upsertDeviceGoodsSetting({
      deviceCode,
      goodsId,
      enabled: payload.enabled,
      lowStockThreshold: payload.enabled ? payload.lowStockThreshold : undefined,
      sourcePolicyId: this.store.getDeviceGoodsSetting(deviceCode, goodsId)?.sourcePolicyId,
      updatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "goods",
      type: "update-device-goods-threshold",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "device",
        id: deviceCode,
        label: this.getDeviceLabel(deviceCode)
      },
      secondarySubject: {
        type: "goods",
        id: goodsId,
        label: this.findCatalogItem(goodsId).name
      },
      metadata: {
        deviceCode,
        goodsId,
        enabled: setting.enabled,
        lowStockThreshold: setting.lowStockThreshold,
        undoState: "not_undoable"
      }
    });

    return setting;
  }

  getLowStockThreshold(deviceCode: string, goodsId: string) {
    const setting = this.store.getDeviceGoodsSetting(deviceCode, goodsId);

    if (!setting?.enabled) {
      return undefined;
    }

    return setting.lowStockThreshold;
  }

  getOverview(): GoodsOverviewSnapshot {
    this.store.syncDeviceStocksFromBatches();
    const goodsByDevice = this.store.devices.flatMap((device) =>
      device.doors.flatMap((door) =>
        door.goods.map((goods) => this.buildDistributionItem(device.deviceCode, device.name, goods.goodsId))
      )
    );

    return {
      totalKinds: this.store.goodsCatalog.filter((entry) => entry.status !== "inactive").length,
      lowStockKinds: goodsByDevice.filter((item) => item.status === "low").length,
      outOfStockKinds: goodsByDevice.filter((item) => item.status === "empty").length,
      policyCount: this.store.goodsAlertPolicies.filter((entry) => entry.status === "active").length,
      settingCount: this.store.deviceGoodsSettings.filter((entry) => entry.enabled).length,
      flaggedGoods: goodsByDevice
        .filter((item) => item.status !== "ok")
        .sort((left, right) => {
          if (left.status !== right.status) {
            return left.status === "empty" ? -1 : 1;
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
        .filter((entry) => entry.status !== "inactive")
        .map((goods) => {
          const distribution = goodsByDevice.filter((item) => item.goodsId === goods.goodsId);

          return {
            goodsId: goods.goodsId,
            goodsName: goods.name,
            category: goods.category,
            totalStock: distribution.reduce((sum, item) => sum + item.stock, 0),
            lowStockDevices: distribution.filter((item) => item.status === "low").length,
            outOfStockDevices: distribution.filter((item) => item.status === "empty").length,
            nearestExpiryAt: distribution
              .map((item) => item.nearestExpiryAt)
              .filter((value): value is string => Boolean(value))
              .sort((left, right) => left.localeCompare(right))
              .at(0),
            deviceDistribution: distribution.sort((left, right) => left.deviceCode.localeCompare(right.deviceCode))
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

    for (const remoteItem of remoteGoods) {
      const catalogItem = this.store.ensureGoodsCatalogItem({
        goodsCode: remoteItem.goodsCode,
        goodsId: remoteItem.goodsId,
        name: remoteItem.name,
        price: remoteItem.price,
        imageUrl: remoteItem.imageUrl,
        category:
          this.store.goodsCatalog.find((entry) => entry.goodsId === remoteItem.goodsId)?.category ?? "daily",
        status: this.store.goodsCatalog.find((entry) => entry.goodsId === remoteItem.goodsId)?.status ?? "active"
      });

      this.store.ensureDeviceGoodsEntry(deviceCode, {
        goodsId: catalogItem.goodsId,
        goodsCode: catalogItem.goodsCode,
        name: catalogItem.name,
        price: catalogItem.price,
        imageUrl: catalogItem.imageUrl,
        category: catalogItem.category
      });
    }

    if (!remoteGoods.length) {
      this.store.syncDeviceStocksFromBatches(deviceCode);
      return targetDoor.goods;
    }

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
      metadata: {
        deviceCode: device.deviceCode,
        count: remoteGoods.length,
        undoState: "not_undoable"
      }
    });

    return targetDoor.goods;
  }

  private buildDistributionForGoods(goodsId: string) {
    return this.store.devices
      .map((device) => {
        const hasGoods = device.doors.some((door) => door.goods.some((goods) => goods.goodsId === goodsId));
        const hasSetting = Boolean(this.store.getDeviceGoodsSetting(device.deviceCode, goodsId));
        const hasBatch = this.store.getGoodsBatches(device.deviceCode, goodsId).length > 0;

        if (!hasGoods && !hasSetting && !hasBatch) {
          return undefined;
        }

        return this.buildDistributionItem(device.deviceCode, device.name, goodsId);
      })
      .filter((entry): entry is GoodsOverviewItem => Boolean(entry));
  }

  private buildDistributionItem(deviceCode: string, deviceName: string, goodsId: string): GoodsOverviewItem {
    const goods = this.findCatalogItem(goodsId);
    const stock = this.store.getCurrentStock(deviceCode, goodsId);
    const setting = this.store.getDeviceGoodsSetting(deviceCode, goodsId);
    const lowStockThreshold = setting?.enabled ? setting.lowStockThreshold : undefined;

    return {
      deviceCode,
      deviceName,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      stock,
      thresholdEnabled: Boolean(setting?.enabled),
      lowStockThreshold,
      status:
        stock <= 0
          ? "empty"
          : lowStockThreshold !== undefined && stock <= lowStockThreshold
            ? "low"
            : "ok",
      nearestExpiryAt: this.store.getNearestExpiryAt(deviceCode, goodsId)
    };
  }

  private findCatalogItem(goodsId: string) {
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);

    if (!goods) {
      throw new NotFoundException("未找到对应货品。");
    }

    return goods;
  }

  private removePolicySettings(predicate: (setting: DeviceGoodsSetting) => boolean) {
    for (let index = this.store.deviceGoodsSettings.length - 1; index >= 0; index -= 1) {
      if (predicate(this.store.deviceGoodsSettings[index])) {
        this.store.deviceGoodsSettings.splice(index, 1);
      }
    }
  }

  private getDeviceLabel(deviceCode: string) {
    return this.store.devices.find((entry) => entry.deviceCode === deviceCode)?.name ?? deviceCode;
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
