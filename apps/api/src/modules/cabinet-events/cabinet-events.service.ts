import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  CabinetEventRecord,
  CabinetEventStatus,
  CabinetIntentItem,
  CabinetOpenPreviewResult,
  CabinetOpenPurpose,
  CabinetOpenRequest,
  CabinetOpenResult,
  CabinetPreSettlement,
  CabinetPreSettlementItem,
  CabinetSettlementComparison,
  CabinetSettlementComparisonItem,
  GoodsCategory,
  OperationLogCategory,
  PaymentOrderRecoverySummary,
  SmartVmAdjustmentPayload,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmSettlementPayload,
  UserRecord,
  UserRole
} from "@vm/shared-types";

import {
  FinancialOperationCoordinator,
  type FinancialOperationLease
} from "../../common/coordination/financial-operation-coordinator";
import { isProductionRuntime } from "../../common/config/production-safety";
import { isReservationOnlyPickup } from "../../common/config/reservation-only-pickup";
import { createCallbackReplayFingerprint } from "../../common/logging/callback-log-sanitizer";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AccessRulesService } from "../access-rules/access-rules.service";
import { AlertsService } from "../alerts/alerts.service";
import { DeviceOperationCoordinator } from "../devices/device-operation-coordinator";
import { SmartVmGateway } from "../devices/smartvm.gateway";
import { InventoryOrdersService } from "../inventory-orders/inventory-orders.service";
import { ReservationsService } from "../reservations/reservations.service";
import { CabinetOpenQuoteService } from "./cabinet-open-quote.service";

type CallbackBilling = Pick<
  CabinetPreSettlement,
  "totalQuantity" | "freeQuantity" | "paidQuantity" | "originalAmount" | "freeAmount" | "payableAmount"
> & {
  platformAmount: number;
  items: CabinetPreSettlementItem[];
};

type AuthActor =
  | { id: string; role: UserRole; tenantId?: string }
  | undefined;

@Injectable()
export class CabinetEventsService {
  private readonly deviceOperations: DeviceOperationCoordinator;
  private readonly openQuotes: CabinetOpenQuoteService;
  private readonly financialOperations: FinancialOperationCoordinator;

  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway,
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService,
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(ReservationsService) private readonly reservationsService: ReservationsService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() @Inject(DeviceOperationCoordinator) deviceOperations?: DeviceOperationCoordinator,
    @Optional() @Inject(CabinetOpenQuoteService) openQuotes?: CabinetOpenQuoteService,
    @Optional()
    @Inject(FinancialOperationCoordinator)
    financialOperations?: FinancialOperationCoordinator
  ) {
    this.deviceOperations = deviceOperations ?? new DeviceOperationCoordinator(store);
    this.openQuotes = openQuotes ?? new CabinetOpenQuoteService();
    this.financialOperations =
      financialOperations ?? new FinancialOperationCoordinator();
  }

  previewOpenSettlement(payload: CabinetOpenRequest, actor?: AuthActor): CabinetOpenPreviewResult {
    const {
      user,
      quotaSummary,
      intentItems,
      preSettlement,
      doorNum,
      reservation,
      operationType,
      hasInboundGoods,
      openReason
    } = this.prepareOpenContext(payload, actor);
    const quote = preSettlement
      ? this.openQuotes.issue({
          userId: user.id,
          deviceCode: payload.deviceCode,
          doorNum,
          reservationId: reservation?.id,
          intentItems,
          preSettlement
        })
      : undefined;

    return {
      deviceCode: payload.deviceCode,
      doorNum,
      ...quote,
      role: user.role,
      operationType,
      hasInboundGoods,
      openReason,
      remainingQuota: quotaSummary?.remainingToday,
      acceptedIntentItems: intentItems.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity
      })),
      preSettlement
    };
  }

  async openCabinet(payload: CabinetOpenRequest, actor?: AuthActor) {
    const initialIdentity = this.resolveOpenIdentity(payload, actor);
    const existingEvent = this.findOpenQuoteReplay(
      payload,
      initialIdentity.user.id,
      initialIdentity.doorNum
    );
    if (existingEvent) {
      return this.buildOpenQuoteReplayResult(existingEvent);
    }

    return this.deviceOperations.runExclusiveOpen(
      { deviceCode: payload.deviceCode, doorNum: initialIdentity.doorNum },
      async () => {
        const lockedIdentity = this.resolveOpenIdentity(payload, actor);
        const lockedExistingEvent = this.findOpenQuoteReplay(
          payload,
          lockedIdentity.user.id,
          lockedIdentity.doorNum
        );
        if (lockedExistingEvent) {
          return this.buildOpenQuoteReplayResult(lockedExistingEvent);
        }

        // 获取同柜门互斥锁后重新计算额度、价格和预约状态，避免排队期间状态变化。
        const {
          user,
          quotaSummary,
          intentItems,
          preSettlement,
          doorNum,
          reservation,
          operationType,
          hasInboundGoods,
          openReason
        } = this.prepareOpenContext(payload, actor, lockedIdentity);

        const openQuoteHash = this.openQuotes.consume(
          payload.quoteId,
          {
            userId: user.id,
            deviceCode: payload.deviceCode,
            doorNum,
            reservationId: reservation?.id,
            intentItems,
            preSettlement
          },
          { required: Boolean(preSettlement?.chargeRequired) }
        );

        const logCategory = this.getOpenLogCategory(user.role, operationType);
        const eventId = this.store.createId("event");
        const createdAt = new Date().toISOString();
        const commandEvent: CabinetEventRecord = {
          eventId,
          orderNo: `pending-${eventId}`,
          userId: user.id,
          phone: user.phone,
          role: user.role,
          openQuoteHash,
          deviceCode: payload.deviceCode,
          doorNum,
          openMode: payload.openMode ?? "manual",
          operationType,
          hasInboundGoods,
          openReason,
          status: "created",
          physicalDoorState: "unknown",
          createdAt,
          updatedAt: createdAt,
          amount: 0,
          billingStatus: preSettlement || this.isNoChargeOperationalOpen({
            role: user.role,
            hasInboundGoods
          }) ? "pending" : undefined,
          reservationId: reservation?.id,
          reservationOnlyPickup:
            this.isReservationOnlyPickup() && user.role === "special" && Boolean(reservation),
          intentItems,
          preSettlement,
          goods: []
        };
        this.store.events.unshift(commandEvent);
        this.store.updateDeviceRuntime(payload.deviceCode, {
          lastCommandAt: createdAt,
          openedAfterLastCommand: false
        });
        // 外呼前同步落盘；即使进程在超时或断连后退出，重启后仍能阻止重复开门。
        this.store.persist();

        let openResult: Awaited<ReturnType<SmartVmGateway["openDoor"]>>;

        try {
          openResult = await this.smartVmGateway.openDoor({
            userId: user.id,
            eventId,
            deviceCode: payload.deviceCode,
            doorNum,
            phone: payload.phone
          });
        } catch (error) {
          const detail = this.smartVmGateway.extractErrorMessage(error);
          const smartVmExchange = this.smartVmGateway.extractExchangeTrace(error);
          const definitelyRejected =
            this.smartVmGateway.isDefiniteOpenDoorRejection?.(error) ?? false;

          if (commandEvent.status === "created" || commandEvent.status === "opening") {
            commandEvent.status = definitelyRejected ? "failed" : commandEvent.status;
            if (definitelyRejected) {
              commandEvent.physicalDoorState = "closed";
            }
            commandEvent.updatedAt = new Date().toISOString();
          }

          const commandRejected = definitelyRejected || commandEvent.status === "failed";
          const outcomeUnknown =
            commandEvent.status === "created" || commandEvent.status === "opening";

          this.store.logOperation({
            category: logCategory,
            type: "open-cabinet",
            status: commandRejected ? "failed" : outcomeUnknown ? "pending" : "success",
            actor: {
              type: user.role,
              id: user.id,
              name: user.name,
              role: user.role
            },
            primarySubject: {
              type: "device",
              id: payload.deviceCode,
              label: payload.deviceCode
            },
            secondarySubject: {
              type: "user",
              id: user.id,
              label: user.name
            },
            description: commandRejected
              ? `${user.name} 发起的 ${payload.deviceCode} 开柜请求被平台拒绝。`
              : outcomeUnknown
                ? `${user.name} 发起的 ${payload.deviceCode} 开柜请求结果待确认。`
                : `${user.name} 发起的 ${payload.deviceCode} 开柜请求已由设备回调确认。`,
            detail: commandRejected
              ? `柜机平台明确拒绝：${detail}`
              : outcomeUnknown
              ? `柜机平台结果未知：${detail}；为避免重复开门，未决状态将保留到可信关门回调或管理员现场确认。`
                : `柜机网关响应异常，但设备回调已确认事件状态为 ${commandEvent.status}。`,
            relatedEventId: eventId,
            metadata: {
              deviceCode: payload.deviceCode,
              doorNum,
              operationType,
              hasInboundGoods,
              openReason,
              commandOutcome: commandRejected
                ? "rejected"
                : outcomeUnknown
                  ? "unknown"
                  : "callback_confirmed",
              smartVmExchange,
              undoState: "not_undoable"
            }
          });
          // 异常响应不会经过成功持久化拦截器，必须在抛错前保存租约或释放结果。
          this.store.persist();
          if (outcomeUnknown) {
            throw new ConflictException({
              message: "柜机平台响应异常，开门结果待确认，请勿重复操作。",
              code: "operation_indeterminate",
              operationId: eventId,
              retryable: false
            });
          }

          if (commandRejected) {
            throw new ConflictException({
              message: "柜机平台已拒绝开门请求。",
              code: "operation_rejected",
              operationId: eventId,
              retryable: false
            });
          }

          throw new ConflictException({
            message: "柜机开门状态已由平台回调确认，请刷新状态后继续。",
            code: "operation_confirmed",
            operationId: eventId,
            retryable: false
          });
        }

        commandEvent.orderNo = openResult.orderNo;
        commandEvent.updatedAt = new Date().toISOString();
        this.store.logOperation({
          category: logCategory,
          type: "open-cabinet",
          status: "pending",
          actor: {
            type: user.role,
            id: user.id,
            name: user.name,
            role: user.role
          },
          primarySubject: {
            type: "device",
            id: payload.deviceCode,
            label: payload.deviceCode
          },
          secondarySubject: {
            type: "user",
            id: user.id,
            label: user.name
          },
          description: `${user.name} 发起了 ${payload.deviceCode} 的开柜请求。`,
          detail: `事件 ${eventId} 已创建，等待设备返回门状态。`,
          relatedEventId: eventId,
          relatedOrderNo: openResult.orderNo,
          metadata: {
            deviceCode: payload.deviceCode,
            category: payload.category,
            openMode: payload.openMode ?? "manual",
            operationType,
            hasInboundGoods,
            openReason,
            intentItems,
            preSettlement,
            reservationId: reservation?.id,
            smartVmExchange: openResult.smartVmExchange
          }
        });
        this.store.persist();

        return {
          orderNo: openResult.orderNo,
          eventId,
          deviceCode: payload.deviceCode,
          doorNum,
          reservationId: reservation?.id,
          role: user.role,
          openMode: payload.openMode ?? "manual",
          operationType,
          hasInboundGoods,
          openReason,
          remainingQuota: quotaSummary?.remainingToday,
          acceptedIntentItems: intentItems.map((item) => ({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: item.quantity
          })),
          preSettlement
        };
      },
      {
        userId: initialIdentity.user.role === "special" ? initialIdentity.user.id : undefined
      }
    );
  }

  list(userId?: string, actor?: AuthActor) {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const visibleEvents = actor.tenantId
      ? this.store.events.filter((entry) =>
          this.eventBelongsToTenant(entry, actor.tenantId!)
        )
      : this.store.events;

    if (actor.role !== "admin") {
      return visibleEvents.filter((entry) => entry.userId === actor.id);
    }

    if (!userId) {
      return visibleEvents;
    }

    return visibleEvents.filter((entry) => entry.userId === userId);
  }

  getDetail(eventId: string, actor?: AuthActor) {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const event = this.store.events.find((entry) => entry.eventId === eventId);

    if (!event) {
      throw new BadRequestException("未找到对应开柜事件。");
    }

    if (actor.tenantId && !this.eventBelongsToTenant(event, actor.tenantId)) {
      throw new NotFoundException("未找到对应开柜事件。");
    }

    if (actor.role !== "admin" && actor.id !== event.userId) {
      throw new ForbiddenException("当前账号无权查看该开柜事件。");
    }

    return this.attachOwnPendingPaymentRecovery(event, actor);
  }

  private eventBelongsToTenant(event: CabinetEventRecord, tenantId: string) {
    const tenantIds: string[] = [];
    const user = this.store.users.find((entry) => entry.id === event.userId);
    const device = this.store.devices.find(
      (entry) => entry.deviceCode === event.deviceCode
    );

    if (user) {
      const userTenantId = this.store.getUserTenantId(user);
      if (userTenantId) {
        tenantIds.push(userTenantId);
      }
    }

    if (device) {
      tenantIds.push(this.store.getDeviceTenantId(device));
    }

    return tenantIds.length > 0 && tenantIds.every((value) => value === tenantId);
  }

  /**
   * 移动端只需知道“有一张本人真实待确认支付单可以请求后台核对”。
   * 不把付款身份、支付参数、渠道交易号或原始回调交给浏览器，也不在
   * 读取事件时调用支付渠道。
   */
  private attachOwnPendingPaymentRecovery(
    event: CabinetEventRecord,
    actor?: { id: string; role: CabinetEventRecord["role"] }
  ): CabinetEventRecord {
    if (actor?.role !== "special" || actor.id !== event.userId) {
      return event;
    }

    return {
      ...event,
      paymentRecovery: {
        ...event.paymentRecovery,
        pendingPayment: this.findPendingRealPaymentRecovery(event, event.orderNo)
      },
      adjustments: event.adjustments?.map((adjustment) => ({
        ...adjustment,
        paymentRecovery: {
          ...adjustment.paymentRecovery,
          pendingPayment: this.findPendingRealPaymentRecovery(event, adjustment.orderNo)
        }
      }))
    };
  }

  private findPendingRealPaymentRecovery(
    event: CabinetEventRecord,
    businessOrderNo: string
  ): PaymentOrderRecoverySummary | undefined {
    const order = this.store.paymentOrders
      .filter(
        (entry) =>
          entry.eventId === event.eventId &&
          (entry.adjustmentOrderNo ?? entry.orderNo) === businessOrderNo &&
          entry.status === "pending" &&
          entry.metadata?.simulated !== true &&
          entry.invokePayload?.simulated !== true
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    if (!order) {
      return undefined;
    }

    return {
      id: order.id,
      paymentNo: order.paymentNo,
      provider: order.provider,
      phase: order.phase,
      status: order.status,
      amount: order.amount,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
  }

  listCallbackLogs(limit = 20, deviceCode?: string, tenantId?: string) {
    if (!tenantId) {
      throw new ForbiddenException("当前会话未进入客户实例。");
    }

    const resolvedLimit = Math.max(1, limit);
    const normalizedDeviceCode = deviceCode?.trim();
    const matches: ReturnType<typeof this.toCallbackLogView>[] = [];

    for (const entry of this.store.callbackLog) {
      if (!this.callbackLogBelongsToTenant(entry, tenantId)) {
        continue;
      }

      if (
        normalizedDeviceCode &&
        entry.payload.deviceCode !== normalizedDeviceCode
      ) {
        continue;
      }

      matches.push(this.toCallbackLogView(entry));

      if (matches.length >= resolvedLimit) {
        break;
      }
    }

    return matches;
  }

  private callbackLogBelongsToTenant(
    entry: (typeof this.store.callbackLog)[number],
    tenantId: string
  ) {
    const device = entry.payload.deviceCode
      ? this.store.devices.find(
          (candidate) => candidate.deviceCode === entry.payload.deviceCode
        )
      : undefined;
    const event = entry.payload.eventId
      ? this.store.events.find(
          (candidate) => candidate.eventId === entry.payload.eventId
        )
      : undefined;

    if (
      entry.payload.deviceCode &&
      (!device || this.store.getDeviceTenantId(device) !== tenantId)
    ) {
      return false;
    }

    if (
      entry.payload.eventId &&
      (!event || !this.eventBelongsToTenant(event, tenantId))
    ) {
      return false;
    }

    return Boolean(device || event);
  }

  handleDoorStatus(payload: SmartVmDoorStatusPayload & Record<string, unknown>) {
    this.assertSignature(payload);
    const event = this.store.events.find((entry) => entry.eventId === payload.eventId);

    if (event) {
      this.assertSmartVmCallbackBinding(event, payload);
      this.assertSmartVmCallbackFreshness(payload, event);
    }

    if (this.isSmartVmCallbackReplay("door-status", payload)) {
      return { eventId: payload.eventId, duplicated: true };
    }

    const callbackLog = this.store.logCallback("door-status", payload);

    // 把门状态链路完整落下来，管理员才能快速判断是设备异常还是流程卡住。
    if (!event) {
      this.alertsService.create({
        type: "callback",
        title: "收到未知开门状态回调",
        deviceCode: payload.deviceCode,
        dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        detail: `设备回调返回了未知事件 ${payload.eventId}。`
      });
      return { eventId: payload.eventId };
    }

    const nextStatus = this.resolveDoorCallbackStatus(event.status, payload.status);
    const isTrustedPhysicalClose = payload.status === "CLOSED";
    const isTerminalBusinessStatus = event.status === "settled" || event.status === "refunded";
    const isTrustedPhysicalOpen =
      payload.status === "SUCCESS" &&
      isTerminalBusinessStatus &&
      !this.hasRecordedDoorClose(event.eventId);

    if (!nextStatus && !isTrustedPhysicalClose && !isTrustedPhysicalOpen) {
      return { eventId: payload.eventId, duplicated: false, ignored: true };
    }

    event.updatedAt = new Date().toISOString();
    this.deviceOperations.recordTrustedActivity(payload.deviceCode, event.updatedAt);

    if (payload.status === "OPENDING") {
      event.physicalDoorState = "unknown";
      if (nextStatus) {
        event.status = nextStatus;
      }
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "unknown"
      });
    } else if (payload.status === "SUCCESS") {
      // 结算与开门成功回调也可能乱序。业务终态不可回退，但可信物理信号仍要
      // 更新运行态并履约预约；若同一事件已经收到 CLOSED，则继续保持物理关门。
      event.physicalDoorState = "open";
      if (nextStatus) {
        event.status = nextStatus;
      }
      this.reservationsService.markFulfilled(event.reservationId, event.eventId);
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "open",
        lastOpenedAt: event.updatedAt,
        openedAfterLastCommand: true
      });
    } else if (payload.status === "CLOSED") {
      // 结算回调与关门回调可能乱序到达。即使业务事件已经结算，也必须接受
      // 经过绑定、时效和重放校验的物理关门信号，避免柜机永久停留在“门已开”状态。
      event.physicalDoorState = "closed";
      if (nextStatus) {
        event.status = nextStatus;
      }
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "closed",
        lastClosedAt: event.updatedAt,
        openedAfterLastCommand:
          payload.doorIsOpen === "Y"
            ? true
            : this.store.getDeviceRuntime(payload.deviceCode).openedAfterLastCommand
      });
    } else if (payload.status === "FAIL") {
      // FAIL 只说明开门指令失败，并不等同于可信的物理关门信号。
      // 在 CLOSED 回调明确确认前保持 unknown，以免把指令失败误记为物理关门；
      // 该未决状态会阻断后续开门，直到可信关门回调或管理员现场确认。
      event.physicalDoorState = "unknown";
      if (nextStatus) {
        event.status = nextStatus;
      }
      this.store.updateDeviceRuntime(payload.deviceCode, {
        doorState: "unknown"
      });
      this.alertsService.create({
        type: "device_fault",
        title: "开门失败",
        deviceCode: payload.deviceCode,
        targetUserId: event.userId,
        dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        detail: `柜机平台已受理订单 ${event.orderNo}，但设备 ${payload.deviceCode} 对事件 ${payload.eventId} 返回了 FAIL；SmartVM 1.1 门状态回调未提供具体故障原因。`,
        relatedEventId: event.eventId
      });
    }

    this.store.logOperation({
      category: "device",
      type: "door-status-callback",
      status: payload.status === "FAIL" ? "failed" : "success",
      actor: {
        type: "system",
        name: "设备回调"
      },
      primarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      secondarySubject: {
        type: "event",
        id: payload.eventId,
        label: event.orderNo
      },
      description: `设备 ${payload.deviceCode} 返回门状态 ${payload.status}。`,
      detail: `事件 ${payload.eventId} 已更新为 ${event.status}。`,
      relatedEventId: payload.eventId,
      relatedOrderNo: event.orderNo,
      metadata: {
        deviceCode: payload.deviceCode,
        status: payload.status,
        callbackLogId: callbackLog.id,
        callbackPayload: callbackLog.payload
      }
    });

    return { eventId: payload.eventId, duplicated: false };
  }

  handleSettlement(payload: SmartVmSettlementPayload & Record<string, unknown>) {
    this.assertSignature(payload);
    const event = this.getEventByPlatformOrderNo(payload.orderNo);
    this.assertSmartVmCallbackBinding(event, payload);
    this.assertSmartVmCallbackFreshness(payload, event);

    const callbackReplay = this.isSmartVmCallbackReplay("settlement", payload);
    const settlementWasAlreadyRecorded = this.hasSettlementRecord(payload.orderNo);

    if (
      callbackReplay &&
      (event.status === "settled" || event.status === "refunded") &&
      settlementWasAlreadyRecorded
    ) {
      return {
        movements: this.store.inventory.filter(
          (entry) =>
            entry.orderNo === payload.orderNo &&
            (entry.type === "pickup" || entry.type === "donation")
        ),
        duplicated: true,
        paymentNotifyStatus: event.paymentNotifyStatus,
        paymentNotifyMessage: event.paymentNotifyMessage
      };
    }

    this.inventoryOrdersService.validateSettlementPayload(event, payload);
    this.assertSettlementTransition(event, payload);

    if (event.status === "settled" && settlementWasAlreadyRecorded) {
      this.assertHistoricalSettlementReplayMatches(event, payload);
      return {
        movements: this.store.inventory.filter(
          (entry) =>
            entry.orderNo === payload.orderNo &&
            (entry.type === "pickup" || entry.type === "donation")
        ),
        duplicated: true,
        paymentNotifyStatus: event.paymentNotifyStatus,
        paymentNotifyMessage: event.paymentNotifyMessage
      };
    }

    const callbackLog = this.getOrCreateSmartVmCallbackLog("settlement", payload, callbackReplay);
    const callbackBilling = settlementWasAlreadyRecorded
      ? undefined
      : this.buildCallbackBilling(event, payload);
    event.status = "settled";
    event.platformAmount = payload.amount;
    if (callbackBilling) {
      event.amount = callbackBilling.payableAmount;
    } else if (!settlementWasAlreadyRecorded) {
      event.amount = payload.amount;
    }
    event.updatedAt = new Date().toISOString();
    event.paymentNotifyUrl = payload.notifyUrl;
    const settlementAlreadyRecorded = this.inventoryOrdersService
      .recordSettlement(
        event,
        payload,
        callbackBilling ? { quotaItems: callbackBilling.items } : undefined
      );

    if (event.paymentNotifyStatus !== "success") {
      event.paymentNotifyStatus = "pending";
      event.paymentNotifyMessage = settlementAlreadyRecorded.duplicated
        ? "重复收到结算回调，已保持现有记录，等待向平台回写付款成功。"
        : "等待向平台回写付款成功。";
    }

    if (!settlementAlreadyRecorded.duplicated) {
      event.goods =
        payload.detail?.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: this.getGoodsCategory(event.deviceCode, item.goodsId),
          quantity: item.quantity,
          unitPrice: item.unitPrice
        })) ?? [];
    }

    const settlementComparison = this.compareSettlement(event, payload);
    event.settlementComparison = settlementComparison;

    if (!settlementAlreadyRecorded.duplicated && callbackBilling) {
      this.applyCallbackBilling(event, callbackBilling, settlementComparison);
    } else if (event.role === "special" && event.intentItems?.length && !event.billingStatus) {
      event.billingStatus = settlementComparison.matched
        ? event.amount > 0
          ? "payable"
          : "free"
        : "mismatch";
    }

    if (event.intentItems?.length && !settlementComparison.matched) {
      this.alertsService.create({
        type: "callback",
        grade: "feedback",
        title: "实际领取与用户选择不一致",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: [
          `事件 ${event.eventId}`,
          `柜机 ${event.deviceCode}`,
          `用户选择：${this.formatComparisonItems(settlementComparison.intendedItems)}`,
          `平台结算：${this.formatComparisonItems(settlementComparison.settledItems)}`
        ].join("；"),
        previewDetail: settlementComparison.summary,
        relatedEventId: event.eventId
      });
    }

    if (!settlementAlreadyRecorded.duplicated && event.billingDeltaType === "supplement") {
      this.alertsService.create({
        type: "callback",
        grade: "warning",
        title: "用户结算需补差",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: [
          `事件 ${event.eventId}`,
          `原预估 ${this.formatAmount(event.billingBaseAmount ?? 0)}`,
          `按柜机回调商品应付 ${this.formatAmount(event.billingActualAmount ?? event.amount)}`,
          `需补 ${this.formatAmount(event.billingDeltaAmount ?? 0)}`
        ].join("；"),
        previewDetail: "补差完成或管理员确认前，该用户不能继续开柜或预约。",
        relatedEventId: event.eventId
      });
    }

    if (!settlementAlreadyRecorded.duplicated) {
      this.store.logOperation({
        category: this.getOpenLogCategory(event.role, event.operationType),
        type: "settlement-callback",
        status: "success",
        actor: {
          type: event.role === "admin" ? "admin" : event.role,
          id: event.userId,
          name: this.store.users.find((entry) => entry.id === event.userId)?.name ?? event.phone,
          role: event.role
        },
        primarySubject: {
          type: "device",
          id: event.deviceCode,
          label: event.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: event.orderNo
        },
        description: `订单 ${event.orderNo} 已完成结算。`,
        detail: `设备 ${event.deviceCode} 的结算回调已入库，事件状态更新为 settled。`,
        relatedEventId: event.eventId,
        relatedOrderNo: event.orderNo,
        metadata: {
          amount: event.amount,
          platformAmount: payload.amount,
          billingStatus: event.billingStatus,
          operationType: event.operationType,
          hasInboundGoods: event.hasInboundGoods,
          openReason: event.openReason,
          callbackLogId: callbackLog.id,
          callbackPayload: callbackLog.payload,
          undoState: "not_undoable"
        }
      });
    }

    const shouldAutoForwardFreeSettlement =
      event.role === "special" &&
      event.amount <= 0 &&
      settlementComparison.matched &&
      event.billingDeltaType !== "supplement";
    const freeOnlyPickup = this.isFreeOnlyPickupEvent(event);
    const reservationOnlyPickup = this.isReservationOnlyPickupEvent(event);
    const shouldAutoForwardNoChargeOperationalSettlement =
      this.isNoChargeOperationalOpen(event) &&
      event.amount <= 0;

    if (
      event.paymentNotifyStatus !== "success" &&
      (
        (
          this.shouldAutoForwardSettlementPaymentSuccess() &&
          event.amount <= 0
        ) ||
        shouldAutoForwardFreeSettlement ||
        shouldAutoForwardNoChargeOperationalSettlement
      )
    ) {
      event.paymentNotifyMessage = reservationOnlyPickup
        ? "预约取货已完成核对，系统将回写平台领取完成状态。"
        : shouldAutoForwardNoChargeOperationalSettlement
        ? "运营开门不向用户收费，系统将自动回写平台付款成功。"
        : shouldAutoForwardFreeSettlement
        ? "本次预结算金额为 0，系统将自动回写平台付款成功。"
        : "已收到结算回调，系统将自动回写平台付款成功。";
      void this.tryAutoForwardPaymentSuccess(
        event,
        {
          orderNo: event.orderNo,
          eventId: event.eventId,
          transactionId: this.store.createReference("txn"),
          deviceCode: payload.deviceCode,
          amount: event.amount
        },
        payload.notifyUrl
      );
    } else if (event.paymentNotifyStatus !== "success") {
      event.paymentNotifyStatus = "pending";
      event.paymentNotifyMessage =
        freeOnlyPickup
          ? reservationOnlyPickup
            ? "实际领取与预约不一致，等待管理员核对后回写平台领取完成状态。"
            : "实际领取存在差异，等待管理员核对后回写平台领取完成状态；不会向用户收费。"
          : event.amount > 0
          ? "已收到结算回调，等待用户支付成功后回写平台。"
          : "已收到结算回调，本次无需用户支付。";
    }

    return {
      movements: settlementAlreadyRecorded.movements,
      duplicated: settlementAlreadyRecorded.duplicated,
      paymentNotifyStatus: event.paymentNotifyStatus,
      paymentNotifyMessage: event.paymentNotifyMessage
    };
  }

  handleAdjustment(payload: SmartVmAdjustmentPayload & Record<string, unknown>) {
    this.assertSignature(payload);
    const event = this.getEventByPlatformOrderNo(payload.orgOrderNo);
    this.assertSmartVmCallbackBinding(event, payload);
    this.assertSmartVmCallbackFreshness(payload, event);

    const callbackReplay = this.isSmartVmCallbackReplay("adjustment", payload);

    if (
      callbackReplay &&
      event.adjustments?.some((entry) => entry.orderNo === payload.orderNo)
    ) {
      return {
        code: 200,
        message: "补扣回调已接收",
        duplicated: true
      };
    }

    this.inventoryOrdersService.validateAdjustmentPayload(event, payload);
    event.updatedAt = new Date().toISOString();
    const reservationOnlyPickup = this.isReservationOnlyPickupEvent(event);
    const freeOnlyPickup = this.isFreeOnlyPickupEvent(event);
    const adjustment = this.upsertAdjustment(event, payload);

    const adjustmentRecorded = this.inventoryOrdersService.recordAdjustment(
      event,
      payload,
      freeOnlyPickup
        ? {
            quotaItems: (payload.detail ?? []).map((item) => ({
              goodsId: item.goodsId,
              freeQuantity: item.quantity
            })),
            suppressPaymentFollowup: true
          }
        : undefined
    );
    const callbackLog = this.getOrCreateSmartVmCallbackLog("adjustment", payload, callbackReplay);

    if (!adjustmentRecorded.duplicated) {
      this.store.logOperation({
        category: "inventory",
        type: "adjustment-callback",
        status: freeOnlyPickup || payload.amount > 0 ? "warning" : "success",
        actor: {
          type: "system",
          name: "补扣回调"
        },
        primarySubject: {
          type: "device",
          id: payload.deviceCode,
          label: payload.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: event.orderNo
        },
        description: `订单 ${payload.orderNo} 收到补扣回调。`,
        detail: freeOnlyPickup
          ? reservationOnlyPickup
            ? "预约取货模式不产生补扣；实际物资变化已入账，等待管理员核对。"
            : "当前公益物资不产生补扣；实际物资变化已入账，等待管理员核对。"
          : payload.amount > 0
            ? "补扣订单仍需等待用户支付。"
            : "补扣订单已完成。",
        relatedEventId: event.eventId,
        relatedOrderNo: payload.orderNo,
        metadata: {
          amount: payload.amount,
          orgOrderNo: payload.orgOrderNo,
          callbackLogId: callbackLog.id,
          callbackPayload: callbackLog.payload,
          undoState: "not_undoable"
        }
      });
    }

    if (freeOnlyPickup) {
      event.amount = 0;
      event.billingBaseAmount = 0;
      event.billingActualAmount = 0;
      event.billingDeltaAmount = 0;
      event.billingDeltaType = "none";
      event.billingStatus = "mismatch";
      event.billingResolvedAt = undefined;
      event.billingConfirmedByUserId = undefined;
      event.billingResolutionNote = undefined;

      if (adjustment.paymentNotifyStatus !== "success") {
        adjustment.paymentNotifyStatus = "pending";
        adjustment.paymentNotifyMessage =
          reservationOnlyPickup
            ? "预约取货模式不产生补扣，等待管理员核对后回写平台领取完成状态。"
            : "当前公益物资不产生补扣，等待管理员核对后回写平台领取完成状态。";
        adjustment.updatedAt = new Date().toISOString();
      }

      this.syncLatestAdjustmentFields(event);
      if (!adjustmentRecorded.duplicated) {
        this.alertsService.create({
          type: "callback",
          grade: "feedback",
          title: reservationOnlyPickup ? "预约取货存在实际领取差异" : "公益领取存在实际领取差异",
          deviceCode: payload.deviceCode,
          targetUserId: event.userId,
          dueAt: event.updatedAt,
          detail: `领取事件 ${event.eventId} 收到补扣回调 ${payload.orderNo}；系统未创建支付或补扣单，等待管理员核对。`,
          relatedEventId: event.eventId
        });
      }

      return {
        code: 200,
        message:
          adjustment.paymentNotifyStatus === "success"
            ? "公益领取补充回调已接收，平台完成状态已回写"
            : "公益领取补充回调已接收，等待管理员核对",
        duplicated: adjustmentRecorded.duplicated
      };
    }

    if (adjustment.paymentNotifyStatus === "success") {
      this.syncLatestAdjustmentFields(event);
      return {
        code: 200,
        message: "补扣回调已接收，付款回写已完成",
        duplicated: true
      };
    }

    if (payload.amount > 0) {
      adjustment.paymentNotifyStatus = "pending";
      adjustment.paymentNotifyMessage = `等待补扣订单 ${payload.orderNo} 支付成功后，再向平台回写付款成功。`;
      this.syncLatestAdjustmentFields(event);
      return {
        code: 200,
        message: "补扣回调已接收，等待支付成功后回写平台",
        duplicated: adjustmentRecorded.duplicated
      };
    }

    adjustment.paymentNotifyStatus = "pending";
    adjustment.paymentNotifyMessage = `补扣订单 ${payload.orderNo} 金额为 0，准备自动回写平台。`;
    this.syncLatestAdjustmentFields(event);
    void this.tryAutoForwardPaymentSuccess(event, {
      orderNo: payload.orderNo,
      eventId: event.eventId,
      transactionId: this.store.createReference("txn"),
      deviceCode: payload.deviceCode,
      amount: payload.amount
    }, payload.noticeUrl);

    return {
      code: 200,
      message: "补扣回调已接收",
      duplicated: adjustmentRecorded.duplicated
    };
  }

  private shouldAutoForwardSettlementPaymentSuccess() {
    const raw = this.configService
      .get<string>("SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS")
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return false;
    }

    return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  }

  async handlePaymentSuccess(_payload: SmartVmPaymentPayload & Record<string, unknown>) {
    throw new GoneException(
      "付款成功通知是本系统向柜机平台发送的出站能力；伪入站兼容路由已停用。"
    );
  }

  async notifyPaymentSuccess(
    payload: SmartVmPaymentPayload & {
      openId?: string;
    },
    actorUserId?: string
  ) {
    if (!actorUserId) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const event = this.getEventByPlatformOrderNo(payload.orderNo);
    if (this.isFreeOnlyPickupEvent(event)) {
      throw new BadRequestException(
        "当前公益领取不能手工回写付款成功；请在差异核对完成后由系统回写领取完成状态。"
      );
    }

    return this.forwardPaymentSuccessToPlatform(payload, {
      actor: this.getAdminActor(actorUserId),
      logType: "manual-payment-success",
      requireConfirmedPaymentOrder: true
    });
  }

  async notifyConfirmedPaymentSuccess(
    payload: SmartVmPaymentPayload,
    paymentOrderId: string,
    financialOperationLease?: FinancialOperationLease,
    assertRuntimeSafety?: () => void
  ) {
    if (!paymentOrderId?.trim()) {
      throw new ConflictException("支付服务回写缺少支付单标识，已阻止外呼。");
    }

    if (financialOperationLease) {
      this.financialOperations.assertActiveLease(
        financialOperationLease,
        payload.eventId,
        payload.orderNo
      );
    }

    return this.forwardPaymentSuccessToPlatform(payload, {
      actor: {
        type: "system",
        name: "支付服务"
      },
      logType: "payment-service-payment-success",
      requiredPaymentOrderId: paymentOrderId.trim(),
      assertRuntimeSafety
    }, Boolean(financialOperationLease));
  }

  confirmBillingResolution(
    eventId: string,
    actorUserId?: string,
    payload?: {
      note?: string;
    }
  ) {
    const event = this.store.events.find((entry) => entry.eventId === eventId);

    if (!event) {
      throw new BadRequestException("未找到对应开柜事件。");
    }

    const confirmableBillingStatuses = new Set<CabinetEventRecord["billingStatus"]>([
      "payable",
      "supplement_pending",
      "mismatch",
      "blocked"
    ]);

    if (
      event.status !== "settled" ||
      !event.billingStatus ||
      !confirmableBillingStatuses.has(event.billingStatus)
    ) {
      throw new BadRequestException(
        "只有已结算且存在待处理费用或差异的事件才能由管理员确认。"
      );
    }

    const now = new Date().toISOString();
    event.billingStatus = "admin_confirmed";
    event.billingResolvedAt = now;
    event.billingConfirmedByUserId = actorUserId;
    event.billingResolutionNote = payload?.note;
    event.updatedAt = now;

    if (event.paymentNotifyStatus !== "success") {
      event.paymentNotifyMessage = payload?.note
        ? `管理员已确认本次结算：${payload.note}`
        : "管理员已确认本次结算。";
    }

    if (this.isFreeOnlyPickupEvent(event)) {
      const pendingAdjustment = event.adjustments?.find(
        (entry) => entry.paymentNotifyStatus !== "success"
      );
      const completionOrderNo = pendingAdjustment?.orderNo ?? event.orderNo;
      const completionTargetUrl = pendingAdjustment?.noticeUrl ?? event.paymentNotifyUrl;

      if (pendingAdjustment) {
        pendingAdjustment.paymentNotifyStatus = "pending";
        pendingAdjustment.paymentNotifyMessage = "管理员已完成领取差异核对，准备回写平台领取完成状态。";
        pendingAdjustment.updatedAt = now;
        this.syncLatestAdjustmentFields(event);
      } else {
        event.paymentNotifyStatus = "pending";
        event.paymentNotifyMessage = "管理员已完成领取差异核对，准备回写平台领取完成状态。";
      }

      void this.tryAutoForwardPaymentSuccess(
        event,
        {
          orderNo: completionOrderNo,
          eventId: event.eventId,
          transactionId: this.store.createReference("pickup-completion"),
          deviceCode: event.deviceCode,
          amount: 0
        },
        completionTargetUrl
      );
    }

    this.store.logOperation({
      category: "admin",
      type: "confirm-billing-resolution",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "event",
        id: event.eventId,
        label: event.orderNo
      },
      secondarySubject: {
        type: "user",
        id: event.userId,
        label: this.store.users.find((entry) => entry.id === event.userId)?.name ?? event.phone
      },
      description: `管理员确认了订单 ${event.orderNo} 的结算状态。`,
      detail: payload?.note,
      relatedEventId: event.eventId,
      relatedOrderNo: event.orderNo,
      metadata: {
        billingStatus: event.billingStatus,
        billingDeltaAmount: event.billingDeltaAmount,
        undoState: "not_undoable"
      }
    });

    return event;
  }

  private assertSignature(payload: Record<string, unknown>) {
    if (this.smartVmGateway.verifySignedPayload(payload)) {
      return;
    }

    if (this.isAcceptedLocalMockCallback(payload)) {
      return;
    }

    throw new BadRequestException("签名校验失败。");
  }

  private assertSmartVmCallbackBinding(
    event: CabinetEventRecord,
    payload: { eventId?: unknown; deviceCode?: unknown }
  ) {
    const eventId = this.readPayloadString(payload.eventId);
    const deviceCode = this.readPayloadString(payload.deviceCode);

    if (eventId && eventId !== event.eventId) {
      throw new BadRequestException("回调事件编号与业务订单不一致。");
    }

    if (deviceCode && deviceCode !== event.deviceCode) {
      throw new BadRequestException("回调柜机编号与业务订单不一致。");
    }
  }

  private assertSmartVmCallbackFreshness(
    payload: Record<string, unknown>,
    event: CabinetEventRecord
  ) {
    if (this.isAcceptedLocalMockCallback(payload)) {
      return;
    }

    const rawTimestamp =
      payload.timestamp ??
      payload.timeStamp ??
      payload.callbackTimestamp ??
      payload.callbackTime;
    const futureToleranceSeconds = this.readPositiveIntegerSetting(
      "SMARTVM_CALLBACK_FUTURE_TOLERANCE_SECONDS",
      60
    );

    if (rawTimestamp !== undefined) {
      const occurredAt = this.parseCallbackTimestamp(rawTimestamp);

      if (occurredAt === undefined) {
        throw new BadRequestException("柜机回调时间戳格式无效。");
      }

      const maxAgeSeconds = this.readPositiveIntegerSetting("SMARTVM_CALLBACK_MAX_AGE_SECONDS", 300);
      const ageMilliseconds = Date.now() - occurredAt;

      if (ageMilliseconds > maxAgeSeconds * 1000) {
        throw new BadRequestException("柜机回调已超过允许时效。");
      }

      if (ageMilliseconds < -futureToleranceSeconds * 1000) {
        throw new BadRequestException("柜机回调超出允许的未来时钟偏差。");
      }

      return;
    }

    const eventCreatedAt = Date.parse(event.createdAt);
    const maxEventAgeSeconds = this.readPositiveIntegerSetting(
      "SMARTVM_CALLBACK_EVENT_MAX_AGE_SECONDS",
      7 * 24 * 60 * 60
    );
    const eventAgeMilliseconds = Date.now() - eventCreatedAt;

    if (!Number.isFinite(eventCreatedAt)) {
      throw new BadRequestException("柜机事件创建时间无效，无法校验回调时效。");
    }

    if (eventAgeMilliseconds > maxEventAgeSeconds * 1000) {
      throw new BadRequestException("柜机事件已超过允许的回调处理窗口。");
    }

    if (eventAgeMilliseconds < -futureToleranceSeconds * 1000) {
      throw new BadRequestException("柜机事件时间超出允许的未来时钟偏差。");
    }
  }

  private isSmartVmCallbackReplay(type: string, payload: Record<string, unknown>) {
    const fingerprint = createCallbackReplayFingerprint(type, payload);

    if (fingerprint.nonceFingerprint) {
      const nonceMatch = this.store.callbackLog.find((entry) => {
        return (
          this.getStoredCallbackReplayFingerprint(entry).nonceFingerprint ===
          fingerprint.nonceFingerprint
        );
      });

      if (nonceMatch) {
        if (
          nonceMatch.type !== type ||
          this.getStoredCallbackReplayFingerprint(nonceMatch).payloadFingerprint !==
            fingerprint.payloadFingerprint
        ) {
          throw new BadRequestException("柜机回调 nonce 已被其他请求使用。");
        }

        return true;
      }
    }

    if (!fingerprint.businessKeyFingerprint) {
      return false;
    }

    const businessMatch = this.store.callbackLog.find((entry) => {
      return (
        entry.type === type &&
        this.getStoredCallbackReplayFingerprint(entry).businessKeyFingerprint ===
          fingerprint.businessKeyFingerprint
      );
    });

    if (!businessMatch) {
      return false;
    }

    if (
      this.getStoredCallbackReplayFingerprint(businessMatch).payloadFingerprint !==
        fingerprint.payloadFingerprint
    ) {
      throw new BadRequestException("同一柜机业务回调携带了冲突内容。");
    }

    return true;
  }

  private getOrCreateSmartVmCallbackLog(
    type: string,
    payload: Record<string, unknown>,
    replay: boolean
  ) {
    const fingerprint = createCallbackReplayFingerprint(type, payload);

    if (replay) {
      const existing = this.store.callbackLog.find(
        (entry) =>
          entry.type === type &&
          this.getStoredCallbackReplayFingerprint(entry).payloadFingerprint ===
            fingerprint.payloadFingerprint
      );

      if (existing) {
        return existing;
      }
    }

    return this.store.logCallback(type, payload);
  }

  private serializeCallbackBusinessPayload(payload: unknown) {
    return JSON.stringify(this.normalizeCallbackBusinessPayload(payload));
  }

  private normalizeCallbackBusinessPayload(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizeCallbackBusinessPayload(entry));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const ignoredKeys = new Set([
      "sign",
      "nonceStr",
      "timestamp",
      "timeStamp",
      "callbackTimestamp",
      "callbackTime"
    ]);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !ignoredKeys.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, this.normalizeCallbackBusinessPayload(entry)])
    );
  }

  private parseCallbackTimestamp(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
    }

    if (typeof value !== "string" || !value.trim()) {
      return undefined;
    }

    const normalized = value.trim();

    if (/^\d{10,13}$/.test(normalized)) {
      const numeric = Number(normalized);
      return normalized.length === 13 ? numeric : numeric * 1000;
    }

    const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)
      ? `${normalized.replace(" ", "T")}+08:00`
      : normalized;
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private readPositiveIntegerSetting(key: string, fallback: number) {
    const raw = this.configService.get<string>(key)?.trim();
    const parsed = raw ? Number(raw) : fallback;

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${key} 必须是正整数秒数。`);
    }

    return parsed;
  }

  private resolveDoorCallbackStatus(
    current: CabinetEventStatus,
    callbackStatus: SmartVmDoorStatusPayload["status"]
  ): CabinetEventStatus | undefined {
    const candidates: Record<SmartVmDoorStatusPayload["status"], CabinetEventStatus> = {
      OPENDING: "opening",
      SUCCESS: "opened",
      CLOSED: "closed",
      FAIL: "failed"
    };
    const next = candidates[callbackStatus];
    const allowed: Partial<Record<CabinetEventStatus, CabinetEventStatus[]>> = {
      created: ["opening", "opened", "closed", "failed"],
      opening: ["opening", "opened", "closed", "failed"],
      opened: ["opened", "closed"],
      closed: ["closed"],
      failed: ["failed"]
    };

    return allowed[current]?.includes(next) ? next : undefined;
  }

  private hasRecordedDoorClose(eventId: string) {
    return this.store.callbackLog.some((entry) => {
      return (
        entry.type === "door-status" &&
        entry.payload.eventId === eventId &&
        entry.payload.status === "CLOSED"
      );
    });
  }

  private toCallbackLogView(entry: (typeof this.store.callbackLog)[number]) {
    return {
      id: entry.id,
      type: entry.type,
      receivedAt: entry.receivedAt,
      payload: entry.payload
    };
  }

  private getStoredCallbackReplayFingerprint(entry: (typeof this.store.callbackLog)[number]) {
    return entry.replay ?? createCallbackReplayFingerprint(entry.type, entry.payload);
  }

  private assertSettlementTransition(
    event: CabinetEventRecord,
    payload: SmartVmSettlementPayload
  ) {
    if (event.status === "settled") {
      if (event.platformAmount !== undefined && event.platformAmount !== Math.round(payload.amount)) {
        throw new BadRequestException("已结算事件收到冲突金额，拒绝覆盖。");
      }

      return;
    }

    if (
      !["created", "opening", "opened", "closed", "stuck_open"].includes(event.status)
    ) {
      throw new BadRequestException(`柜机事件当前状态为 ${event.status}，不能再进入已结算状态。`);
    }
  }

  private assertHistoricalSettlementReplayMatches(
    event: CabinetEventRecord,
    payload: SmartVmSettlementPayload
  ) {
    const existingGoods = event.goods
      .map((entry) => ({
        goodsId: entry.goodsId,
        goodsName: entry.goodsName,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice
      }))
      .sort((left, right) => left.goodsId.localeCompare(right.goodsId));
    const incomingGoods = (payload.detail ?? [])
      .map((entry) => ({
        goodsId: entry.goodsId,
        goodsName: entry.goodsName,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice
      }))
      .sort((left, right) => left.goodsId.localeCompare(right.goodsId));

    if (
      this.serializeCallbackBusinessPayload(existingGoods) !==
      this.serializeCallbackBusinessPayload(incomingGoods)
    ) {
      throw new BadRequestException("已结算事件收到冲突商品明细，拒绝覆盖。");
    }
  }

  private isAcceptedLocalMockCallback(payload: Record<string, unknown>) {
    if (isProductionRuntime() || !this.smartVmGateway.isUsingMockTransport()) {
      return false;
    }

    const eventId = this.readPayloadString(payload.eventId);
    const orderNo =
      this.readPayloadString(payload.orderNo) ??
      this.readPayloadString(payload.orgOrderNo);

    const event = this.store.events.find(
      (entry) =>
        (eventId && entry.eventId === eventId) ||
        (orderNo &&
          (entry.orderNo === orderNo ||
            entry.adjustmentOrderNo === orderNo ||
            entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)))
    );

    return Boolean(event?.orderNo.startsWith("mock-"));
  }

  private readPayloadString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private getEventByPlatformOrderNo(orderNo: string) {
    const event = this.store.events.find(
      (entry) =>
        entry.orderNo === orderNo ||
        entry.adjustmentOrderNo === orderNo ||
        entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)
    );

    if (!event) {
      throw new BadRequestException(`订单 ${orderNo} 不存在。`);
    }

    return event;
  }

  private async tryAutoForwardPaymentSuccess(
    event: CabinetEventRecord,
    payload: SmartVmPaymentPayload,
    targetUrl?: string
  ) {
    try {
      const reservationOnlyPickup = this.isReservationOnlyPickupEvent(event);
      const freeOnlyPickup = this.isFreeOnlyPickupEvent(event);
      await this.forwardPaymentSuccessToPlatform(payload, {
        actor: {
          type: "system",
          name: reservationOnlyPickup
            ? "预约取货系统回写"
            : freeOnlyPickup
              ? "公益领取系统回写"
              : "系统回写"
        },
        logType: freeOnlyPickup ? "auto-free-pickup-completion" : "auto-payment-success",
        targetUrl
      });
    } catch (error) {
      const reservationOnlyPickup = this.isReservationOnlyPickupEvent(event);
      const freeOnlyPickup = this.isFreeOnlyPickupEvent(event);
      const completionLabel = reservationOnlyPickup
        ? "预约取货完成状态"
        : freeOnlyPickup
          ? "公益领取完成状态"
          : "付款成功";
      const message = this.smartVmGateway.extractErrorMessage(error);
      const smartVmExchange = this.smartVmGateway.extractExchangeTrace(error);
      const adjustment = this.getAdjustment(event, payload.orderNo);
      if (adjustment) {
        adjustment.paymentNotifyStatus = "failed";
        adjustment.paymentNotifyMessage = message;
        adjustment.updatedAt = new Date().toISOString();
        this.syncLatestAdjustmentFields(event);
      } else {
        event.paymentNotifyStatus = "failed";
        event.paymentNotifyMessage = message;
      }
      event.updatedAt = new Date().toISOString();
      this.alertsService.create({
        type: "callback",
        title: `${completionLabel}回写平台失败`,
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: event.updatedAt,
        detail: `订单 ${event.orderNo} 回写平台${completionLabel}失败：${message}`,
        relatedEventId: event.eventId
      });
      this.store.logOperation({
        category: "inventory",
        type: freeOnlyPickup ? "auto-free-pickup-completion" : "auto-payment-success",
        status: "failed",
        actor: {
          type: "system",
          name: reservationOnlyPickup
            ? "预约取货系统回写"
            : freeOnlyPickup
              ? "公益领取系统回写"
              : "系统回写"
        },
        primarySubject: {
          type: "device",
          id: event.deviceCode,
          label: event.deviceCode
        },
        secondarySubject: {
          type: "event",
          id: event.eventId,
          label: event.orderNo
        },
        description: `订单 ${event.orderNo} 回写平台${completionLabel}失败。`,
        detail: `平台返回：${message}`,
        relatedEventId: event.eventId,
        relatedOrderNo: event.orderNo,
        metadata: {
          amount: payload.amount,
          transactionId: payload.transactionId,
          smartVmExchange,
          undoState: "not_undoable"
        }
      });
    }
  }

  private async forwardPaymentSuccessToPlatform(
    payload: SmartVmPaymentPayload & { openId?: string },
    options: {
      actor: {
        type: "admin" | "merchant" | "special" | "system";
        id?: string;
        name: string;
        role?: "admin" | "merchant" | "special";
      };
      logType: string;
      targetUrl?: string;
      callbackLogId?: string;
      callbackPayload?: unknown;
      requireConfirmedPaymentOrder?: boolean;
      requiredPaymentOrderId?: string;
      assertRuntimeSafety?: () => void;
    },
    coordinationLockAcquired = false
  ): Promise<{
    orderNo: string;
    forwarded: boolean;
    transactionId: string;
    targetUrl: string;
    duplicated?: boolean;
  }> {
    const event = this.getEventByPlatformOrderNo(payload.orderNo);
    this.assertSmartVmCallbackBinding(event, payload);
    if (!coordinationLockAcquired) {
      return this.withPaymentNotifyLock(event.eventId, payload.orderNo, () =>
        this.forwardPaymentSuccessToPlatform(payload, options, true)
      );
    }
    options.assertRuntimeSafety?.();
    const adjustment = this.getAdjustment(event, payload.orderNo);
    const isAdjustmentOrder = Boolean(adjustment);
    const reservationOnlyPickup = this.isReservationOnlyPickupEvent(event);
    const freeOnlyPickup = this.isFreeOnlyPickupEvent(event);
    const expectedAmount = freeOnlyPickup
      ? 0
      : Math.round(adjustment?.amount ?? event.amount);

    if (!Number.isSafeInteger(payload.amount) || payload.amount < 0) {
      throw new BadRequestException("付款成功金额必须是非负整数分值。");
    }

    if (payload.amount !== expectedAmount) {
      throw new BadRequestException("付款成功金额与服务端业务金额不一致。");
    }

    if (!payload.transactionId?.trim()) {
      throw new BadRequestException("付款成功回写缺少交易号。");
    }

    const resolvedTargetUrl =
      options.targetUrl ??
      adjustment?.noticeUrl ??
      event.adjustmentNoticeUrl ??
      event.paymentNotifyUrl;

    if (!resolvedTargetUrl) {
      throw new BadRequestException(
        `订单 ${payload.orderNo} 缺少平台付款成功通知地址，请先接收结算或补扣回调中的 notifyUrl / noticeUrl。`
      );
    }

    const currentNotifyStatus = adjustment?.paymentNotifyStatus ?? event.paymentNotifyStatus;
    const currentTransactionId = adjustment?.paymentTransactionId ?? event.paymentTransactionId;

    if (currentNotifyStatus === "success") {
      if (currentTransactionId && currentTransactionId !== payload.transactionId) {
        throw new BadRequestException("业务订单已由其他交易号完成付款回写，拒绝覆盖。");
      }

      return {
        orderNo: payload.orderNo,
        forwarded: true,
        transactionId: currentTransactionId ?? payload.transactionId,
        targetUrl: resolvedTargetUrl,
        duplicated: true
      };
    }

    const activePaymentOrders = this.store.paymentOrders.filter(
      (entry) =>
        entry.eventId === event.eventId &&
        (entry.adjustmentOrderNo ?? entry.orderNo) === payload.orderNo &&
        entry.status !== "failed" &&
        entry.status !== "closed"
    );
    const conflictingPaymentOrder = activePaymentOrders.find(
      (entry) =>
        entry.providerTransactionId &&
        entry.providerTransactionId !== payload.transactionId
    );
    if (conflictingPaymentOrder) {
      const conflictLog = this.store.logOperation({
        category: "inventory",
        type: "manual-payment-success-identity-conflict",
        status: "warning",
        actor: options.actor,
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: payload.orderNo
        },
        relatedEventId: event.eventId,
        relatedOrderNo: payload.orderNo,
        description: "手工付款回写交易号与支付退款账本不一致，已阻止外呼。",
        detail: "请核对支付渠道账单和现有支付单，不要用新的交易号重复回写。",
        metadata: {
          paymentOrderId: conflictingPaymentOrder.id,
          paymentNo: conflictingPaymentOrder.paymentNo,
          paymentOrderTransactionId: conflictingPaymentOrder.providerTransactionId,
          requestedTransactionId: payload.transactionId,
          undoState: "not_undoable"
        }
      });
      this.alertsService.create({
        type: "callback",
        grade: "fault",
        title: "付款回写交易号冲突",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: new Date().toISOString(),
        detail: `订单 ${payload.orderNo} 的手工回写交易号与支付单不一致，系统已阻止外呼，请核对渠道账单。`,
        relatedEventId: event.eventId,
        sourceLogId: conflictLog.id
      });
      throw new ConflictException("付款交易号与现有支付单不一致，已阻止外呼并生成核对告警。");
    }

    const coordinatedPaymentOrder = activePaymentOrders.find(
      (entry) =>
        entry.status === "paid" &&
        entry.providerTransactionId === payload.transactionId
    );
    const coordinatedPayment = options.requiredPaymentOrderId
      ? coordinatedPaymentOrder?.id === options.requiredPaymentOrderId
      : Boolean(coordinatedPaymentOrder);
    if (
      (options.requireConfirmedPaymentOrder || options.requiredPaymentOrderId) &&
      !coordinatedPayment
    ) {
      const blockedLog = this.store.logOperation({
        category: "inventory",
        type:
          options.logType === "manual-payment-success"
            ? "manual-payment-success-without-payment-order"
            : "payment-service-payment-success-binding-conflict",
        status: "warning",
        actor: options.actor,
        primarySubject: {
          type: "event",
          id: event.eventId,
          label: payload.orderNo
        },
        relatedEventId: event.eventId,
        relatedOrderNo: payload.orderNo,
        description: "付款回写没有匹配到指定的已支付支付单，系统已阻止。",
        detail: "付款成功必须来自已验签的支付回调和统一支付账本，且支付单、交易号、业务订单必须精确一致。",
        metadata: {
          paymentOrderId: options.requiredPaymentOrderId,
          transactionId: payload.transactionId,
          amount: payload.amount,
          actorUserId: options.actor.id,
          undoState: "not_undoable"
        }
      });
      this.alertsService.create({
        type: "callback",
        grade: "fault",
        title: "支付单绑定失败的付款回写已阻止",
        deviceCode: event.deviceCode,
        targetUserId: event.userId,
        dueAt: new Date().toISOString(),
        detail: `订单 ${payload.orderNo} 没有与指定支付单及交易号精确匹配的已支付记录，系统已阻止外呼，请核对渠道账单。`,
        relatedEventId: event.eventId,
        sourceLogId: blockedLog.id
      });
      throw new ConflictException(
        "未找到与指定支付单及交易号匹配的已支付记录，不能回写付款成功。"
      );
    }

    const transactionConflict = this.store.events.some((entry) => {
      if (entry.eventId === event.eventId) {
        const otherAdjustmentConflict = entry.adjustments?.some(
          (candidate) =>
            candidate.orderNo !== payload.orderNo &&
            candidate.paymentTransactionId === payload.transactionId
        );
        const baseOrderConflict =
          payload.orderNo !== entry.orderNo &&
          entry.paymentTransactionId === payload.transactionId;
        return Boolean(otherAdjustmentConflict || baseOrderConflict);
      }

      return (
        entry.paymentTransactionId === payload.transactionId ||
        entry.adjustments?.some(
          (candidate) => candidate.paymentTransactionId === payload.transactionId
        ) === true
      );
    });

    if (transactionConflict) {
      throw new BadRequestException("付款交易号已绑定到其他业务订单。");
    }

    options.assertRuntimeSafety?.();
    const smartVmResult = await this.smartVmGateway.notifyPaymentSuccess(payload, {
      targetUrl: resolvedTargetUrl
    });
    options.assertRuntimeSafety?.();
    event.updatedAt = new Date().toISOString();

    if (adjustment) {
      adjustment.paymentNotifyStatus = "success";
      adjustment.paymentNotifyMessage = freeOnlyPickup
        ? resolvedTargetUrl
          ? `已回写平台${reservationOnlyPickup ? "预约取货" : "公益领取"}完成状态，补充订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
          : `已回写平台${reservationOnlyPickup ? "预约取货" : "公益领取"}完成状态，补充订单 ${payload.orderNo}。`
        : resolvedTargetUrl
          ? `已回写平台付款成功，补扣订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
          : `已回写平台付款成功，补扣订单 ${payload.orderNo}。`;
      adjustment.paymentNotifiedAt = event.updatedAt;
      adjustment.paymentTransactionId = payload.transactionId;
      adjustment.updatedAt = event.updatedAt;
      if (
        !freeOnlyPickup &&
        (event.billingStatus === "supplement_pending" || event.billingStatus === "mismatch")
      ) {
        event.billingStatus = "paid";
        event.billingResolvedAt = event.updatedAt;
      }
      this.syncLatestAdjustmentFields(event);
    } else {
      event.paymentNotifyStatus = "success";
      event.paymentNotifyMessage = freeOnlyPickup
        ? resolvedTargetUrl
          ? `已回写平台${reservationOnlyPickup ? "预约取货" : "公益领取"}完成状态，订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
          : `已回写平台${reservationOnlyPickup ? "预约取货" : "公益领取"}完成状态，订单 ${payload.orderNo}。`
        : resolvedTargetUrl
          ? `已回写平台付款成功，订单 ${payload.orderNo}，目标地址 ${resolvedTargetUrl}`
          : `已回写平台付款成功，订单 ${payload.orderNo}。`;
      event.paymentNotifiedAt = event.updatedAt;
      event.paymentTransactionId = payload.transactionId;
      if (!freeOnlyPickup && event.role === "special" && event.amount > 0) {
        event.billingStatus = "paid";
        event.billingResolvedAt = event.updatedAt;
      }
    }

    this.store.logOperation({
      category: "inventory",
      type: options.logType,
      status: "success",
      actor: options.actor,
      primarySubject: {
        type: "device",
        id: payload.deviceCode,
        label: payload.deviceCode
      },
      secondarySubject: {
        type: "event",
        id: event.eventId,
        label: event.orderNo
      },
      description: freeOnlyPickup
        ? `订单 ${payload.orderNo}${isAdjustmentOrder ? "（补充订单）" : ""} 已回写平台${reservationOnlyPickup ? "预约取货" : "公益领取"}完成状态。`
        : `订单 ${payload.orderNo}${isAdjustmentOrder ? "（补扣单）" : ""} 已回写平台付款成功。`,
      detail: `交易号 ${payload.transactionId}，金额 ${payload.amount}${resolvedTargetUrl ? `，目标 ${resolvedTargetUrl}` : ""}。`,
      relatedEventId: event.eventId,
      relatedOrderNo: payload.orderNo,
      metadata: {
        transactionId: payload.transactionId,
        amount: payload.amount,
        targetUrl: resolvedTargetUrl,
        paymentOrderId: options.requiredPaymentOrderId ?? coordinatedPaymentOrder?.id,
        callbackLogId: options.callbackLogId,
        callbackPayload: options.callbackPayload,
        smartVmExchange: smartVmResult.smartVmExchange,
        undoState: "not_undoable"
      }
    });
    return {
      orderNo: payload.orderNo,
      forwarded: true,
      transactionId: payload.transactionId,
      targetUrl: resolvedTargetUrl
    };
  }

  private async withPaymentNotifyLock<T>(
    eventId: string,
    businessOrderNo: string,
    action: () => Promise<T>
  ): Promise<T> {
    return this.financialOperations.run(eventId, businessOrderNo.trim(), action);
  }

  private upsertAdjustment(event: CabinetEventRecord, payload: SmartVmAdjustmentPayload) {
    event.adjustments ??= [];
    const now = new Date().toISOString();
    let adjustment = event.adjustments.find((entry) => entry.orderNo === payload.orderNo);

    if (!adjustment) {
      adjustment = {
        orderNo: payload.orderNo,
        sourceOrderNo: payload.orgOrderNo,
        noticeUrl: payload.noticeUrl,
        amount: payload.amount,
        createdAt: now,
        updatedAt: now,
        goods:
          payload.detail?.map((item) => ({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: item.quantity,
            unitPrice: item.unitPrice
          })) ?? []
      };
      event.adjustments.unshift(adjustment);
    } else {
      const incomingGoods =
        payload.detail?.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        })) ?? [];
      const existingBusinessPayload = {
        sourceOrderNo: adjustment.sourceOrderNo,
        noticeUrl: adjustment.noticeUrl,
        amount: adjustment.amount,
        goods: adjustment.goods ?? []
      };
      const incomingBusinessPayload = {
        sourceOrderNo: payload.orgOrderNo,
        noticeUrl: payload.noticeUrl,
        amount: payload.amount,
        goods: incomingGoods
      };

      if (
        this.serializeCallbackBusinessPayload(existingBusinessPayload) !==
        this.serializeCallbackBusinessPayload(incomingBusinessPayload)
      ) {
        throw new BadRequestException("补扣订单已存在且回调内容冲突，拒绝覆盖。");
      }
    }

    this.syncLatestAdjustmentFields(event);
    return adjustment;
  }

  private getAdjustment(event: CabinetEventRecord, orderNo: string) {
    return event.adjustments?.find((entry) => entry.orderNo === orderNo);
  }

  private syncLatestAdjustmentFields(event: CabinetEventRecord) {
    const latest = event.adjustments?.[0];

    event.adjustmentOrderNo = latest?.orderNo;
    event.adjustmentNoticeUrl = latest?.noticeUrl;
    event.adjustmentAmount = latest?.amount;
    event.adjustmentPaymentNotifyStatus = latest?.paymentNotifyStatus;
    event.adjustmentPaymentNotifyMessage = latest?.paymentNotifyMessage;
    event.adjustmentPaymentNotifiedAt = latest?.paymentNotifiedAt;
    event.adjustmentPaymentTransactionId = latest?.paymentTransactionId;
    event.adjustmentRefundNo = latest?.refundNo;
    event.adjustmentRefundTransactionId = latest?.refundTransactionId;
    event.adjustmentRefundedAt = latest?.refundedAt;
  }

  private getAdminActor(actorUserId?: string) {
    if (!actorUserId) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const adminUser = this.store.users.find((entry) => entry.id === actorUserId);

    return {
      type: "admin" as const,
      id: actorUserId,
      name: adminUser?.name ?? "管理员",
      role: "admin" as const
    };
  }

  private resolveOpenIdentity(
    payload: CabinetOpenRequest,
    actor?: AuthActor
  ): { user: UserRecord; doorNum: string } {
    if (!actor) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const user = this.store.users.find(
      (entry) => entry.id === actor.id && entry.status === "active"
    );

    if (!user) {
      throw new UnauthorizedException("当前用户未登记或已停用，无法开柜。");
    }

    const device = this.store.devices.find(
      (entry) => entry.deviceCode === payload.deviceCode
    );

    if (
      actor.tenantId &&
      (!device ||
        this.store.getDeviceTenantId(device) !== actor.tenantId ||
        this.store.getUserTenantId(user) !== actor.tenantId)
    ) {
      throw new ForbiddenException("当前账号无权操作其他实例的柜机。");
    }

    if (payload.phone && payload.phone !== user.phone) {
      throw new ForbiddenException("不能使用其他手机号发起开柜。");
    }

    if (user.role === "merchant" || user.role === "restocker") {
      const assignedDeviceCodes =
        user.assignedDeviceCodes ?? user.merchantProfile?.defaultDeviceCodes ?? [];

      if (!assignedDeviceCodes.includes(payload.deviceCode)) {
        throw new ForbiddenException("当前账号未被分配该柜机。");
      }
    }

    const doorNum = String(payload.doorNum ?? "1").trim();

    if (!doorNum) {
      throw new BadRequestException("开柜柜门编号不能为空。");
    }

    return {
      user,
      doorNum
    };
  }

  private prepareOpenContext(
    payload: CabinetOpenRequest,
    actor?: AuthActor,
    identity = this.resolveOpenIdentity(payload, actor)
  ) {
    const { user, doorNum } = identity;

    this.deviceOperations.assertOpenable({
      deviceCode: payload.deviceCode,
      doorNum
    });

    this.reservationsService.assertUserCanUseRelatedFeatures(user.id);
    this.reservationsService.expireOverdueReservations();

    if (this.isReservationOnlyPickup() && user.role === "special" && !payload.reservationId?.trim()) {
      throw new BadRequestException("当前仅支持预约取货，请先预约后再开柜。");
    }

    const reservation = payload.reservationId
      ? this.reservationsService.getReservationForOpen(
          user.id,
          payload.reservationId,
          payload.deviceCode,
          doorNum
        )
      : undefined;
    const operationContext = this.resolveOpenOperation(payload, user.role);
    const intentItems = this.resolveIntentItems(
      payload.deviceCode,
      doorNum,
      user.role === "special" ? reservation?.items ?? payload.intentItems ?? [] : [],
      payload.category ?? "daily",
      reservation?.id
    );
    const quotaSummary =
      user.role === "special"
        ? this.accessRulesService.assertCanOpenSpecialCabinet(user)
        : undefined;

    if (user.role === "special" && !intentItems.length) {
      throw new BadRequestException("正式开柜前请先选择本次计划领取的商品。");
    }

    const preSettlement =
      user.role === "special" && quotaSummary
        ? this.buildPreSettlement(payload.deviceCode, doorNum, intentItems, quotaSummary)
        : undefined;

    if (user.role === "special" && preSettlement?.chargeRequired) {
      throw new BadRequestException(
        this.isReservationOnlyPickup()
          ? "预约物资已超出当前可领取额度，不能进入支付流程。"
          : "所选物资已超出当前可领取范围。当前公益物资只支持免费领取，不能进入支付流程。"
      );
    }

    return {
      user,
      doorNum,
      quotaSummary,
      intentItems,
      preSettlement,
      reservation,
      ...operationContext
    };
  }

  private findOpenQuoteReplay(
    payload: CabinetOpenRequest,
    userId: string,
    doorNum: string
  ) {
    const quoteId = payload.quoteId?.trim();
    if (!quoteId) {
      return undefined;
    }

    const openQuoteHash = this.openQuotes.hashQuoteId(quoteId);
    return this.store.events.find(
      (event) =>
        event.openQuoteHash === openQuoteHash &&
        event.userId === userId &&
        event.deviceCode === payload.deviceCode &&
        event.doorNum === doorNum
    );
  }

  private buildOpenQuoteReplayResult(event: CabinetEventRecord): CabinetOpenResult {
    return {
      orderNo: event.orderNo,
      eventId: event.eventId,
      deviceCode: event.deviceCode,
      doorNum: event.doorNum,
      reservationId: event.reservationId,
      role: event.role,
      openMode: event.openMode,
      operationType: event.operationType,
      hasInboundGoods: event.hasInboundGoods,
      openReason: event.openReason,
      acceptedIntentItems: event.intentItems?.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity
      })),
      preSettlement: event.preSettlement
    };
  }

  private resolveOpenOperation(
    payload: CabinetOpenRequest,
    role: CabinetEventRecord["role"]
  ): {
    operationType: CabinetOpenPurpose;
    hasInboundGoods?: boolean;
    openReason?: string;
  } {
    if (role === "special") {
      return {
        operationType: "pickup"
      };
    }

    if (typeof payload.hasInboundGoods !== "boolean") {
      throw new BadRequestException("请选择本次开门是否有商品入柜。");
    }

    const openReason = payload.openReason?.trim();

    if (!payload.hasInboundGoods && !openReason) {
      throw new BadRequestException("无商品入柜开门必须填写开门理由。");
    }

    return {
      operationType: payload.hasInboundGoods ? "restock" : "service",
      hasInboundGoods: payload.hasInboundGoods,
      openReason: openReason || (payload.hasInboundGoods ? "补货入柜" : undefined)
    };
  }

  private isNoChargeOperationalOpen(
    event: Pick<CabinetEventRecord, "role"> & {
      hasInboundGoods?: CabinetEventRecord["hasInboundGoods"];
    }
  ) {
    return event.role !== "special" && typeof event.hasInboundGoods === "boolean";
  }

  private isReservationOnlyPickup() {
    return isReservationOnlyPickup({
      VM_RESERVATION_ONLY_PICKUP: this.configService.get<string>("VM_RESERVATION_ONLY_PICKUP")
    });
  }

  private isReservationOnlyPickupEvent(event: Pick<CabinetEventRecord, "reservationOnlyPickup">) {
    return event.reservationOnlyPickup === true;
  }

  private isFreeOnlyPickupEvent(
    event: Pick<CabinetEventRecord, "role" | "reservationOnlyPickup" | "preSettlement">
  ) {
    return (
      event.role === "special" &&
      (
        this.isReservationOnlyPickupEvent(event) ||
        event.preSettlement?.chargeRequired === false
      )
    );
  }

  private getOpenLogCategory(
    role: CabinetEventRecord["role"],
    operationType?: CabinetOpenPurpose
  ): OperationLogCategory {
    if (operationType === "restock") {
      return "restock";
    }

    if (role === "admin" || operationType === "service") {
      return "device";
    }

    return "pickup";
  }

  private resolveIntentItems(
    deviceCode: string,
    doorNum: string,
    intentItems: NonNullable<CabinetOpenRequest["intentItems"]>,
    fallbackCategory: CabinetOpenRequest["category"] = "daily",
    ignoredReservationId?: string
  ): CabinetIntentItem[] {
    this.store.syncDeviceStocksFromBatches(deviceCode);
    const device = this.store.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      throw new BadRequestException("未找到对应柜机。");
    }

    const door = device.doors.find((entry) => entry.doorNum === doorNum);

    if (!door) {
      throw new BadRequestException("未找到对应柜门。");
    }

    const resolved = new Map<string, CabinetIntentItem>();

    for (const item of intentItems) {
      const goodsId = String(item.goodsId ?? "").trim();
      const quantity = Number(item.quantity);

      if (!goodsId) {
        throw new BadRequestException("选择商品编号不能为空。");
      }

      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
        throw new BadRequestException("选择商品数量必须是正整数。");
      }

      const deviceGoods = door.goods.find((goods) => goods.goodsId === goodsId);

      if (!deviceGoods) {
        throw new BadRequestException(`货品 ${goodsId} 不属于柜门 ${doorNum}，不能开柜领取。`);
      }

      const catalogGoods = this.store.goodsCatalog.find((goods) => goods.goodsId === goodsId);
      const existing = resolved.get(goodsId);
      // 名称和品类必须以后端柜门/目录为准，避免客户端改写品类绕过额度。
      const goodsName = deviceGoods.name || catalogGoods?.name || goodsId;
      const category = deviceGoods.category || catalogGoods?.category || fallbackCategory;
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      const reservedQuantity = this.store.reservations
        .filter(
          (reservation) =>
            reservation.status === "active" &&
            reservation.deviceCode === deviceCode &&
            reservation.id !== ignoredReservationId
        )
        .flatMap((reservation) => reservation.items)
        .filter((reservedItem) => reservedItem.goodsId === goodsId)
        .reduce((sum, reservedItem) => sum + reservedItem.quantity, 0);
      const stock = Math.max(0, this.store.getAvailableStock(deviceCode, goodsId) - reservedQuantity);

      if (stock < nextQuantity) {
        throw new BadRequestException(`${goodsName} 当前库存不足，最多可选择 ${Math.max(0, stock)} 件。`);
      }

      resolved.set(goodsId, {
        goodsId,
        goodsName,
        category,
        quantity: nextQuantity
      });
    }

    return Array.from(resolved.values());
  }

  private buildPreSettlement(
    deviceCode: string,
    doorNum: string,
    intentItems: CabinetIntentItem[],
    quotaSummary: ReturnType<AccessRulesService["getQuotaSummaryForUser"]>
  ): CabinetPreSettlement {
    const remainingByGoods = new Map(
      Object.entries((quotaSummary.remainingByGoods as Record<string, number> | undefined) ?? {})
    );
    const remainingByCategory = new Map(
      Object.entries((quotaSummary.remainingToday as Record<string, number> | undefined) ?? {})
    );
    const useGoodsQuota = remainingByGoods.size > 0;
    let remainingDaily = Math.max(0, quotaSummary.remainingDaily ?? 0);
    const items = intentItems.map((item) => {
      const goods = this.getGoodsSnapshot(deviceCode, item.goodsId);
      const goodsRemaining = remainingByGoods.get(item.goodsId);
      const categoryRemaining = useGoodsQuota ? undefined : remainingByCategory.get(item.category);
      const freeQuantity = Math.min(
        item.quantity,
        Math.max(0, goodsRemaining ?? categoryRemaining ?? 0),
        remainingDaily
      );
      const paidQuantity = Math.max(0, item.quantity - freeQuantity);
      const unitPrice = goods.unitPrice;
      remainingDaily = Math.max(0, remainingDaily - freeQuantity);

      if (useGoodsQuota && goodsRemaining !== undefined) {
        remainingByGoods.set(item.goodsId, Math.max(0, goodsRemaining - freeQuantity));
      } else if (!useGoodsQuota && categoryRemaining !== undefined) {
        remainingByCategory.set(item.category, Math.max(0, categoryRemaining - freeQuantity));
      }

      return {
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: item.category,
        quantity: item.quantity,
        freeQuantity,
        paidQuantity,
        unitPrice,
        originalAmount: unitPrice * item.quantity,
        freeAmount: unitPrice * freeQuantity,
        paidAmount: unitPrice * paidQuantity
      };
    });
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const freeQuantity = items.reduce((sum, item) => sum + item.freeQuantity, 0);
    const paidQuantity = items.reduce((sum, item) => sum + item.paidQuantity, 0);
    const originalAmount = items.reduce((sum, item) => sum + item.originalAmount, 0);
    const freeAmount = items.reduce((sum, item) => sum + item.freeAmount, 0);
    const payableAmount = items.reduce((sum, item) => sum + item.paidAmount, 0);
    const chargeRequired = payableAmount > 0;

    return {
      deviceCode,
      doorNum,
      createdAt: new Date().toISOString(),
      totalQuantity,
      freeQuantity,
      paidQuantity,
      originalAmount,
      freeAmount,
      payableAmount,
      chargeRequired,
      summary: chargeRequired
        ? `本次预计免费 ${freeQuantity} 件，超出范围 ${paidQuantity} 件，需支付 ${this.formatAmount(payableAmount)}。`
        : `本次选择的 ${totalQuantity} 件均在可领取范围内，预计免费。`,
      items
    };
  }

  private getGoodsSnapshot(deviceCode: string, goodsId: string) {
    const deviceGoods = this.store.devices
      .find((device) => device.deviceCode === deviceCode)
      ?.doors.flatMap((door) => door.goods)
      .find((goods) => goods.goodsId === goodsId);
    const catalogGoods = this.store.goodsCatalog.find((goods) => goods.goodsId === goodsId);

    return {
      unitPrice: Math.max(0, Math.round(deviceGoods?.price ?? catalogGoods?.price ?? 0))
    };
  }

  private hasSettlementRecord(orderNo: string) {
    return this.store.inventory.some(
      (entry) =>
        entry.orderNo === orderNo &&
        (entry.type === "pickup" || entry.type === "donation")
    );
  }

  private buildCallbackBilling(
    event: CabinetEventRecord,
    payload: SmartVmSettlementPayload
  ): CallbackBilling {
    const platformAmount = Math.max(0, Math.round(payload.amount));
    const quotedUnitPriceByGoods = new Map(
      (event.preSettlement?.items ?? []).map((item) => [item.goodsId, item.unitPrice])
    );
    const lines =
      payload.detail?.map((item) => {
        const platformUnitPrice = Math.max(0, Math.round(Number(item.unitPrice)));
        const unitPrice =
          event.role === "special"
            ? (quotedUnitPriceByGoods.get(item.goodsId) ??
              this.getGoodsSnapshot(event.deviceCode, item.goodsId).unitPrice)
            : platformUnitPrice;

        return {
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: this.getGoodsCategory(event.deviceCode, item.goodsId),
          quantity: Math.max(0, Math.floor(Number(item.quantity))),
          unitPrice
        };
      }) ?? [];

    if (this.isFreeOnlyPickupEvent(event)) {
      const totalQuantity = lines.reduce((sum, item) => sum + item.quantity, 0);
      const originalAmount = lines.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

      return {
        platformAmount,
        totalQuantity,
        freeQuantity: totalQuantity,
        paidQuantity: 0,
        originalAmount: originalAmount || platformAmount,
        freeAmount: originalAmount || platformAmount,
        payableAmount: 0,
        items: lines.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: item.category,
          quantity: item.quantity,
          freeQuantity: item.quantity,
          paidQuantity: 0,
          unitPrice: item.unitPrice,
          originalAmount: item.quantity * item.unitPrice,
          freeAmount: item.quantity * item.unitPrice,
          paidAmount: 0
        }))
      };
    }

    if (this.isNoChargeOperationalOpen(event)) {
      const totalQuantity = lines.reduce((sum, item) => sum + item.quantity, 0);
      const originalAmount = lines.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

      return {
        platformAmount,
        totalQuantity,
        freeQuantity: totalQuantity,
        paidQuantity: 0,
        originalAmount: originalAmount || platformAmount,
        freeAmount: originalAmount || platformAmount,
        payableAmount: 0,
        items: lines.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: item.category,
          quantity: item.quantity,
          freeQuantity: item.quantity,
          paidQuantity: 0,
          unitPrice: item.unitPrice,
          originalAmount: item.quantity * item.unitPrice,
          freeAmount: item.quantity * item.unitPrice,
          paidAmount: 0
        }))
      };
    }

    if (!lines.length || event.role !== "special") {
      const totalQuantity = lines.reduce((sum, item) => sum + item.quantity, 0);
      const originalAmount = lines.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

      return {
        platformAmount,
        totalQuantity,
        freeQuantity: 0,
        paidQuantity: totalQuantity,
        originalAmount: originalAmount || platformAmount,
        freeAmount: 0,
        payableAmount: platformAmount,
        items: lines.map((item) => ({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          category: item.category,
          quantity: item.quantity,
          freeQuantity: 0,
          paidQuantity: item.quantity,
          unitPrice: item.unitPrice,
          originalAmount: item.quantity * item.unitPrice,
          freeAmount: 0,
          paidAmount: item.quantity * item.unitPrice
        }))
      };
    }

    const user = this.store.users.find((entry) => entry.id === event.userId);
    const quotaSummary = user ? this.accessRulesService.getQuotaSummaryForUser(user) : undefined;
    const remainingByGoods = new Map(
      Object.entries((quotaSummary?.remainingByGoods as Record<string, number> | undefined) ?? {})
    );
    const remainingByCategory = new Map(
      Object.entries((quotaSummary?.remainingToday as Record<string, number> | undefined) ?? {})
    );
    const useGoodsQuota = remainingByGoods.size > 0;
    let remainingDaily = Math.max(0, quotaSummary?.remainingDaily ?? 0);
    const items = lines.map((item) => {
      const goodsRemaining = remainingByGoods.get(item.goodsId);
      const categoryRemaining = useGoodsQuota ? undefined : remainingByCategory.get(item.category);
      const freeQuantity = Math.min(
        item.quantity,
        Math.max(0, goodsRemaining ?? categoryRemaining ?? 0),
        remainingDaily
      );
      const paidQuantity = Math.max(0, item.quantity - freeQuantity);
      remainingDaily = Math.max(0, remainingDaily - freeQuantity);

      if (useGoodsQuota && goodsRemaining !== undefined) {
        remainingByGoods.set(item.goodsId, Math.max(0, goodsRemaining - freeQuantity));
      } else if (!useGoodsQuota && categoryRemaining !== undefined) {
        remainingByCategory.set(item.category, Math.max(0, categoryRemaining - freeQuantity));
      }

      return {
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: item.category,
        quantity: item.quantity,
        freeQuantity,
        paidQuantity,
        unitPrice: item.unitPrice,
        originalAmount: item.unitPrice * item.quantity,
        freeAmount: item.unitPrice * freeQuantity,
        paidAmount: item.unitPrice * paidQuantity
      };
    });

    return {
      platformAmount,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      freeQuantity: items.reduce((sum, item) => sum + item.freeQuantity, 0),
      paidQuantity: items.reduce((sum, item) => sum + item.paidQuantity, 0),
      originalAmount: items.reduce((sum, item) => sum + item.originalAmount, 0),
      freeAmount: items.reduce((sum, item) => sum + item.freeAmount, 0),
      payableAmount: items.reduce((sum, item) => sum + item.paidAmount, 0),
      items
    };
  }

  private applyCallbackBilling(
    event: CabinetEventRecord,
    billing: CallbackBilling,
    settlementComparison: CabinetSettlementComparison
  ) {
    const expectedAmount = event.preSettlement?.payableAmount ?? 0;
    const actualAmount = billing.payableAmount;
    const deltaAmount = actualAmount - expectedAmount;

    event.amount = actualAmount;
    event.billingBaseAmount = expectedAmount;
    event.billingActualAmount = actualAmount;
    event.billingDeltaAmount = deltaAmount;
    event.billingDeltaType =
      deltaAmount > 0 ? "supplement" : deltaAmount < 0 ? "refund" : "none";

    if (this.isFreeOnlyPickupEvent(event)) {
      event.amount = 0;
      event.billingBaseAmount = 0;
      event.billingActualAmount = 0;
      event.billingDeltaAmount = 0;
      event.billingDeltaType = "none";
      event.billingStatus = settlementComparison.matched ? "free" : "mismatch";
      return;
    }

    if (this.isNoChargeOperationalOpen(event)) {
      event.billingStatus = "free";
      event.billingDeltaAmount = 0;
      event.billingDeltaType = "none";
      return;
    }

    if (event.role !== "special") {
      return;
    }

    if (actualAmount <= 0) {
      event.billingStatus = "free";
      return;
    }

    if (deltaAmount > 0) {
      event.billingStatus = "supplement_pending";
      return;
    }

    event.billingStatus = settlementComparison.matched ? "payable" : "mismatch";
  }

  private getGoodsCategory(deviceCode: string, goodsId: string, fallback: GoodsCategory = "daily") {
    return (
      this.store.devices
        .find((device) => device.deviceCode === deviceCode)
        ?.doors.flatMap((door) => door.goods)
        .find((goods) => goods.goodsId === goodsId)?.category ??
      this.store.goodsCatalog.find((goods) => goods.goodsId === goodsId)?.category ??
      fallback
    );
  }

  private formatAmount(amount: number) {
    return `￥${(amount / 100).toFixed(2)}`;
  }

  private compareSettlement(event: CabinetEventRecord, payload: SmartVmSettlementPayload) {
    const quotedItemByGoods = new Map(
      (event.preSettlement?.items ?? []).map((item) => [item.goodsId, item])
    );
    const intendedItems = (event.intentItems ?? []).map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      quantity: item.quantity,
      unitPrice:
        quotedItemByGoods.get(item.goodsId)?.unitPrice ??
        this.getGoodsSnapshot(event.deviceCode, item.goodsId).unitPrice,
      amount:
        (quotedItemByGoods.get(item.goodsId)?.unitPrice ??
          this.getGoodsSnapshot(event.deviceCode, item.goodsId).unitPrice) * item.quantity
    }));
    const settledItems =
      payload.detail?.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.unitPrice * item.quantity
      })) ?? [];

    if (this.isNoChargeOperationalOpen(event)) {
      return {
        matched: true,
        comparedAt: new Date().toISOString(),
        summary: event.hasInboundGoods
          ? "本次为入柜开门，库存以人工模板登记为准，不进行用户选择比对。"
          : "本次为运营开门，平台结算商品用于自动扣减库存，不进行用户选择比对。",
        intendedItems: [],
        settledItems,
        missingItems: [],
        extraItems: [],
        priceMismatches: []
      } satisfies CabinetSettlementComparison;
    }

    const intendedMap = new Map(intendedItems.map((item) => [item.goodsId, item]));
    const settledMap = new Map(settledItems.map((item) => [item.goodsId, item]));
    const missingItems: CabinetSettlementComparisonItem[] = [];
    const extraItems: CabinetSettlementComparisonItem[] = [];
    const priceMismatches: NonNullable<CabinetSettlementComparison["priceMismatches"]> = [];

    for (const item of intendedItems) {
      const settled = settledMap.get(item.goodsId);

      if (!settled) {
        missingItems.push(item);
        continue;
      }

      if (settled.quantity !== item.quantity) {
        const delta = item.quantity - settled.quantity;

        if (delta > 0) {
          missingItems.push({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: delta,
            unitPrice: item.unitPrice,
            amount: (item.unitPrice ?? 0) * delta
          });
        } else if (delta < 0) {
          extraItems.push({
            goodsId: item.goodsId,
            goodsName: item.goodsName,
            quantity: Math.abs(delta),
            unitPrice: settled.unitPrice,
            amount: (settled.unitPrice ?? 0) * Math.abs(delta)
          });
        }
      }

      if (
        item.unitPrice !== undefined &&
        settled.unitPrice !== undefined &&
        settled.unitPrice !== item.unitPrice
      ) {
        priceMismatches.push({
          goodsId: item.goodsId,
          goodsName: item.goodsName,
          quantity: Math.min(item.quantity, settled.quantity),
          quotedUnitPrice: item.unitPrice,
          platformUnitPrice: settled.unitPrice
        });
      }
    }

    for (const item of settledItems) {
      if (!intendedMap.has(item.goodsId)) {
        extraItems.push(item);
      }
    }

    const matched =
      missingItems.length === 0 &&
      extraItems.length === 0 &&
      priceMismatches.length === 0;
    const summaryParts: string[] = [];

    if (missingItems.length) {
      summaryParts.push(`少领 ${this.formatComparisonItems(missingItems)}`);
    }

    if (extraItems.length) {
      summaryParts.push(`多领 ${this.formatComparisonItems(extraItems)}`);
    }

    if (priceMismatches.length) {
      summaryParts.push(
        `平台单价与开柜报价不一致：${priceMismatches
          .map(
            (item) =>
              `${item.goodsName} 报价 ${this.formatAmount(item.quotedUnitPrice)}，平台返回 ${this.formatAmount(item.platformUnitPrice)}`
          )
          .join("、")}；用户金额仍按开柜前确认的报价计算`
      );
    }

    return {
      matched,
      comparedAt: new Date().toISOString(),
      summary: matched
        ? "平台结算结果与用户选择一致。"
        : `存在差异：${summaryParts.join("；")}`,
      intendedItems,
      settledItems,
      missingItems,
      extraItems,
      priceMismatches
    } satisfies CabinetSettlementComparison;
  }

  private formatComparisonItems(items: CabinetSettlementComparisonItem[]) {
    if (!items.length) {
      return "无";
    }

    return items.map((item) => `${item.goodsName} x${item.quantity}`).join("、");
  }
}
