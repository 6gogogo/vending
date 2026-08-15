import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertPersistedStateIntegrity,
  validatePersistedState,
  validatePersistedStateFile
} from "../src/common/store/persisted-state-integrity.js";
import { createSeededPersistedState } from "../src/common/store/persistence.js";

const createRawState = () =>
  structuredClone(createSeededPersistedState()) as unknown as Record<string, unknown>;

const createPaymentOrder = () => ({
  id: "payment-order-integrity",
  paymentNo: "payment-no-integrity",
  provider: "wechat",
  phase: "pre_open",
  status: "paid",
  amount: 1000
});

const createPaymentRefund = (
  paymentOrder: ReturnType<typeof createPaymentOrder>,
  overrides: Record<string, unknown> = {}
) => ({
  id: "payment-refund-integrity",
  paymentOrderId: paymentOrder.id,
  paymentNo: paymentOrder.paymentNo,
  refundNo: "refund-no-integrity",
  provider: paymentOrder.provider,
  status: "success",
  amount: 100,
  ...overrides
});

const createStateWithManualSettlement = () => {
  const state = createRawState();
  const events = state.events as Array<Record<string, unknown>>;
  const inventory = state.inventory as Array<Record<string, unknown>>;
  const goodsCatalog = state.goodsCatalog as Array<Record<string, unknown>>;
  const event = events[0];
  const goods = goodsCatalog[0];
  assert.ok(event);
  assert.ok(goods);
  const movementId = "movement-manual-settlement-integrity";
  inventory.push({
    id: movementId,
    orderNo: event.orderNo,
    eventId: event.eventId,
    userId: event.userId,
    deviceCode: event.deviceCode,
    goodsId: goods.goodsId,
    goodsName: goods.name,
    category: goods.category,
    quantity: 1,
    quotaQuantity: 1,
    unitPrice: 0,
    type: "pickup",
    settlementSource: "manual_recovery",
    happenedAt: "2026-08-08T00:00:00.000Z"
  });
  event.manualSettlement = {
    id: "manual-settlement-integrity",
    eventId: event.eventId,
    status: "awaiting_platform_completion",
    platformOrderNo: event.orderNo,
    items: [{
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: 1,
      unitPrice: 0
    }],
    movementIds: [movementId],
    reason: "现场盘点确认",
    handledAt: "2026-08-08T00:10:00.000Z",
    handledByUserId: event.userId
  };
  return { state, event, movementId };
};

test("持久化状态完整性校验接受默认业务快照", () => {
  const result = validatePersistedState(createRawState());

  assert.deepEqual(result.errors, []);
});

test("持久化状态完整性校验兼容尚未迁移分类树的历史快照", () => {
  const state = createRawState();
  delete state.goodsTaxonomyNodes;

  const result = validatePersistedState(state);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.includes("历史快照缺少 goodsTaxonomyNodes，将按未迁移状态加载。"));
});

test("持久化状态完整性校验拒绝分类循环和悬空货品归属", () => {
  const state = createRawState();
  state.goodsTaxonomyNodes = [
    { id: "root", name: "任意", parentId: null, status: "active", sortOrder: 1, revision: 1, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" },
    { id: "left", name: "食品", parentId: "right", status: "active", sortOrder: 1, revision: 1, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" },
    { id: "right", name: "饮料", parentId: "left", status: "active", sortOrder: 2, revision: 1, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" }
  ];
  (state.goodsCatalog as Array<Record<string, unknown>>)[0]!.taxonomyNodeId = "missing";

  const result = validatePersistedState(state);
  assert.ok(result.errors.includes("goodsTaxonomyNodes 存在循环引用。"));
  assert.ok(result.errors.includes("goodsCatalog[0].taxonomyNodeId 指向不存在的分类节点。"));
});

test("持久化状态完整性校验拒绝名称不是任意的分类根节点", () => {
  const state = createRawState();
  state.goodsTaxonomyNodes = [
    {
      id: "root",
      name: "全部物资",
      parentId: null,
      status: "active",
      sortOrder: 1,
      revision: 1,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z"
    }
  ];

  const result = validatePersistedState(state);
  assert.ok(result.errors.includes("goodsTaxonomyNodes 根节点名称必须为“任意”。"));
});

test("持久化状态完整性校验接受结构完整的人工结算补记", () => {
  const { state } = createStateWithManualSettlement();

  assert.deepEqual(validatePersistedState(state).errors, []);
});

test("持久化状态完整性校验接受已人工结案的迟到回调明细冲突", () => {
  const { state, event } = createStateWithManualSettlement();
  const record = event.manualSettlement as Record<string, unknown>;
  record.status = "callback_reconciled";
  record.lateCallback = {
    callbackLogId: "callback-integrity-resolved-conflict",
    receivedAt: "2026-08-08T00:20:00.000Z",
    platformAmount: 0,
    notifyUrl: "https://smartvm.example.test/payment-success",
    matched: false,
    items: structuredClone(record.items)
  };
  record.conflictResolution = "keep_manual";
  record.conflictResolvedAt = "2026-08-08T00:30:00.000Z";
  record.conflictResolvedByUserId = event.userId;
  record.conflictResolutionReason = "现场复核后保留人工盘点结果。";

  assert.deepEqual(validatePersistedState(state).errors, []);
});

test("持久化状态完整性校验拒绝损坏的人工结算状态和流水绑定", () => {
  const cases: Array<{
    label: string;
    mutate: (event: Record<string, unknown>) => void;
    expectedError: string;
  }> = [
    {
      label: "unknown status",
      mutate: (event) => {
        (event.manualSettlement as Record<string, unknown>).status = "private-invalid-status";
      },
      expectedError: "events[0].manualSettlement.status 不是允许的人工结算状态。"
    },
    {
      label: "mismatched event",
      mutate: (event) => {
        (event.manualSettlement as Record<string, unknown>).eventId = "other-event";
      },
      expectedError: "events[0].manualSettlement.eventId 必须与所属开柜事件一致。"
    },
    {
      label: "missing movement",
      mutate: (event) => {
        (event.manualSettlement as Record<string, unknown>).movementIds = ["missing-movement"];
      },
      expectedError: "events[0].manualSettlement.movementIds[0] 未引用同事件的有效pickup流水。"
    },
    {
      label: "invalid quantity",
      mutate: (event) => {
        const record = event.manualSettlement as Record<string, unknown>;
        (record.items as Array<Record<string, unknown>>)[0]!.quantity = 0;
      },
      expectedError: "events[0].manualSettlement.items[0].quantity 必须是正安全整数。"
    },
    {
      label: "conflict without callback",
      mutate: (event) => {
        (event.manualSettlement as Record<string, unknown>).status = "conflict";
      },
      expectedError: "events[0].manualSettlement 的明细冲突状态必须绑定未匹配的迟到回调。"
    },
    {
      label: "mismatched platform order",
      mutate: (event) => {
        (event.manualSettlement as Record<string, unknown>).platformOrderNo = "other-order";
      },
      expectedError: "events[0].manualSettlement.platformOrderNo 必须与所属开柜事件订单号一致。"
    },
    {
      label: "reconciled callback marked mismatched",
      mutate: (event) => {
        const record = event.manualSettlement as Record<string, unknown>;
        record.status = "callback_reconciled";
        record.lateCallback = {
          callbackLogId: "callback-integrity",
          receivedAt: "2026-08-08T00:20:00.000Z",
          platformAmount: 0,
          notifyUrl: "https://smartvm.example.test/payment-success",
          matched: false,
          items: structuredClone(record.items)
        };
      },
      expectedError: "events[0].manualSettlement 的已核对状态必须绑定明细一致的迟到回调。"
    },
    {
      label: "conflict callback marked matched",
      mutate: (event) => {
        const record = event.manualSettlement as Record<string, unknown>;
        record.status = "conflict";
        record.lateCallback = {
          callbackLogId: "callback-integrity",
          receivedAt: "2026-08-08T00:20:00.000Z",
          platformAmount: 0,
          notifyUrl: "https://smartvm.example.test/payment-success",
          matched: true,
          items: structuredClone(record.items)
        };
      },
      expectedError: "events[0].manualSettlement 的明细冲突状态必须绑定未匹配的迟到回调。"
    }
  ];

  for (const testCase of cases) {
    const { state, event } = createStateWithManualSettlement();
    testCase.mutate(event);
    const result = validatePersistedState(state);
    assert.ok(result.errors.includes(testCase.expectedError), testCase.label);
    assert.equal(
      result.errors.some((entry) => entry.includes("private-invalid-status")),
      false,
      testCase.label
    );
  }
});

test("持久化状态完整性校验约束预约状态与管理员取消证据", () => {
  const createStateWithReservation = () => {
    const state = createRawState();
    const users = state.users as Array<Record<string, unknown>>;
    const devices = state.devices as Array<Record<string, unknown>>;
    const admin = users.find((entry) => entry.role === "admin");
    const user = users.find((entry) => entry.role === "special");
    const device = devices[0];
    assert.ok(admin);
    assert.ok(user);
    assert.ok(device);
    const now = "2026-08-08T00:00:00.000Z";
    const reservation: Record<string, unknown> = {
      id: "reservation-integrity",
      userId: user.id,
      phone: user.phone,
      userName: user.name,
      deviceCode: device.deviceCode,
      doorNum: "1",
      status: "cancelled",
      inventoryReservationMode: "goods_quantity",
      batchAllocationTiming: "on_open",
      items: [],
      reservedAt: now,
      expiresAt: "2026-08-08T01:00:00.000Z",
      createdAt: now,
      updatedAt: now,
      cancelledAt: now,
      cancelledByUserId: admin.id,
      cancellationReason: "用户来电确认不再领取。"
    };
    state.reservations = [reservation];
    return { state, reservation, admin, user };
  };

  assert.deepEqual(
    validatePersistedState(createStateWithReservation().state).errors,
    []
  );

  const cases: Array<{
    label: string;
    mutate: (reservation: Record<string, unknown>) => void;
    expectedError: string;
  }> = [
    {
      label: "invalid status",
      mutate: (reservation) => {
        reservation.status = "private-invalid-status";
      },
      expectedError: "reservations[0].status 不是允许的预约状态。"
    },
    {
      label: "missing cancelled time",
      mutate: (reservation) => {
        delete reservation.cancelledAt;
      },
      expectedError: "reservations[0].cancelledAt 在已取消状态下必须是有效时间。"
    },
    {
      label: "missing cancelled actor",
      mutate: (reservation) => {
        delete reservation.cancelledByUserId;
      },
      expectedError: "reservations[0].cancelledByUserId 在已取消状态下不能为空。"
    },
    {
      label: "admin cancellation without reason",
      mutate: (reservation) => {
        delete reservation.cancellationReason;
      },
      expectedError: "reservations[0].cancellationReason 在管理员取消时必须为 2 至 200 字。"
    }
  ];

  for (const testCase of cases) {
    const { state, reservation } = createStateWithReservation();
    testCase.mutate(reservation);
    const result = validatePersistedState(state);
    assert.ok(result.errors.includes(testCase.expectedError), testCase.label);
    assert.equal(
      result.errors.some((entry) => entry.includes("private-invalid-status")),
      false,
      testCase.label
    );
  }

  const selfCancelled = createStateWithReservation();
  selfCancelled.reservation.cancelledByUserId = selfCancelled.user.id;
  delete selfCancelled.reservation.cancellationReason;
  assert.deepEqual(validatePersistedState(selfCancelled.state).errors, []);
});

test("开柜平台订单号在实例内必须唯一，不同实例可以使用相同订单号", () => {
  const sameTenantState = createRawState();
  const sameTenantEvents = sameTenantState.events as Array<Record<string, unknown>>;
  const sourceEvent = sameTenantEvents[0];
  assert.ok(sourceEvent);
  sameTenantEvents.push({
    ...structuredClone(sourceEvent),
    eventId: "event-same-tenant-duplicate-order"
  });
  assert.ok(
    validatePersistedState(sameTenantState).errors.includes(
      "events 当前实例存在重复 orderNo。"
    )
  );

  const crossTenantState = createRawState();
  const crossTenantEvents = crossTenantState.events as Array<Record<string, unknown>>;
  const crossTenantUsers = crossTenantState.users as Array<Record<string, unknown>>;
  const crossTenantSourceEvent = crossTenantEvents[0];
  const sourceUser = crossTenantUsers.find(
    (entry) => entry.id === crossTenantSourceEvent?.userId
  );
  assert.ok(crossTenantSourceEvent);
  assert.ok(sourceUser);
  const otherUserId = "user-other-tenant-duplicate-order";
  crossTenantUsers.push({
    ...structuredClone(sourceUser),
    id: otherUserId,
    phone: "13000009997",
    tenantId: "tenant-other-order-scope"
  });
  crossTenantEvents.push({
    ...structuredClone(crossTenantSourceEvent),
    eventId: "event-other-tenant-duplicate-order",
    userId: otherUserId
  });
  assert.equal(
    validatePersistedState(crossTenantState).errors.includes(
      "events 当前实例存在重复 orderNo。"
    ),
    false
  );
});

test("默认密码凭据告警按脱敏存储类别与后台角色分组", () => {
  const state = createRawState();
  const users = state.users as Array<Record<string, unknown>>;
  assert.ok(users[0]?.id);
  assert.ok(users[1]?.id);
  state.adminCredentials = [
    {
      userId: users[0].id,
      username: "legacy-default-credential",
      passwordSalt: "salt",
      passwordHash: "hash",
      usesDefaultPassword: true,
      passwordUpdatedAt: "2026-07-29T00:00:00.000Z"
    }
  ];
  state.backofficeCredentials = [
    {
      userId: users[0].id,
      username: "provider-default-credential",
      role: "super_admin",
      passwordSalt: "salt",
      passwordHash: "hash",
      usesDefaultPassword: true,
      passwordUpdatedAt: "2026-07-29T00:00:00.000Z"
    },
    {
      userId: users[1].id,
      username: "merchant-default-credential",
      role: "merchant",
      passwordSalt: "salt",
      passwordHash: "hash",
      usesDefaultPassword: true,
      passwordUpdatedAt: "2026-07-29T00:00:00.000Z"
    }
  ];

  const result = validatePersistedState(state);

  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.includes(
      "仍有 3 个默认密码凭据（旧管理员兼容凭据 1 条；服务提供商超级管理员 1 条；商户 1 条），公网投放前应改密或移除。"
    )
  );
  assert.equal(result.warnings.some((warning) => /用户名|账号/.test(warning)), false);
});

test("仅兼容历史模拟快照缺失人工验证码签发集合", () => {
  const simulationState = createRawState();
  delete simulationState.manualVerificationGrants;

  const simulationResult = validatePersistedState(simulationState);

  assert.deepEqual(simulationResult.errors, []);
  assert.deepEqual(simulationResult.warnings, [
    "历史 simulation 快照缺少 manualVerificationGrants，将在受控启动时补齐。"
  ]);

  const liveState = createRawState();
  liveState.dataPlane = "live";
  liveState.initializationSource = "live-bootstrap";
  delete liveState.manualVerificationGrants;

  const liveResult = validatePersistedState(liveState);

  assert.ok(liveResult.errors.includes("manualVerificationGrants 必须是数组。"));
  assert.equal(
    liveResult.warnings.includes(
      "历史 simulation 快照缺少 manualVerificationGrants，将在受控启动时补齐。"
    ),
    false
  );
});

test("持久化状态完整性校验拒绝缺失的状态集合和大小写等价的重复后台账号", () => {
  const state = createRawState();
  const users = state.users as Array<Record<string, unknown>>;
  const marker = "private-case-marker";
  state.adminCredentials = [
    { userId: users[0]!.id, username: marker },
    { userId: users[1]!.id, username: marker.toUpperCase() }
  ];
  delete state.expiredBatchDispositions;

  const result = validatePersistedState(state);

  assert.ok(result.errors.includes("expiredBatchDispositions 必须是数组。"));
  assert.ok(result.errors.includes("adminCredentials 存在重复 username。"));
  assert.equal(result.errors.some((entry) => entry.includes(marker)), false);
});

test("持久化状态完整性校验拒绝孤儿引用但不在错误中暴露引用值", () => {
  const state = createRawState();
  const users = state.users as Array<Record<string, unknown>>;
  const marker = "private-orphan-marker";
  state.merchantGoodsTemplates = [
    {
      id: "template-integrity-test",
      ownerUserId: users[0]!.id,
      goodsId: marker
    }
  ];

  const result = validatePersistedState(state);

  assert.ok(result.errors.includes("merchantGoodsTemplates[0].goodsId 引用了不存在的货品。"));
  assert.equal(result.errors.some((entry) => entry.includes(marker)), false);
  assert.throws(
    () => assertPersistedStateIntegrity(state),
    /运行数据完整性检查未通过/
  );
});

test("持久化状态完整性校验要求凭据哈希材料和默认密码标记完整", () => {
  const state = createRawState();
  const users = state.users as Array<Record<string, unknown>>;
  state.adminCredentials = [
    {
      userId: users[0]!.id,
      username: "operator",
      passwordSalt: "",
      passwordHash: "",
      passwordUpdatedAt: ""
    }
  ];

  const result = validatePersistedState(state);

  assert.ok(result.errors.includes("adminCredentials[0].passwordSalt 缺失或为空字符串。"));
  assert.ok(result.errors.includes("adminCredentials[0].passwordHash 缺失或为空字符串。"));
  assert.ok(result.errors.includes("adminCredentials[0].passwordUpdatedAt 缺失或为空字符串。"));
  assert.ok(result.errors.includes("adminCredentials[0].usesDefaultPassword 必须是布尔值。"));
});

test("持久化状态文件解析失败只报告固定错误，不回显底层解析细节", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persisted-state-integrity-"));
  const dataFile = join(directory, "store.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(dataFile, "{ invalid", "utf8");

  assert.deepEqual(validatePersistedStateFile(dataFile).errors, ["业务数据 JSON 解析失败。"]);
});

test("持久化状态完整性校验允许同一支付单的部分退款，并且失败退款不占用可退余额", () => {
  const state = createRawState();
  const paymentOrder = createPaymentOrder();
  state.paymentOrders = [paymentOrder];
  state.paymentRefunds = [
    createPaymentRefund(paymentOrder, {
      id: "payment-refund-success",
      refundNo: "refund-no-success",
      status: "success",
      amount: 400
    }),
    createPaymentRefund(paymentOrder, {
      id: "payment-refund-pending",
      refundNo: "refund-no-pending",
      status: "pending",
      amount: 600
    }),
    createPaymentRefund(paymentOrder, {
      id: "payment-refund-failed",
      refundNo: "refund-no-failed",
      status: "failed",
      providerOutcome: "failed",
      amount: 1000
    })
  ];

  assert.deepEqual(validatePersistedState(state).errors, []);
});

test("持久化状态完整性校验拒绝未知支付与退款枚举且不回显非法值", () => {
  const marker = "private-unknown-payment-enum";
  const cases: Array<{
    target: "order" | "refund";
    field: string;
    expectedError: string;
  }> = [
    {
      target: "order",
      field: "provider",
      expectedError: "paymentOrders[0].provider 不是允许的支付渠道。"
    },
    {
      target: "order",
      field: "phase",
      expectedError: "paymentOrders[0].phase 不是允许的支付阶段。"
    },
    {
      target: "order",
      field: "status",
      expectedError: "paymentOrders[0].status 不是允许的支付状态。"
    },
    {
      target: "refund",
      field: "provider",
      expectedError: "paymentRefunds[0].provider 不是允许的支付渠道。"
    },
    {
      target: "refund",
      field: "status",
      expectedError: "paymentRefunds[0].status 不是允许的退款状态。"
    },
    {
      target: "refund",
      field: "providerOutcome",
      expectedError: "paymentRefunds[0].providerOutcome 不是允许的退款渠道结果。"
    },
    {
      target: "refund",
      field: "businessApplyState",
      expectedError: "paymentRefunds[0].businessApplyState 不是允许的退款业务应用状态。"
    }
  ];

  for (const testCase of cases) {
    const state = createRawState();
    const paymentOrder = createPaymentOrder();
    const paymentRefund = createPaymentRefund(paymentOrder);
    state.paymentOrders = [paymentOrder];
    state.paymentRefunds = [paymentRefund];

    if (testCase.target === "order") {
      paymentOrder[testCase.field as keyof typeof paymentOrder] = marker as never;
    } else {
      paymentRefund[testCase.field as keyof typeof paymentRefund] = marker as never;
    }

    const result = validatePersistedState(state);
    assert.ok(result.errors.includes(testCase.expectedError), testCase.field);
    assert.equal(result.errors.some((entry) => entry.includes(marker)), false, testCase.field);
  }
});

test("持久化状态完整性校验拒绝已成功标记与退款状态矛盾的快照", () => {
  const paymentOrder = createPaymentOrder();
  const cases: Array<{
    label: string;
    overrides: Record<string, unknown>;
    expectedError: string;
  }> = [
    {
      label: "失败状态与渠道成功结果",
      overrides: { status: "failed", providerOutcome: "success" },
      expectedError: "paymentRefunds[0].providerOutcome 为成功时退款状态必须为成功或待确认。"
    },
    {
      label: "失败状态与已退款时间",
      overrides: { status: "failed", refundedAt: new Date().toISOString() },
      expectedError: "paymentRefunds[0].refundedAt 存在时退款状态必须为成功。"
    },
    {
      label: "失败状态与待确认渠道结果",
      overrides: { status: "failed", providerOutcome: "unknown" },
      expectedError: "paymentRefunds[0].status 为失败时退款渠道结果必须为失败。"
    },
    {
      label: "失败状态与处理中渠道结果",
      overrides: { status: "failed", providerOutcome: "pending" },
      expectedError: "paymentRefunds[0].status 为失败时退款渠道结果必须为失败。"
    },
    {
      label: "失败状态与已完成业务应用",
      overrides: { status: "failed", providerOutcome: "failed", businessApplyState: "completed" },
      expectedError: "paymentRefunds[0].status 为失败时退款业务应用状态不能为已完成。"
    },
    {
      label: "待确认状态与已退款时间",
      overrides: { status: "pending", refundedAt: new Date().toISOString() },
      expectedError: "paymentRefunds[0].refundedAt 存在时退款状态必须为成功。"
    }
  ];

  for (const testCase of cases) {
    const state = createRawState();
    state.paymentOrders = [paymentOrder];
    state.paymentRefunds = [createPaymentRefund(paymentOrder, testCase.overrides)];

    assert.ok(
      validatePersistedState(state).errors.includes(testCase.expectedError),
      testCase.label
    );
  }

  const compatibleState = createRawState();
  compatibleState.paymentOrders = [paymentOrder];
  compatibleState.paymentRefunds = [
    createPaymentRefund(paymentOrder, {
      status: "pending",
      providerOutcome: "success",
      businessApplyState: "pending"
    })
  ];

  assert.deepEqual(validatePersistedState(compatibleState).errors, []);
});

test("持久化状态完整性校验拒绝错绑支付退款且不回显敏感绑定值", () => {
  const paymentOrder = createPaymentOrder();
  const marker = "private-refund-binding-marker";
  const cases: Array<{
    label: string;
    overrides: Record<string, unknown>;
    expectedError: string;
  }> = [
    {
      label: "paymentNo",
      overrides: { paymentNo: marker },
      expectedError: "paymentRefunds[0].paymentNo 与引用支付单不一致。"
    },
    {
      label: "provider",
      overrides: { provider: marker },
      expectedError: "paymentRefunds[0].provider 与引用支付单不一致。"
    },
    {
      label: "single amount",
      overrides: { amount: 1001 },
      expectedError: "paymentRefunds[0].amount 超过引用支付单金额。"
    }
  ];

  for (const testCase of cases) {
    const state = createRawState();
    state.paymentOrders = [paymentOrder];
    state.paymentRefunds = [createPaymentRefund(paymentOrder, testCase.overrides)];
    const result = validatePersistedState(state);

    assert.ok(result.errors.includes(testCase.expectedError), testCase.label);
    assert.equal(result.errors.some((entry) => entry.includes(marker)), false, testCase.label);
  }
});

test("持久化状态完整性校验拒绝超额累计和非正安全整数退款", () => {
  const paymentOrder = createPaymentOrder();
  const state = createRawState();
  state.paymentOrders = [paymentOrder];
  state.paymentRefunds = [
    createPaymentRefund(paymentOrder, {
      id: "payment-refund-success",
      refundNo: "refund-no-success",
      status: "success",
      amount: 600
    }),
    createPaymentRefund(paymentOrder, {
      id: "payment-refund-pending",
      refundNo: "refund-no-pending",
      status: "pending",
      amount: 500
    })
  ];

  assert.ok(
    validatePersistedState(state).errors.includes(
      "paymentRefunds 对同一支付单的成功或待确认退款累计金额超过支付单金额。"
    )
  );

  for (const amount of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidState = createRawState();
    invalidState.paymentOrders = [paymentOrder];
    invalidState.paymentRefunds = [createPaymentRefund(paymentOrder, { amount })];

    assert.ok(
      validatePersistedState(invalidState).errors.includes(
        "paymentRefunds[0].amount 必须是安全整数且不小于 1。"
      ),
      `${amount}`
    );
  }
});

test("持久化状态完整性校验对孤儿退款只报告原有引用错误", () => {
  const state = createRawState();
  const paymentOrder = createPaymentOrder();
  state.paymentRefunds = [
    createPaymentRefund(paymentOrder, {
      paymentOrderId: "missing-payment-order"
    })
  ];

  assert.deepEqual(validatePersistedState(state).errors, [
    "paymentRefunds[0].paymentOrderId 引用了不存在的支付单。"
  ]);
});
