import { BadRequestException } from "@nestjs/common";

import type {
  CabinetOpenRequest,
  CabinetReservationCreatePayload,
  GoodsCategory
} from "@vm/shared-types";

type UnknownRecord = Record<string, unknown>;
type OpenRequestWithQuote = CabinetOpenRequest & { quoteId?: string };

const MAX_INTENT_ITEMS = 50;
const MAX_TOTAL_QUANTITY = 1_000;
const goodsCategories = new Set<GoodsCategory>(["food", "drink", "daily"]);

const assertObject = (value: unknown, label: string): UnknownRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException(`${label}必须是 JSON 对象。`);
  }

  return value as UnknownRecord;
};

const assertAllowedKeys = (value: UnknownRecord, allowed: readonly string[], label: string) => {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));

  if (unexpected.length) {
    throw new BadRequestException(`${label}包含不支持的字段：${unexpected.join("、")}。`);
  }
};

const requiredString = (value: unknown, label: string, maxLength: number) => {
  if (typeof value !== "string") {
    throw new BadRequestException(`${label}必须是字符串。`);
  }

  const normalized = value.trim();

  if (!normalized || normalized.length > maxLength) {
    throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符。`);
  }

  return normalized;
};

const optionalString = (value: unknown, label: string, maxLength: number) =>
  value === undefined ? undefined : requiredString(value, label, maxLength);

const optionalEnum = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string
) => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new BadRequestException(`${label}不在允许范围内。`);
  }

  return value as T;
};

const parseIntentItems = (value: unknown, options: { required: boolean }) => {
  if (value === undefined && !options.required) {
    return undefined;
  }

  if (!Array.isArray(value) || (options.required && value.length === 0)) {
    throw new BadRequestException("商品明细必须是非空数组。");
  }

  if (value.length > MAX_INTENT_ITEMS) {
    throw new BadRequestException(`商品明细不能超过 ${MAX_INTENT_ITEMS} 项。`);
  }

  const goodsIds = new Set<string>();
  let totalQuantity = 0;
  const items = value.map((rawItem, index) => {
    const item = assertObject(rawItem, `第 ${index + 1} 项商品明细`);
    assertAllowedKeys(
      item,
      ["goodsId", "quantity", "goodsName", "category"],
      `第 ${index + 1} 项商品明细`
    );
    const goodsId = requiredString(item.goodsId, "商品编号", 128);

    if (goodsIds.has(goodsId)) {
      throw new BadRequestException(`商品明细不能重复提交商品 ${goodsId}。`);
    }

    if (
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > MAX_TOTAL_QUANTITY
    ) {
      throw new BadRequestException(`商品 ${goodsId} 的数量必须是 1-${MAX_TOTAL_QUANTITY} 的整数。`);
    }

    goodsIds.add(goodsId);
    totalQuantity += item.quantity;

    if (totalQuantity > MAX_TOTAL_QUANTITY) {
      throw new BadRequestException(`商品总数量不能超过 ${MAX_TOTAL_QUANTITY}。`);
    }

    return {
      goodsId,
      quantity: item.quantity,
      goodsName: optionalString(item.goodsName, "商品名称", 100),
      category: optionalEnum(item.category, goodsCategories, "商品分类")
    };
  });

  return items;
};

export const parseCabinetOpenRequest = (value: unknown): OpenRequestWithQuote => {
  const payload = assertObject(value, "开柜请求");
  assertAllowedKeys(
    payload,
    [
      "phone",
      "deviceCode",
      "doorNum",
      "reservationId",
      "category",
      "openMode",
      "operationType",
      "hasInboundGoods",
      "openReason",
      "intentItems",
      "quoteId"
    ],
    "开柜请求"
  );

  if (payload.hasInboundGoods !== undefined && typeof payload.hasInboundGoods !== "boolean") {
    throw new BadRequestException("是否有商品入柜必须是布尔值。");
  }

  return {
    phone: requiredString(payload.phone, "手机号", 32),
    deviceCode: requiredString(payload.deviceCode, "柜机编号", 128),
    doorNum: optionalString(payload.doorNum, "柜门编号", 64),
    reservationId: optionalString(payload.reservationId, "预约编号", 128),
    category: optionalEnum(payload.category, goodsCategories, "商品分类"),
    openMode: optionalEnum(payload.openMode, new Set(["manual", "scan"]), "开柜方式"),
    operationType: optionalEnum(
      payload.operationType,
      new Set(["pickup", "restock", "service"]),
      "开柜用途"
    ),
    hasInboundGoods: payload.hasInboundGoods as boolean | undefined,
    openReason: optionalString(payload.openReason, "开柜理由", 500),
    intentItems: parseIntentItems(payload.intentItems, { required: false }),
    quoteId: optionalString(payload.quoteId, "预结算报价编号", 128)
  };
};

export const parseCabinetReservationCreatePayload = (
  value: unknown
): CabinetReservationCreatePayload => {
  const payload = assertObject(value, "预约请求");
  assertAllowedKeys(payload, ["deviceCode", "doorNum", "intentItems"], "预约请求");

  return {
    deviceCode: requiredString(payload.deviceCode, "柜机编号", 128),
    doorNum: optionalString(payload.doorNum, "柜门编号", 64),
    intentItems: parseIntentItems(payload.intentItems, { required: true })!
  };
};
