import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";

import type {
  GoodsCategory,
  MerchantGoodsTemplate,
  UserRole
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "../alerts/alerts.service";

const GOODS_CATEGORIES = new Set<GoodsCategory>(["food", "drink", "daily"]);

@Injectable()
export class MerchantGoodsTemplatesService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService) private readonly inventoryBatchChanges: InventoryBatchChangesService,
    @Inject(AlertsService) private readonly alertsService: AlertsService
  ) {}

  list(actor?: { id: string; role: UserRole }) {
    const storedTemplates =
      actor?.role === "merchant"
        ? this.store.merchantGoodsTemplates.filter(
            (entry) => entry.ownerUserId === actor.id || entry.ownerUserId === "system"
          )
        : this.store.merchantGoodsTemplates;
    const templatedGoodsIds = new Set(storedTemplates.map((entry) => entry.goodsId).filter(Boolean));
    const catalogTemplates: MerchantGoodsTemplate[] = this.store.goodsCatalog
      .filter((entry) => entry.status !== "inactive" && !templatedGoodsIds.has(entry.goodsId))
      .map((entry) => ({
        id: this.buildCatalogTemplateId(entry.goodsId),
        ownerUserId: "system",
        goodsId: entry.goodsId,
        goodsCode: entry.goodsCode,
        goodsName: entry.name,
        fullName: entry.fullName,
        category: entry.category,
        categoryName: entry.categoryName,
        packageForm: entry.packageForm,
        specification: entry.specification,
        manufacturer: entry.manufacturer,
        defaultQuantity: 1,
        defaultShelfLifeDays: 2,
        imageUrl: entry.imageUrl,
        status: "active",
        createdAt: entry.createdAt ?? "1970-01-01T00:00:00.000Z",
        updatedAt: entry.updatedAt ?? entry.createdAt ?? "1970-01-01T00:00:00.000Z"
      }));

    return [...storedTemplates, ...catalogTemplates]
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
    const normalized = this.normalizeTemplatePayload(payload);
    const now = new Date().toISOString();
    const created: MerchantGoodsTemplate = {
      id: this.store.createId("template"),
      // 记录创建来源用于审计；模板本身是后端公共模板库，所有商家都可调用。
      ownerUserId,
      ...normalized,
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
    const normalized = this.normalizeTemplatePatch(payload);
    // 先校验补丁，再按需从公共目录创建商户模板，避免失败请求留下空壳模板。
    const template = this.findOrCreateTemplateFromCatalog(ownerUserId, templateId);

    Object.assign(template, normalized, {
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
      confirmed?: boolean;
      cabinetEventId?: string;
    }
  ) {
    if (payload.confirmed !== true) {
      throw new BadRequestException("补货登记前需要先确认补货明细。");
    }

    const owner = this.getRestockActor(ownerUserId);
    const template = this.findTemplateForActor(owner.id, owner.role, payload.templateId);

    if (template.status !== "active") {
      throw new BadRequestException("当前货品模板已停用。");
    }

    const quantity = Number(payload.quantity ?? template.defaultQuantity);

    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException("补货数量必须是正整数。");
    }

    const device = this.store.devices.find((entry) => entry.deviceCode === payload.deviceCode);

    if (!device) {
      throw new NotFoundException("未找到对应柜机。");
    }

    const cabinetEventId = payload.cabinetEventId?.trim();

    if (!cabinetEventId) {
      throw new BadRequestException("补货登记必须关联已完成关门确认的入柜事件。");
    }

    {
      const event = this.store.events.find((entry) => entry.eventId === cabinetEventId);

      if (!event) {
        throw new NotFoundException("未找到对应入柜事件。");
      }

      if (event.userId !== owner.id || event.deviceCode !== device.deviceCode) {
        throw new ForbiddenException("当前入柜事件不属于该用户或柜机。");
      }

      if (event.operationType !== "restock" || event.hasInboundGoods !== true) {
        throw new BadRequestException("当前柜机事件不是补货入柜事件。");
      }

      if (!["closed", "settled"].includes(event.status)) {
        throw new BadRequestException("柜门关闭并完成事件确认后才能登记补货。");
      }

      const existingMovement = this.store.inventory.find(
        (entry) => entry.eventId === cabinetEventId && entry.type === "donation"
      );

      if (existingMovement) {
        const existingLog = this.store.logs.find(
          (entry) =>
            entry.type === "merchant-restock-template" &&
            entry.metadata?.cabinetEventId === cabinetEventId
        );
        const existingQuantity = Number(existingLog?.metadata?.quantity ?? existingMovement.quantity);
        const existingTemplateId = existingLog?.metadata?.templateId;
        const existingProductionDate = existingLog?.metadata?.productionDate;

        if (
          existingMovement.deviceCode !== device.deviceCode ||
          existingQuantity !== quantity ||
          existingTemplateId !== template.id ||
          existingProductionDate !== payload.productionDate
        ) {
          throw new ConflictException("该入柜事件已用另一组补货明细完成登记，不能重复改写。");
        }

        const existingBatch = this.store.goodsBatches.find(
          (entry) => entry.batchId === existingMovement.batchId
        );
        const existingGoods = this.store.goodsCatalog.find(
          (entry) => entry.goodsId === existingMovement.goodsId
        );

        if (!existingBatch || !existingGoods) {
          throw new ConflictException("该入柜事件已有登记记录，但关联批次不完整，请联系管理员核对。");
        }

        return {
          template,
          batch: existingBatch,
          goods: existingGoods,
          expiresAt: existingBatch.expiresAt,
          idempotentReplay: true
        };
      }
    }

    const expiresAt = this.calculateExpiresAt(payload.productionDate, template.defaultShelfLifeDays);
    const beforeMutation = {
      merchantGoodsTemplates: structuredClone(this.store.merchantGoodsTemplates),
      goodsCatalog: structuredClone(this.store.goodsCatalog),
      devices: structuredClone(this.store.devices),
      goodsBatches: structuredClone(this.store.goodsBatches),
      inventory: structuredClone(this.store.inventory),
      logs: structuredClone(this.store.logs),
      alerts: structuredClone(this.store.alerts)
    };

    try {
      const goods = this.ensureCatalogItemFromTemplate(template);
      const happenedAt = new Date().toISOString();
      const change = this.inventoryBatchChanges.recordRestockMovement({
        movement: {
          id: this.store.createId("movement"),
          eventId: cabinetEventId,
          userId: owner.id,
          deviceCode: device.deviceCode,
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          quantity,
          unitPrice: goods.price,
          type: "donation",
          happenedAt,
          expiresAt
        },
        deviceGoods: goods,
        batch: {
          expiresAt,
          sourceType: owner.role === "admin" ? "admin" : "merchant",
          sourceUserId: owner.id,
          sourceUserName: owner.name,
          note: payload.note,
          createdAt: happenedAt
        }
      });
      const batch = change.createdBatches[0];

      if (!batch) {
        throw new BadRequestException("补货登记未产生库存变化。");
      }

      this.store.logOperation({
        category: "restock",
        type: "merchant-restock-template",
        status: "success",
        actor: {
          type: owner.role === "admin" ? "admin" : "merchant",
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
          confirmation: {
            confirmed: true,
            confirmedAt: batch.createdAt,
            confirmedByUserId: owner.id,
            batchSelection: "new_batch"
          },
          goodsId: goods.goodsId,
          goodsName: goods.name,
          deviceCode: device.deviceCode,
          quantity,
          expiresAt,
          productionDate: payload.productionDate,
          cabinetEventId,
          undoState: "not_undoable"
        }
      });

      this.alertsService.create({
        type: "expiry",
        title: owner.role === "admin" ? "管理员入柜批次待到期跟进" : "商家补货批次待到期跟进",
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
        expiresAt,
        idempotentReplay: false
      };
    } catch (error) {
      this.store.merchantGoodsTemplates.splice(
        0,
        this.store.merchantGoodsTemplates.length,
        ...beforeMutation.merchantGoodsTemplates
      );
      this.store.goodsCatalog.splice(0, this.store.goodsCatalog.length, ...beforeMutation.goodsCatalog);
      this.store.devices.splice(0, this.store.devices.length, ...beforeMutation.devices);
      this.store.goodsBatches.splice(0, this.store.goodsBatches.length, ...beforeMutation.goodsBatches);
      this.store.inventory.splice(0, this.store.inventory.length, ...beforeMutation.inventory);
      this.store.logs.splice(0, this.store.logs.length, ...beforeMutation.logs);
      this.store.alerts.splice(0, this.store.alerts.length, ...beforeMutation.alerts);
      throw error;
    }
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
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(productionDate);

    if (!match) {
      throw new BadRequestException("生产日期格式不正确。");
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const baseDate = new Date(year, month - 1, day);

    if (
      baseDate.getFullYear() !== year ||
      baseDate.getMonth() !== month - 1 ||
      baseDate.getDate() !== day
    ) {
      throw new BadRequestException("生产日期格式不正确。");
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (baseDate.getTime() > today.getTime()) {
      throw new BadRequestException("生产日期不能晚于今天。");
    }

    const expires = new Date(baseDate.getTime() + shelfLifeDays * 24 * 60 * 60 * 1000);
    return expires.toISOString();
  }

  private findTemplate(templateId: string) {
    const template = this.store.merchantGoodsTemplates.find((entry) => entry.id === templateId);

    if (template) {
      return template;
    }

    const catalogItem = this.findCatalogItemByTemplateId(templateId);

    if (!catalogItem) {
      throw new NotFoundException("未找到对应货品模板。");
    }

    return this.mapCatalogItemToTemplate(catalogItem);
  }

  private findTemplateForActor(ownerUserId: string, role: UserRole, templateId: string) {
    const template = this.store.merchantGoodsTemplates.find((entry) => entry.id === templateId);

    if (template) {
      if (role !== "admin" && template.ownerUserId !== ownerUserId && template.ownerUserId !== "system") {
        throw new ForbiddenException("不能使用其他商家的常用商品模板。");
      }

      return template;
    }

    const catalogItem = this.findCatalogItemByTemplateId(templateId);

    if (!catalogItem) {
      throw new NotFoundException("未找到对应货品模板。");
    }

    return this.mapCatalogItemToTemplate(catalogItem);
  }

  private findOrCreateTemplateFromCatalog(ownerUserId: string, templateId: string) {
    const template = this.store.merchantGoodsTemplates.find((entry) => entry.id === templateId);

    if (template) {
      if (template.ownerUserId === "system") {
        const existingClone = this.store.merchantGoodsTemplates.find(
          (entry) =>
            entry.ownerUserId === ownerUserId &&
            entry.goodsId === template.goodsId &&
            entry.goodsCode === template.goodsCode
        );

        if (existingClone) {
          return existingClone;
        }

        const now = new Date().toISOString();
        const created: MerchantGoodsTemplate = {
          ...structuredClone(template),
          id: this.store.createId("template"),
          ownerUserId,
          createdAt: now,
          updatedAt: now
        };
        this.store.merchantGoodsTemplates.unshift(created);
        return created;
      }

      if (template.ownerUserId !== ownerUserId) {
        throw new ForbiddenException("不能修改其他商家的常用商品模板。");
      }

      return template;
    }

    const catalogItem = this.findCatalogItemByTemplateId(templateId);

    if (!catalogItem) {
      throw new NotFoundException("未找到对应货品模板。");
    }

    const now = new Date().toISOString();
    const created: MerchantGoodsTemplate = {
      ...this.mapCatalogItemToTemplate(catalogItem),
      id: this.store.createId("template"),
      ownerUserId,
      createdAt: now,
      updatedAt: now
    };

    this.store.merchantGoodsTemplates.unshift(created);
    return created;
  }

  private mapCatalogItemToTemplate(catalogItem: {
    goodsId: string;
    goodsCode: string;
    name: string;
    fullName?: string;
    category: GoodsCategory;
    categoryName?: string;
    packageForm?: string;
    specification?: string;
    manufacturer?: string;
    imageUrl: string;
    createdAt?: string;
    updatedAt?: string;
  }): MerchantGoodsTemplate {
    return {
      id: this.buildCatalogTemplateId(catalogItem.goodsId),
      ownerUserId: "system",
      goodsId: catalogItem.goodsId,
      goodsCode: catalogItem.goodsCode,
      goodsName: catalogItem.name,
      fullName: catalogItem.fullName,
      category: catalogItem.category,
      categoryName: catalogItem.categoryName,
      packageForm: catalogItem.packageForm,
      specification: catalogItem.specification,
      manufacturer: catalogItem.manufacturer,
      defaultQuantity: 1,
      defaultShelfLifeDays: 2,
      imageUrl: catalogItem.imageUrl,
      status: "active",
      createdAt: catalogItem.createdAt ?? "1970-01-01T00:00:00.000Z",
      updatedAt: catalogItem.updatedAt ?? catalogItem.createdAt ?? "1970-01-01T00:00:00.000Z"
    };
  }

  private findCatalogItemByTemplateId(templateId: string) {
    const goodsId = templateId.startsWith("catalog-") ? templateId.slice("catalog-".length) : "";

    if (!goodsId) {
      return undefined;
    }

    return this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId && entry.status !== "inactive");
  }

  private buildCatalogTemplateId(goodsId: string) {
    return `catalog-${goodsId}`;
  }

  private normalizeTemplatePayload(payload: {
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
  }) {
    const goodsName = payload.goodsName?.trim();
    const defaultQuantity = Number(payload.defaultQuantity);
    const defaultShelfLifeDays = Number(payload.defaultShelfLifeDays);

    if (!goodsName) {
      throw new BadRequestException("常用商品名称不能为空。");
    }

    if (!GOODS_CATEGORIES.has(payload.category)) {
      throw new BadRequestException("常用商品品类不正确。");
    }

    if (!Number.isFinite(defaultQuantity) || !Number.isInteger(defaultQuantity) || defaultQuantity <= 0) {
      throw new BadRequestException("默认数量必须是正整数。");
    }

    if (
      !Number.isFinite(defaultShelfLifeDays) ||
      !Number.isInteger(defaultShelfLifeDays) ||
      defaultShelfLifeDays <= 0
    ) {
      throw new BadRequestException("保质期天数必须是正整数。");
    }

    return {
      goodsId: payload.goodsId?.trim() || undefined,
      goodsCode: payload.goodsCode?.trim() || undefined,
      goodsName,
      fullName: payload.fullName?.trim() || undefined,
      category: payload.category,
      categoryName: payload.categoryName?.trim() || undefined,
      packageForm: payload.packageForm?.trim() || undefined,
      specification: payload.specification?.trim() || undefined,
      manufacturer: payload.manufacturer?.trim() || undefined,
      defaultQuantity,
      defaultShelfLifeDays,
      imageUrl: payload.imageUrl?.trim() || undefined
    };
  }

  private normalizeTemplatePatch(
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
    const patch = { ...payload };

    if (payload.goodsName !== undefined) {
      const goodsName = payload.goodsName.trim();

      if (!goodsName) {
        throw new BadRequestException("常用商品名称不能为空。");
      }

      patch.goodsName = goodsName;
    }

    if (payload.defaultQuantity !== undefined) {
      const defaultQuantity = Number(payload.defaultQuantity);

      if (!Number.isFinite(defaultQuantity) || !Number.isInteger(defaultQuantity) || defaultQuantity <= 0) {
        throw new BadRequestException("默认数量必须是正整数。");
      }

      patch.defaultQuantity = defaultQuantity;
    }

    if (payload.defaultShelfLifeDays !== undefined) {
      const defaultShelfLifeDays = Number(payload.defaultShelfLifeDays);

      if (
        !Number.isFinite(defaultShelfLifeDays) ||
        !Number.isInteger(defaultShelfLifeDays) ||
        defaultShelfLifeDays <= 0
      ) {
        throw new BadRequestException("保质期天数必须是正整数。");
      }

      patch.defaultShelfLifeDays = defaultShelfLifeDays;
    }

    if (payload.category !== undefined && !GOODS_CATEGORIES.has(payload.category)) {
      throw new BadRequestException("常用商品品类不正确。");
    }

    return patch;
  }

  private getRestockActor(ownerUserId: string) {
    const actor = this.store.users.find(
      (entry) =>
        entry.id === ownerUserId &&
        entry.status === "active" &&
        (entry.role === "merchant" || entry.role === "admin")
    );

    if (!actor) {
      throw new ForbiddenException("当前账号不能提交入柜登记。");
    }

    return actor;
  }

  private getMerchant(ownerUserId: string) {
    const merchant = this.store.users.find(
      (entry) => entry.id === ownerUserId && entry.role === "merchant" && entry.status === "active"
    );

    if (!merchant) {
      throw new ForbiddenException("当前账号不是商家。");
    }

    return merchant;
  }
}
