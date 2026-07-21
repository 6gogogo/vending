import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigService } from "@nestjs/config";
import type { CabinetEventRecord, PaymentOrderRecord } from "@vm/shared-types";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AccessRulesService } from "../src/modules/access-rules/access-rules.service";
import { AlertsService } from "../src/modules/alerts/alerts.service";
import { CabinetEventsService } from "../src/modules/cabinet-events/cabinet-events.service";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../src/modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../src/modules/reservations/reservations.service";

const temporaryDirectories: string[] = [];
const originalDataFile = process.env.API_DATA_FILE;

const createStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-event-payment-recovery-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  return new InMemoryStoreService();
};

after(() => {
  if (originalDataFile === undefined) {
    delete process.env.API_DATA_FILE;
  } else {
    process.env.API_DATA_FILE = originalDataFile;
  }
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("特殊群体事件详情只暴露本人真实待确认支付单的最小核对摘要", () => {
  const store = createStore();
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(user);
  const now = new Date().toISOString();
  const event: CabinetEventRecord = {
    eventId: "event-own-pending-real-payment",
    orderNo: "order-own-pending-real-payment",
    userId: user.id,
    phone: user.phone,
    role: "special",
    deviceCode: "CAB-RECOVERY",
    doorNum: "1",
    status: "settled",
    createdAt: now,
    updatedAt: now,
    amount: 500,
    goods: []
  };
  const realPendingOrder: PaymentOrderRecord = {
    id: "payment-own-pending-real",
    paymentNo: "wx-own-pending-real",
    provider: "wechat",
    phase: "post_settlement",
    status: "pending",
    amount: 500,
    currency: "CNY",
    subject: "本人待确认支付",
    eventId: event.eventId,
    orderNo: event.orderNo,
    payerUserId: user.id,
    providerTransactionId: "不得暴露给移动端",
    invokePayload: { paySign: "不得暴露给移动端", simulated: false },
    metadata: { simulated: false },
    createdAt: now,
    updatedAt: now
  };
  const simulatedPendingOrder: PaymentOrderRecord = {
    ...realPendingOrder,
    id: "payment-own-pending-mock",
    paymentNo: "mock-own-pending",
    metadata: { simulated: true },
    updatedAt: new Date(Date.now() + 1_000).toISOString()
  };
  store.events.push(event);
  store.paymentOrders.push(realPendingOrder, simulatedPendingOrder);

  const accessRules = new AccessRulesService(store);
  const service = new CabinetEventsService(
    store,
    accessRules,
    {} as SmartVmGateway,
    {} as InventoryOrdersService,
    new AlertsService(store),
    new ReservationsService(store, accessRules),
    new ConfigService({})
  );

  const detail = service.getDetail(event.eventId, { id: user.id, role: "special" });
  const pendingPayment = detail.paymentRecovery?.pendingPayment;

  assert.equal(pendingPayment?.id, realPendingOrder.id);
  assert.equal(pendingPayment?.paymentNo, realPendingOrder.paymentNo);
  assert.equal(pendingPayment?.amount, realPendingOrder.amount);
  assert.equal("providerTransactionId" in (pendingPayment ?? {}), false);
  assert.equal("invokePayload" in (pendingPayment ?? {}), false);
  assert.equal(event.paymentRecovery, undefined);
});
