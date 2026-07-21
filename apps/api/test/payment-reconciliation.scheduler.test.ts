import assert from "node:assert/strict";
import test from "node:test";

import type { ConfigService } from "@nestjs/config";

import { PaymentReconciliationScheduler } from "../src/modules/payments/payment-reconciliation.scheduler.js";

const createConfigService = (values: Record<string, string> = {}) =>
  ({
    get: (key: string) => values[key]
  }) as unknown as ConfigService;

test("启用且持有金融单写者租约时，后台对账调度器才执行一个对账周期", async () => {
  let calls = 0;
  const scheduler = new PaymentReconciliationScheduler(
    {
      runAutomaticReconciliationCycle: async () => {
        calls += 1;
      }
    } as never,
    createConfigService({ PAYMENT_RECONCILIATION_ENABLED: "true" }),
    {
      getStatus: () => ({ enabled: true, held: true }),
      release: () => undefined
    } as never
  );

  assert.equal(await scheduler.runCycle(), true);
  assert.equal(calls, 1);

  const withoutLease = new PaymentReconciliationScheduler(
    {
      runAutomaticReconciliationCycle: async () => {
        calls += 1;
      }
    } as never,
    createConfigService({ PAYMENT_RECONCILIATION_ENABLED: "true" }),
    {
      getStatus: () => ({ enabled: true, held: false }),
      release: () => undefined
    } as never
  );
  assert.equal(await withoutLease.runCycle(), false);

  const disabled = new PaymentReconciliationScheduler(
    {
      runAutomaticReconciliationCycle: async () => {
        calls += 1;
      }
    } as never,
    createConfigService({ PAYMENT_RECONCILIATION_ENABLED: "false" }),
    {
      getStatus: () => ({ enabled: true, held: true }),
      release: () => undefined
    } as never
  );
  assert.equal(await disabled.runCycle(), false);
  assert.equal(calls, 1);
});

test("一个周期未结束时，调度器拒绝重入且关闭后不再保留定时器", async () => {
  let resolveCycle: (() => void) | undefined;
  let calls = 0;
  let shouldBlock = true;
  const scheduler = new PaymentReconciliationScheduler(
    {
      runAutomaticReconciliationCycle: async () => {
        calls += 1;
        if (shouldBlock) {
          await new Promise<void>((resolve) => {
            resolveCycle = resolve;
          });
        }
      }
    } as never,
    createConfigService({ PAYMENT_RECONCILIATION_ENABLED: "true" }),
    {
      getStatus: () => ({ enabled: true, held: true }),
      release: () => undefined
    } as never
  );

  const first = scheduler.runCycle();
  assert.equal(await scheduler.runCycle(), false);
  assert.equal(calls, 1);
  resolveCycle?.();
  assert.equal(await first, true);
  shouldBlock = false;

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  await scheduler.onApplicationShutdown();
  assert.equal(scheduler.isRunning(), false);
});

test("关闭会等待在途周期完成，并永久阻止定时或手动启动新周期", async () => {
  let resolveCycle: (() => void) | undefined;
  let calls = 0;
  const scheduler = new PaymentReconciliationScheduler(
    {
      runAutomaticReconciliationCycle: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          resolveCycle = resolve;
        });
      }
    } as never,
    createConfigService({ PAYMENT_RECONCILIATION_ENABLED: "true" }),
    {
      getStatus: () => ({ enabled: true, held: true }),
      release: () => undefined
    } as never
  );

  assert.equal(scheduler.start(), true);
  assert.equal(calls, 1);

  let shutdownFinished = false;
  const shutdown = Promise.resolve(scheduler.onApplicationShutdown()).then(() => {
    shutdownFinished = true;
  });
  await Promise.resolve();

  assert.equal(scheduler.isRunning(), false);
  assert.equal(shutdownFinished, false);
  assert.equal(await scheduler.runCycle(), false);
  assert.equal(scheduler.start(), false);
  assert.equal(calls, 1);

  resolveCycle?.();
  await shutdown;
  assert.equal(shutdownFinished, true);
  assert.equal(await scheduler.runCycle(), false);
  assert.equal(calls, 1);
});

test("启用自动对账时拒绝过短或错误格式的生产扫描间隔", () => {
  const scheduler = new PaymentReconciliationScheduler(
    {
      runAutomaticReconciliationCycle: async () => undefined
    } as never,
    createConfigService({
      PAYMENT_RECONCILIATION_ENABLED: "true",
      PAYMENT_RECONCILIATION_INTERVAL_MS: "999"
    }),
    {
      getStatus: () => ({ enabled: true, held: true }),
      release: () => undefined
    } as never
  );

  assert.throws(
    () => scheduler.start(),
    /PAYMENT_RECONCILIATION_INTERVAL_MS.*1000 到 3600000/
  );
});

test("调度器把整轮成功或失败写入支付诊断状态", async () => {
  const events: string[] = [];
  const scheduler = new PaymentReconciliationScheduler(
    {
      recordAutomaticReconciliationStarted() {
        events.push("started");
      },
      async runAutomaticReconciliationCycle() {
        throw new Error("配置失效");
      },
      recordAutomaticReconciliationFailure(error: Error) {
        events.push(`failed:${error.message}`);
      }
    } as never,
    createConfigService({ PAYMENT_RECONCILIATION_ENABLED: "true" }),
    {
      getStatus: () => ({ enabled: true, held: true }),
      release: () => undefined
    } as never
  );

  assert.equal(await scheduler.runCycle(), false);
  assert.deepEqual(events, ["started", "failed:配置失效"]);
});
