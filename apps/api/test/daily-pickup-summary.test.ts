import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InventoryMovement } from "@vm/shared-types";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AnalyticsService } from "../src/modules/analytics/analytics.service";

test("每日汇总按实际商品计数，合并旧货号、跨日退回，不泄露人员且不混入调拨补货", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-daily-pickup-"));
  const previous = process.env.API_DATA_FILE;
  process.env.API_DATA_FILE = join(directory, "store.json");
  try {
    const store = new InMemoryStoreService();
    const goods = store.goodsCatalog[0]!;
    store.goodsCatalog.push({ ...goods, goodsId: "old-goods", goodsCode: "old-goods", mergedIntoGoodsId: goods.goodsId });
    const movement = (id: string, patch: Partial<InventoryMovement> = {}): InventoryMovement => ({
      id, orderNo: id, deviceCode: store.devices[0]!.deviceCode, userId: "private-person",
      goodsId: goods.goodsId, goodsName: goods.name, category: goods.category, type: "pickup",
      quantity: 2, unitPrice: 0, happenedAt: "2026-09-20T02:00:00.000Z", ...patch
    });
    store.inventory.splice(0, store.inventory.length,
      movement("pickup", { goodsId: "old-goods", quantity: 3 }),
      movement("partial-refund", { type: "refund", orderNo: "pickup", quantity: 1, happenedAt: "2026-09-21T03:00:00.000Z" }),
      movement("adjustment", { type: "adjustment", quantity: 2 }),
      movement("manual", { type: "manual-deduction", quantity: 50 }),
      movement("restock", { type: "manual-restock", quantity: 50 }),
      movement("donation", { type: "donation", quantity: 50 }),
      movement("before-business-day", { happenedAt: "2026-09-19T19:59:59.000Z", quantity: 7 }),
      movement("at-start", { happenedAt: "2026-09-19T20:00:00.000Z", quantity: 1 }),
      movement("at-next-start", { happenedAt: "2026-09-20T20:00:00.000Z", quantity: 1 })
    );
    const service = new AnalyticsService(store, {} as never, {} as never);
    const summary = service.getDailyPickupSummary("2026-09-20");
    assert.equal(summary.totalQuantity, 5);
    assert.equal(summary.goodsKinds, 1);
    assert.deepEqual(summary.items, [{ goodsId: goods.goodsId, goodsName: goods.name, quantity: 5 }]);
    assert.doesNotMatch(JSON.stringify(summary), /private-person|userId|phone|orderNo/);
    assert.equal(service.getDailyPickupSummary("2026-09-21").totalQuantity, 1);
    assert.equal(service.getDailyPickupSummary("2026-09-22").items.length, 0);
    for (const date of ["2026-02-30", "2026-13-01", "bad", ""]) assert.throws(() => service.getDailyPickupSummary(date), /有效日期/);
    for (let index = 0; index < 12; index++) store.inventory.push(movement(`distinct-${index}`, { goodsId: `goods-${index}`, quantity: 1 }));
    assert.ok(service.getDailyPickupSummary("2026-09-20").goodsKinds >= 12);
  } finally {
    if (previous === undefined) delete process.env.API_DATA_FILE; else process.env.API_DATA_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
