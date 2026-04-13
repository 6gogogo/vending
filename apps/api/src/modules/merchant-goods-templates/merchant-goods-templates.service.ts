import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  GoodsCategory,
  MerchantGoodsTemplate,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";

@Injectable()
export class MerchantGoodsTemplatesService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AlertsService) private readonly alertsService: AlertsService
  ) {}

  list(ownerUserId: string) {
    return this.store.merchantGoodsTemplates
      .filter((entry) => entry.ownerUserId === ownerUserId)
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  create(
    ownerUserId: string,
    payload: {
      goodsId?: string;
      goodsCode?: string;
      goodsName: string;
      fullName?: string;
      category: GoodsCategory;
      categoryName?: string;
      packageForm?: string;
      specification?: string;
      manufacturer?: string;
      defaultQuantity: number;
      defaultShelfLifeDays: number;
      imageUrl?: string;
    }
  ) {
    const owner = this.getMerchant(ownerUserId);
    const now = new Date().toISOString();
    const created: MerchantGoodsTemplate = {
      id: this.store.createId("template"),
      ownerUserId,
      goodsId: payload.goodsId,
      goodsCode: payload.goodsCode,
      goodsName: payload.goodsName,
      fullName: payload.fullName,
      category: payload.category,
      categoryName: payload.categoryName,
      packageForm: payload.packageForm,
      specification: payload.specification,
      manufacturer: payload.manufacturer,
      defaultQuantity: payload.defaultQuantity,
      defaultShelfLifeDays: payload.defaultShelfLifeDays,
      imageUrl: payload.imageUrl,
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    this.store.merchantGoodsTemplates.unshift(created);
    this.store.logOperation({
      category: "goods",
      type: "create-merchant-template",
      status: "success",
      actor: {
        type: "merchant",
        id: owner.id,
        name: owner.name,
        role: owner.role
      },
      primarySubject: {
        type: "goods",
        id: created.goodsId ?? created.id,
        label: created.goodsName
      },
      detail: `${owner.name} 新建了补货模板 ${created.goodsName}。`,
      description: `${owner.name} 新建了 ${created.goodsName} 补货模板。`,
      metadata: {
        templateId: created.id,
        goodsId: created.goodsId,
        goodsName: created.goodsName,
        undoState: "not_undoable"
      }
    });
    return created;
  }

  update(
    ownerUserId: string,
    templateId: string,
    payload: Partial<{
      goodsId: string;
      goodsCode: string;
      goodsName: string;
      fullName: string;
      category: GoodsCategory;
      categoryName: string;
      packageForm: string;
      specification: string;
      manufacturer: string;
      defaultQuantity: number;
      defaultShelfLifeDays: number;
      imageUrl?: string;
      status: "active" | "inactive";
    }>
  ) {
    const owner = this.getMerchant(ownerUserId);
    const template = this.findOwnedTemplate(ownerUserId, templateId);
    Object.assign(template, payload, {
      updatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "goods",
      type: "update-merchant-template",
      status: "success",
      actor: {
        type: "merchant",
        id: owner.id,
        name: owner.name,
        role: owner.role
      },
      primarySubject: {
        type: "goods",
        id: template.goodsId ?? template.id,
        label: template.goodsName
      },
      detail: `${owner.name} 更新了补货模板 ${template.goodsName}。`,
      description: `${owner.name} 更新了 ${template.goodsName} 补货模板。`,
      metadata: {
        templateId: template.id,
        goodsId: template.goodsId,
        goodsName: template.goodsName,
        undoState: "not_undoable"
      }
    });
    return template;
  }

  createRestock(
    ownerUserId: string,
    payload: {
      templateId: string;
      deviceCode: string;
      quantity?: number;
      productionDate: string;
      note?: string;
    }
  ) {
    const owner = this.getMerchant(ownerUserId);
    const template = this.findOwnedTemplate(ownerUserId, payload.templateId);
    const quantity = payload.quantity ?? template.defaultQuantity;

    if (quantity <= 0) {
      throw new BadRequestException("补货数量必须大于 0。");
    }

    const device = this.store.devices.find((entry) => entry.deviceCode === payload.deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const goods = this.ensureCatalogItemFromTemplate(template);
    const expiresAt = this.calculateExpiresAt(payload.productionDate, template.defaultShelfLifeDays);

    this.store.ensureDeviceGoodsEntry(device.deviceCode, {
      goodsId: goods.goodsId,
      goodsCode: goods.goodsCode,
      name: goods.name,
      category: goods.category,
      price: goods.price,
      imageUrl: goods.imageUrl
    });

    const batch = this.store.createGoodsBatch({
      goodsId: goods.goodsId,
      deviceCode: device.deviceCode,
      quantity,
      expiresAt,
      sourceType: "merchant",
      sourceUserId: owner.id,
      sourceUserName: owner.name,
      note: payload.note
    });

    this.store.inventory.unshift({
      id: this.store.createId("movement"),
      userId: owner.id,
      deviceCode: device.deviceCode,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity,
      unitPrice: goods.price,
      type: "donation",
      happenedAt: batch.createdAt,
      expiresAt
    });

    this.store.logOperation({
      category: "restock",
      type: "merchant-restock-template",
      status: "success",
      actor: {
        type: "merchant",
        id: owner.id,
        name: owner.name,
        role: owner.role
      },
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
      detail: `${owner.name} 使用模板向 ${device.name} 补充了 ${goods.name} x${quantity}。`,
      description: `${owner.name} 向 ${device.name} 补充了 ${goods.name} x${quantity}。`,
      metadata: {
        templateId: template.id,
        batchId: batch.batchId,
        goodsId: goods.goodsId,
        goodsName: goods.name,
        deviceCode: device.deviceCode,
        quantity,
        expiresAt,
        productionDate: payload.productionDate,
        undoState: "not_undoable"
      }
    });

    this.alertsService.create({
      type: "expiry",
      title: "商户补货批次待到期跟进",
      deviceCode: device.deviceCode,
      targetUserId: owner.id,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      dueAt: expiresAt,
      detail: `${device.name} 的 ${goods.name} 批次已入柜，请在到期前关注去向。`
    });

    return {
      template,
      batch,
      goods,
      expiresAt
    };
  }

  listRestockTraces(ownerUserId: string) {
    this.getMerchant(ownerUserId);
    const batches = this.store.goodsBatches
      .filter((entry) => entry.sourceUserId === ownerUserId)
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((entry) => {
        const goods = this.store.goodsCatalog.find((item) => item.goodsId === entry.goodsId);
        const device = this.store.devices.find((item) => item.deviceCode === entry.deviceCode);

        return {
          ...entry,
          goodsName: goods?.name ?? entry.goodsId,
          deviceName: device?.name ?? entry.deviceCode
        };
      });

    const records = this.store.inventory
      .filter((entry) => entry.userId === ownerUserId)
      .slice()
      .sort((left, right) => right.happenedAt.localeCompare(left.happenedAt));

    const logs = this.store.logs
      .filter((entry) => entry.actor.id === ownerUserId)
      .slice()
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 40);

    const dailySummary = Object.values(
      this.store.batchConsumptionTraces
        .filter((entry) => entry.sourceUserId === ownerUserId)
        .reduce<Record<string, {
          dateKey: string;
          claimedUnits: number;
          helpedUsers: Set<string>;
          helpTimes: Set<string>;
        }>>((accumulator, entry) => {
          const dateKey = entry.happenedAt.slice(0, 10);
          const existing =
            accumulator[dateKey] ??
            {
              dateKey,
              claimedUnits: 0,
              helpedUsers: new Set<string>(),
              helpTimes: new Set<string>()
            };

          existing.claimedUnits += entry.quantity;
          if (entry.consumerUserId) {
            existing.helpedUsers.add(entry.consumerUserId);
          }
          existing.helpTimes.add(entry.orderNo ?? entry.eventId ?? `${entry.consumerUserId ?? "unknown"}-${entry.happenedAt}`);
          accumulator[dateKey] = existing;
          return accumulator;
        }, {})
    )
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
      .map((entry, index, array) => ({
        dateKey: entry.dateKey,
        claimedUnits: entry.claimedUnits,
        helpedUsers: entry.helpedUsers.size,
        helpTimes: entry.helpTimes.size,
        cumulativeHelpTimes: array
          .slice(index)
          .reduce((sum, item) => sum + item.helpTimes.size, 0)
      }));

    return {
      batches,
      records,
      logs,
      dailySummary,
      cumulativeHelpTimes: dailySummary.reduce((sum, entry) => sum + entry.helpTimes, 0)
    };
  }

  private ensureCatalogItemFromTemplate(template: MerchantGoodsTemplate) {
    if (template.goodsId) {
      const existing = this.store.goodsCatalog.find((entry) => entry.goodsId === template.goodsId);

      if (existing) {
        return existing;
      }
    }

    if (template.goodsCode) {
      const matchedByCode = this.store.goodsCatalog.find((entry) => entry.goodsCode === template.goodsCode);

      if (matchedByCode) {
        template.goodsId = matchedByCode.goodsId;
        template.imageUrl = template.imageUrl ?? matchedByCode.imageUrl;
        template.updatedAt = new Date().toISOString();
        return matchedByCode;
      }
    }

    const created = this.store.ensureGoodsCatalogItem({
      goodsCode: template.goodsCode ?? template.goodsId ?? this.store.createId("goods-code"),
      goodsId: template.goodsId ?? template.goodsCode ?? this.store.createId("goods"),
      name: template.goodsName,
      fullName: template.fullName ?? template.goodsName,
      category: template.category,
      categoryName: template.categoryName,
      price: 0,
      imageUrl:
        template.imageUrl ?? "https://dummyimage.com/160x160/d8e8ff/0b1220.png&text=%E7%89%A9%E8%B5%84",
      packageForm: template.packageForm,
      specification: template.specification,
      manufacturer: template.manufacturer,
      status: "active"
    });

    template.goodsId = created.goodsId;
    template.goodsCode = created.goodsCode;
    template.imageUrl = template.imageUrl ?? created.imageUrl;
    template.updatedAt = new Date().toISOString();
    return created;
  }

  private calculateExpiresAt(productionDate: string, shelfLifeDays: number) {
    const baseDate = new Date(`${productionDate}T00:00:00`);

    if (Number.isNaN(baseDate.getTime())) {
      throw new BadRequestException("生产日期格式不正确。");
    }

    const expires = new Date(baseDate.getTime() + shelfLifeDays * 24 * 60 * 60 * 1000);
    return expires.toISOString();
  }

  private findOwnedTemplate(ownerUserId: string, templateId: string) {
    const template = this.store.merchantGoodsTemplates.find((entry) => entry.id === templateId);

    if (!template) {
      throw new NotFoundException("未找到对应货品模板。");
    }

    if (template.ownerUserId !== ownerUserId) {
      throw new ForbiddenException("当前模板不属于你。");
    }

    return template;
  }

  private getMerchant(ownerUserId: string) {
    const merchant = this.store.users.find((entry) => entry.id === ownerUserId && entry.role === "merchant");

    if (!merchant) {
      throw new ForbiddenException("当前账号不是爱心商户。");
    }

    return merchant;
  }
}
