import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConflictException } from "@nestjs/common";
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

test("真实开柜绑定服务端报价，价格漂移零副作用且丢失响应后重放不再外呼", async () => {
  const previousDataFile = process.env.API_DATA_FILE;
  const previousBootstrap = process.env.ENABLE_TEST_DEVICE_BOOTSTRAP;
  const directory = mkdtempSync(join(tmpdir(), "vm-cabinet-quote-"));

  try {
    const dataFile = join(directory, "store.json");
    process.env.API_DATA_FILE = dataFile;
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
    user.quota = {
      dailyLimit: 0,
      categoryLimit: { [goods.category]: 0 }
    };
    store.specialAccessPolicies.splice(0, store.specialAccessPolicies.length, {
      id: "policy-cabinet-quote",
      name: "报价核销测试",
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
    let gatewayMode: "success" | "unknown" = "success";
    const gateway = {
      async openDoor() {
        gatewayCalls += 1;
        if (gatewayMode === "unknown") {
          throw new Error("upstream response lost");
        }
        return {
          orderNo: `order-quote-${gatewayCalls}`,
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
    const reservations = new ReservationsService(store, accessRules);
    const quotes = new CabinetOpenQuoteService();
    const service = new CabinetEventsService(
      store,
      accessRules,
      gateway,
      {} as InventoryOrdersService,
      new AlertsService(store),
      reservations,
      new ConfigService({}),
      undefined,
      quotes
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

    await assert.rejects(
      () => service.openCabinet(payload, { id: user.id, role: "special" }),
      ConflictException
    );
    assert.equal(gatewayCalls, 0);
    assert.equal(store.events.length, 0);

    const stalePreview = service.previewOpenSettlement(payload, {
      id: user.id,
      role: "special"
    });
    assert.ok(stalePreview.quoteId);
    assert.equal(stalePreview.preSettlement?.payableAmount, 500);
    goods.price = 600;
    await assert.rejects(
      () =>
        service.openCabinet(
          { ...payload, quoteId: stalePreview.quoteId },
          { id: user.id, role: "special" }
        ),
      ConflictException
    );
    assert.equal(gatewayCalls, 0);
    assert.equal(store.events.length, 0);

    const currentPreview = service.previewOpenSettlement(payload, {
      id: user.id,
      role: "special"
    });
    assert.ok(currentPreview.quoteId);
    const opened = await service.openCabinet(
      { ...payload, quoteId: currentPreview.quoteId },
      { id: user.id, role: "special" }
    );
    assert.equal(opened.orderNo, "order-quote-1");
    assert.equal(gatewayCalls, 1);
    const event = store.events.find((entry) => entry.eventId === opened.eventId);
    assert.ok(event);
    assert.equal(
      event.openQuoteHash,
      createHash("sha256").update(currentPreview.quoteId).digest("hex")
    );
    assert.equal(JSON.stringify(event).includes(currentPreview.quoteId), false);
    const persistedState = readFileSync(dataFile, "utf8");
    assert.equal(persistedState.includes(currentPreview.quoteId), false);
    assert.equal(persistedState.includes(event.openQuoteHash), true);

    const replayedSuccess = await service.openCabinet(
      { ...payload, quoteId: currentPreview.quoteId },
      { id: user.id, role: "special" }
    );
    assert.equal(replayedSuccess.eventId, opened.eventId);
    assert.equal(replayedSuccess.orderNo, opened.orderNo);
    assert.equal(gatewayCalls, 1);
    assert.equal(store.events.length, 1);

    event.status = "failed";
    event.physicalDoorState = "closed";

    const unknownPreview = service.previewOpenSettlement(payload, {
      id: user.id,
      role: "special"
    });
    assert.ok(unknownPreview.quoteId);
    const unknownQuoteId = unknownPreview.quoteId;
    gatewayMode = "unknown";
    await assert.rejects(
      () =>
        service.openCabinet(
          { ...payload, quoteId: unknownQuoteId },
          { id: user.id, role: "special" }
        )
    );
    assert.equal(gatewayCalls, 2);
    assert.equal(store.events.length, 2);
    const pendingEvent = store.events.find(
      (entry) =>
        entry.openQuoteHash ===
        createHash("sha256").update(unknownQuoteId).digest("hex")
    );
    assert.ok(pendingEvent);

    const replayedUnknown = await service.openCabinet(
      { ...payload, quoteId: unknownQuoteId },
      { id: user.id, role: "special" }
    );
    assert.equal(replayedUnknown.eventId, pendingEvent.eventId);
    assert.equal(replayedUnknown.orderNo, pendingEvent.orderNo);
    assert.equal(gatewayCalls, 2);
    assert.equal(store.events.length, 2);
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
