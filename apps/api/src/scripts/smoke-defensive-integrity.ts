import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigService } from "@nestjs/config";

import { InventoryBatchChangesService } from "../common/inventory/inventory-batch-changes.service.js";
import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { AlertsService } from "../modules/alerts/alerts.service.js";
import { VerificationCodeService } from "../modules/auth/verification-code.service.js";
import { MerchantGoodsTemplatesService } from "../modules/merchant-goods-templates/merchant-goods-templates.service.js";
import { RegistrationApplicationsService } from "../modules/registration-applications/registration-applications.service.js";
import { WarehousesService } from "../modules/warehouses/warehouses.service.js";

const runtimeDir = mkdtempSync(join(tmpdir(), "vm-defensive-integrity-"));
process.env.NODE_ENV = "test";
process.env.API_DATA_FILE = join(runtimeDir, "store.json");
process.env.SYSTEM_LOG_FILE = join(runtimeDir, "system-audit.ndjson");
process.env.UPLOAD_DIR = join(runtimeDir, "uploads");

const snapshotInventoryState = (store: InMemoryStoreService) =>
  JSON.stringify({
    devices: store.devices,
    goodsBatches: store.goodsBatches,
    stocktakes: store.stocktakes,
    logs: store.logs
  });

try {
  const store = new InMemoryStoreService();
  const batchChanges = new InventoryBatchChangesService(store);
  const warehouses = new WarehousesService(store, batchChanges);
  const device = store.devices.find((entry) => entry.doors.some((door) => door.goods.length > 0));

  assert.ok(device, "种子数据应包含可盘点柜机");

  const expectedGoodsIds = Array.from(
    new Set([
      ...device.doors.flatMap((door) => door.goods.map((goods) => goods.goodsId)),
      ...store
        .getGoodsBatches(device.deviceCode)
        .filter((entry) => entry.remainingQuantity !== 0)
        .map((entry) => entry.goodsId)
    ])
  );
  const validItems = expectedGoodsIds.map((goodsId) => ({
    goodsId,
    actualQuantity: store.getCurrentStock(device.deviceCode, goodsId)
  }));
  const beforeRejectedStocktakes = snapshotInventoryState(store);

  assert.throws(
    () => warehouses.stocktake({ deviceCode: device.deviceCode, items: [] }),
    /盘点明细不能为空/
  );
  assert.equal(snapshotInventoryState(store), beforeRejectedStocktakes, "空盘点不得修改任何库存状态");

  assert.throws(
    () =>
      warehouses.stocktake({
        deviceCode: device.deviceCode,
        items: [...validItems, { goodsId: "missing-goods", actualQuantity: 1 }]
      }),
    /未找到对应货品/
  );
  assert.equal(snapshotInventoryState(store), beforeRejectedStocktakes, "含无效货品的盘点失败后必须完整回滚");

  const stocktake = warehouses.stocktake({
    deviceCode: device.deviceCode,
    note: "防御性回归测试",
    items: validItems
  });
  assert.equal(stocktake.items.length, validItems.length, "完整盘点应成功创建记录");

  const registration = new RegistrationApplicationsService(
    store,
    {} as VerificationCodeService,
    new ConfigService()
  );
  const pendingApplication = store.registrationApplications.find((entry) => entry.status === "pending");

  assert.ok(pendingApplication, "种子数据应包含待审申请");
  registration.review(pendingApplication.id, { decision: "rejected", reason: "本地回归测试" }, "admin-001");
  assert.throws(
    () => registration.review(pendingApplication.id, { decision: "approved" }, "admin-001"),
    /不能重复或改写审核结果/
  );
  assert.equal(pendingApplication.status, "rejected", "第二次审核不得覆盖第一次审核结果");

  const restocks = new MerchantGoodsTemplatesService(store, batchChanges, new AlertsService(store));
  const merchant = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  const sourceEvent = store.events.find((entry) => entry.userId === merchant?.id);
  const template = merchant ? restocks.list({ id: merchant.id, role: merchant.role })[0] : undefined;

  assert.ok(merchant && sourceEvent && template, "种子数据应包含商家、柜机事件和补货模板");

  const eventId = "evt-defensive-restock";
  store.events.unshift({
    ...structuredClone(sourceEvent),
    eventId,
    orderNo: "ord-defensive-restock",
    userId: merchant.id,
    phone: merchant.phone,
    role: merchant.role,
    status: "closed",
    operationType: "restock",
    hasInboundGoods: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goods: []
  });

  const restockPayload = {
    templateId: template.id,
    deviceCode: sourceEvent.deviceCode,
    quantity: 1,
    productionDate: new Date().toISOString().slice(0, 10),
    confirmed: true,
    cabinetEventId: eventId
  };
  const firstRestock = restocks.createRestock(merchant.id, restockPayload);
  const countsAfterFirstRestock = {
    inventory: store.inventory.length,
    batches: store.goodsBatches.length,
    logs: store.logs.length,
    alerts: store.alerts.length
  };
  const replayedRestock = restocks.createRestock(merchant.id, restockPayload);

  assert.equal(firstRestock.idempotentReplay, false);
  assert.equal(replayedRestock.idempotentReplay, true);
  assert.deepEqual(
    {
      inventory: store.inventory.length,
      batches: store.goodsBatches.length,
      logs: store.logs.length,
      alerts: store.alerts.length
    },
    countsAfterFirstRestock,
    "同一入柜事件重放不得重复写库存、批次、日志或预警"
  );
  assert.throws(
    () => restocks.createRestock(merchant.id, { ...restockPayload, quantity: 2 }),
    /不能重复改写/
  );

  const feedbackAlerts = new AlertsService(store);
  assert.throws(
    () => feedbackAlerts.createFeedbackTask({ detail: "短", sourceKey: "anonymous-short" }),
    /5 至 1000/
  );
  for (let index = 0; index < 3; index += 1) {
    feedbackAlerts.createFeedbackTask({
      detail: `本地匿名反馈限流回归测试 ${index}`,
      sourceKey: "anonymous-rate-limit"
    });
  }
  assert.throws(
    () =>
      feedbackAlerts.createFeedbackTask({
        detail: "本地匿名反馈限流回归测试 4",
        sourceKey: "anonymous-rate-limit"
      }),
    /反馈提交过于频繁/
  );

  store.persist();
  const persisted = JSON.parse(readFileSync(process.env.API_DATA_FILE, "utf8")) as { stocktakes?: unknown[] };
  assert.ok(Array.isArray(persisted.stocktakes), "原子写入后的数据文件必须可解析");
  assert.equal(
    readdirSync(runtimeDir).filter((entry) => entry.endsWith(".tmp")).length,
    0,
    "原子写入完成后不应残留临时文件"
  );

  console.log("防御性数据完整性回归通过：空盘点、失败回滚、审批单向、补货幂等、反馈限流、原子持久化。");
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}
