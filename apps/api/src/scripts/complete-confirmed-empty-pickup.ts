/** 停服、校验备份后，按现场明确确认恢复一笔空取货；不创建会话或模拟平台回调。 */
import { ConfigService } from "@nestjs/config";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime";
import { InventoryBatchChangesService } from "../common/inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "../common/store/in-memory-store.service";
import { resolveRuntimeStoragePaths } from "../common/store/persistence";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety";
import { SystemAuditLogService } from "../common/store/system-audit-log.service";
import { AccessRulesService } from "../modules/access-rules/access-rules.service";
import { AlertsService } from "../modules/alerts/alerts.service";
import { CabinetEventsService } from "../modules/cabinet-events/cabinet-events.service";
import { ManualSettlementRecoveryService } from "../modules/cabinet-events/manual-settlement-recovery.service";
import { DevicesService } from "../modules/devices/devices.service";
import { SmartVmGateway } from "../modules/devices/smartvm.gateway";
import { InventoryOrdersService } from "../modules/inventory-orders/inventory-orders.service";
import { ReservationsService } from "../modules/reservations/reservations.service";

async function main() {
  const [eventId, orderNo, confirmation] = process.argv.slice(2);
  if (!eventId || !orderNo || confirmation !== "--confirmed-empty-and-backed-up" || process.argv.length !== 5) {
    throw new Error("需要精确事件号、订单号以及现场空取货与备份确认参数。");
  }
  const paths = resolveRuntimeStoragePaths();
  assertRuntimePathsSafe(paths);
  const writer = acquireFinancialSingleWriterForMaintenance();
  try {
    const store = new InMemoryStoreService();
    const event = store.events.find((entry) => entry.eventId === eventId && entry.orderNo === orderNo);
    if (!event || event.physicalDoorState !== "closed" || event.amount !== 0 || event.goods.length ||
        event.adjustments?.length || store.paymentOrders.some((entry) => entry.eventId === eventId)) {
      throw new Error("事件事实已变化或不符合空取货维护条件，未执行操作。");
    }
    if (event.paymentNotifyStatus === "success" && event.billingResolvedAt) {
      console.log(JSON.stringify({ eventId, completed: true, duplicated: true }));
      return;
    }
    const config = new ConfigService(process.env);
    const audit = new SystemAuditLogService();
    const path = "/internal/maintenance/confirmed-empty-pickup";
    const intent = audit.beginCriticalIntent({ method: "SYSTEM", path, metadata: { eventId, orderNo } });
    const batches = new InventoryBatchChangesService(store);
    const alerts = new AlertsService(store);
    const gateway = new SmartVmGateway(config, audit);
    const devices = new DevicesService(store, batches, gateway);
    const rules = new AccessRulesService(store);
    const reservations = new ReservationsService(store, rules, config);
    const inventory = new InventoryOrdersService(store, batches, devices, alerts, config);
    const recovery = new ManualSettlementRecoveryService(store, batches, alerts);
    const cabinet = new CabinetEventsService(store, rules, gateway, inventory, alerts, reservations,
      config, undefined, undefined, undefined, recovery);
    try {
      if (event.status === "closed" || event.manualSettlement) {
        const actor = { id: "system-maintenance", tenantId: store.getDefaultTenantId() };
        recovery.create(eventId, { items: [], confirmed: true,
          reason: "用户明确确认本次未取走商品；系统维护按空取货补记并回写平台。" }, actor);
        const log = store.logs.find((entry) => entry.type === "manual-settlement-recovery" && entry.relatedEventId === eventId);
        if (log) log.actor = { type: "system", name: "现场确认空取货维护" };
        store.persist();
        await cabinet.retryZeroCostPlatformCompletion(eventId, actor.id, actor.tenantId, true);
      } else {
        await cabinet.completeEmptyPickup(eventId);
      }
      store.persist();
      const completed = audit.completeCriticalOperation(intent, { method: "SYSTEM", path, statusCode: 200,
        durationMs: Date.now() - intent.startedAt, outcome: "completed", metadata: { eventId, orderNo } });
      if (!completed) throw new Error("完成记录审计失败，请检查审计存储。");
      console.log(JSON.stringify({ eventId, status: event.status, billingStatus: event.billingStatus,
        paymentNotifyStatus: event.paymentNotifyStatus,
        blockingEventId: reservations.findBlockingBillingEvent(event.userId)?.eventId ?? null }));
    } catch (error) {
      store.persist();
      audit.completeCriticalOperation(intent, { method: "SYSTEM", path, statusCode: 500,
        durationMs: Date.now() - intent.startedAt, outcome: "failed", metadata: { eventId, orderNo } });
      throw error;
    }
  } finally { writer.release(); }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "空取货维护失败。");
  process.exitCode = 1;
});
