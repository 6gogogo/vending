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

test("持久化状态完整性校验接受默认业务快照", () => {
  const result = validatePersistedState(createRawState());

  assert.deepEqual(result.errors, []);
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
