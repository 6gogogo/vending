import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { CabinetEventRecord } from "@vm/shared-types";
import { buildActualPickupRequest, matchesActualPickupEvent } from "./actual-pickup";

test("扫码开门请求不携带预约、选择数量或商品明细", () => {
  const request = buildActualPickupRequest("13800000000", "91110265");
  assert.equal(request.pickupMode, "actual");
  assert.equal(request.openMode, "scan");
  assert.equal(request.intentItems, undefined);
  assert.equal(request.reservationId, undefined);
  const event = { userId: "user", deviceCode: request.deviceCode, doorNum: "1", pickupMode: "actual" } as CabinetEventRecord;
  assert.equal(matchesActualPickupEvent(event, "user", request), true);
  assert.equal(matchesActualPickupEvent(event, "other", request), false);
  assert.equal(matchesActualPickupEvent({ ...event, deviceCode: "other" }, "user", request), false);
  assert.equal(matchesActualPickupEvent({ ...event, pickupMode: undefined }, "user", request), false);
});

test("查询页面不创建预约或按库存隐藏商品，结果未知时保留防重复开门处理", async () => {
  const page = await readFile(new URL("../pages/special/device-detail.vue", import.meta.url), "utf8");
  assert.doesNotMatch(page, /createReservation|selectedMap|updateSelected|goods\.filter/);
  assert.match(page, /buildActualPickupRequest/);
  assert.match(page, /isOpenOutcomeUncertain/);
  assert.match(page, /showOpenPendingResult/);
  assert.match(page, /pickupCopy\.emptyStock/);
});
