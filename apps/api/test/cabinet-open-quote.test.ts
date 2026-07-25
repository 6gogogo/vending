import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BadRequestException, ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { CabinetPreSettlement } from "@vm/shared-types";

import { InventoryBatchChangesService } from "../src/common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import {
  CABINET_OPEN_QUOTE_MAX_ENTRIES,
  CABINET_OPEN_QUOTE_TTL_MS,
  CabinetOpenQuoteService,
  type CabinetOpenQuoteContext
} from "../src/modules/cabinet-events/cabinet-open-quote.service";
import type { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import type { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";

const settlement = (unitPrice = 500): CabinetPreSettlement => ({
  deviceCode: "CAB-QUOTE",
  doorNum: "1",
  createdAt: "2026-07-16T00:00:00.000Z",
  totalQuantity: 2,
  freeQuantity: 1,
  paidQuantity: 1,
  originalAmount: unitPrice * 2,
  freeAmount: unitPrice,
  payableAmount: unitPrice,
  chargeRequired: true,
  summary: "免费 1 件，付费 1 件",
  items: [
    {
      goodsId: "goods-quote",
      goodsName: "报价商品",
      category: "food",
      quantity: 2,
      freeQuantity: 1,
      paidQuantity: 1,
      unitPrice,
      originalAmount: unitPrice * 2,
      freeAmount: unitPrice,
      paidAmount: unitPrice
    }
  ]
});

const context = (unitPrice = 500): CabinetOpenQuoteContext => ({
  userId: "special-quote",
  deviceCode: "CAB-QUOTE",
  doorNum: "1",
  reservationId: "reservation-quote",
  intentItems: [
    {
      goodsId: "goods-quote",
      goodsName: "报价商品",
      category: "food",
      quantity: 2
    }
  ],
  preSettlement: settlement(unitPrice)
});

test("预结算报价只能由完全一致的上下文核销一次", () => {
  const quotes = new CabinetOpenQuoteService();
  const issued = quotes.issue(context(), 1_000);

  quotes.consume(issued.quoteId, context(), { required: true }, 1_001);
  assert.throws(
    () => quotes.consume(issued.quoteId, context(), { required: true }, 1_002),
    ConflictException
  );
});

test("同一用户柜门只保留最新报价，缓存达到硬上限后淘汰最早报价", () => {
  const sameOwnerQuotes = new CabinetOpenQuoteService();
  const superseded = sameOwnerQuotes.issue(context(), 1_000);
  const latest = sameOwnerQuotes.issue(context(), 1_001);

  assert.throws(
    () => sameOwnerQuotes.consume(superseded.quoteId, context(), { required: true }, 1_002),
    ConflictException
  );
  assert.doesNotThrow(() =>
    sameOwnerQuotes.consume(latest.quoteId, context(), { required: true }, 1_002)
  );

  const boundedQuotes = new CabinetOpenQuoteService();
  let first:
    | { quoteId: string; quoteExpiresAt: string; quoteContext: CabinetOpenQuoteContext }
    | undefined;
  let last:
    | { quoteId: string; quoteExpiresAt: string; quoteContext: CabinetOpenQuoteContext }
    | undefined;

  for (let index = 0; index <= CABINET_OPEN_QUOTE_MAX_ENTRIES; index += 1) {
    const deviceCode = `CAB-BOUND-${index}`;
    const quoteContext: CabinetOpenQuoteContext = {
      ...context(),
      userId: `special-bound-${index}`,
      deviceCode,
      preSettlement: {
        ...settlement(),
        deviceCode
      }
    };
    const issued = boundedQuotes.issue(quoteContext, 10_000 + index);
    const entry = { ...issued, quoteContext };
    first ??= entry;
    last = entry;
  }

  assert.ok(first);
  assert.ok(last);
  assert.throws(
    () =>
      boundedQuotes.consume(first.quoteId, first.quoteContext, { required: true }, 20_000),
    ConflictException
  );
  assert.doesNotThrow(() =>
    boundedQuotes.consume(last.quoteId, last.quoteContext, { required: true }, 20_000)
  );
});

test("价格、额度或归属变化时拒绝核销且不泄露报价归属", () => {
  for (const changed of [
    context(600),
    { ...context(), userId: "special-other" },
    { ...context(), deviceCode: "CAB-OTHER" },
    { ...context(), reservationId: "reservation-other" }
  ]) {
    const quotes = new CabinetOpenQuoteService();
    const issued = quotes.issue(context(), 2_000);
    assert.throws(
      () => quotes.consume(issued.quoteId, changed, { required: true }, 2_001),
      ConflictException
    );
  }
});

test("报价过期和付费开柜缺少报价都安全失败，免费兼容请求可继续", () => {
  const quotes = new CabinetOpenQuoteService();
  const issued = quotes.issue(context(), 3_000);

  assert.throws(
    () =>
      quotes.consume(
        issued.quoteId,
        context(),
        { required: true },
        3_000 + CABINET_OPEN_QUOTE_TTL_MS
      ),
    ConflictException
  );
  assert.throws(
    () => quotes.consume(undefined, context(), { required: true }, 3_001),
    ConflictException
  );
  assert.doesNotThrow(() =>
    quotes.consume(
      undefined,
      { ...context(), preSettlement: { ...settlement(0), payableAmount: 0, chargeRequired: false } },
      { required: false },
      3_001
    )
  );
});

test("公益免费领取超出额度时，预览和正式开柜都在外呼前阻断", async () => {
  const previousDataFile = process.env.API_DATA_FILE;
  const previousBootstrap = process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
  const directory = mkdtempSync(join(tmpdir(), "vm-cabinet-free-only-"));

  try {
    process.env.API_DATA_FILE = join(directory, "store.json");
    process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
    const store = new InMemoryStoreService();
    store.events.splice(0, store.events.length);
    const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
    const device = store.devices[0];
    const door = device?.doors[0];
    const goods = door?.goods[0];
    assert.ok(user);
    assert.ok(device);
    assert.ok(door);
    assert.ok(goods);

    device.status = "online";
    device.lastSeenAt = new Date().toISOString();
    goods.price = 500;
    const catalogGoods = store.goodsCatalog.find((entry) => entry.goodsId === goods.goodsId);
    if (catalogGoods) {
      catalogGoods.price = 500;
    }
    if (store.getAvailableStock(device.deviceCode, goods.goodsId) < 1) {
      new InventoryBatchChangesService(store).recordBatchOnly({
        deviceCode: device.deviceCode,
        goodsId: goods.goodsId,
        quantity: 2,
        sourceType: "system"
      });
    }
    const stockBefore = store.getAvailableStock(device.deviceCode, goods.goodsId);
    user.quota = {
      dailyLimit: 0,
      categoryLimit: { [goods.category]: 0 }
    };
    store.specialAccessPolicies.splice(0, store.specialAccessPolicies.length, {
      id: "policy-cabinet-free-only",
      name: "公益免费边界测试",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
      goodsLimits: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          quantity: 1
        }
      ],
      applicableUserIds: [user.id],
      status: "active"
    });

    let gatewayCalls = 0;
    const gateway = {
      async openDoor() {
        gatewayCalls += 1;
        return {
          orderNo: `order-free-only-${gatewayCalls}`,
          smartVmExchange: undefined
        };
      },
      extractErrorMessage(error: unknown) {
        return error instanceof Error ? error.message : "error";
      },
      extractExchangeTrace() {
        return undefined;
      }
    } as unknown as SmartVmGateway;
    const accessRules = new AccessRulesService(store);
    const service = new CabinetEventsService(
      store,
      accessRules,
      gateway,
      {} as InventoryOrdersService,
      new AlertsService(store),
      new ReservationsService(store, accessRules),
      new ConfigService({ VM_RESERVATION_ONLY_PICKUP: "false" }),
      undefined,
      new CabinetOpenQuoteService()
    );
    const payload = {
      phone: user.phone,
      deviceCode: device.deviceCode,
      doorNum: door.doorNum,
      intentItems: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category,
          quantity: 1
        }
      ]
    };
    const isFreeOnlyRejection = (error: unknown) =>
      error instanceof BadRequestException &&
      /只支持免费领取|不能进入支付流程/.test(error.message);

    assert.throws(
      () => service.previewOpenSettlement(payload, { id: user.id, role: "special" }),
      isFreeOnlyRejection
    );
    await assert.rejects(
      () => service.openCabinet(payload, { id: user.id, role: "special" }),
      isFreeOnlyRejection
    );
    assert.equal(gatewayCalls, 0);
    assert.equal(store.events.length, 0);
    assert.equal(store.getAvailableStock(device.deviceCode, goods.goodsId), stockBefore);
  } finally {
    if (previousDataFile === undefined) {
      delete process.env.API_DATA_FILE;
    } else {
      process.env.API_DATA_FILE = previousDataFile;
    }
    if (previousBootstrap === undefined) {
      delete process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
    } else {
      process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = previousBootstrap;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
