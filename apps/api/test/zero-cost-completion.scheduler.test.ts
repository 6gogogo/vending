import assert from "node:assert/strict";
import test from "node:test";
import { ZeroCostCompletionScheduler } from "../src/modules/cabinet-events/zero-cost-completion.scheduler";

test("零元自动完结需要写租约，重复周期和关闭后的周期不会并发执行", async () => {
  let held = false;
  let calls = 0;
  let finish: () => void = () => {};
  const scheduler = new ZeroCostCompletionScheduler({
    completePendingZeroCostOrders: async (check: () => void) => {
      check(); calls++;
      await new Promise<void>((resolve) => { finish = resolve; });
    }
  } as never, { getStatus: () => ({ held }), assertHeld: () => assert.ok(held) } as never,
  { isPersistedStateIntegrityReady: () => true } as never, { isReady: () => true } as never);
  assert.equal(await scheduler.runCycle(), false);
  held = true;
  const running = scheduler.runCycle();
  assert.equal(await scheduler.runCycle(), false);
  const stopping = scheduler.onApplicationShutdown();
  finish();
  assert.equal(await running, true);
  await stopping;
  assert.equal(await scheduler.runCycle(), false);
  assert.equal(calls, 1);
});

test("生产零元补发先写审计，数据未就绪或中途丢失写租约即停止", async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    let ready = false;
    let held = true;
    const sequence: string[] = [];
    const scheduler = new ZeroCostCompletionScheduler({
      completePendingZeroCostOrders: async (check: () => void) => {
        check(); sequence.push("first"); held = false; check(); sequence.push("second");
      }
    } as never, { getStatus: () => ({ held }), assertHeld: () => assert.ok(held) } as never,
    { isPersistedStateIntegrityReady: () => ready } as never, {
      isReady: () => true,
      beginCriticalIntent: () => { sequence.push("intent"); return { startedAt: Date.now() }; },
      completeCriticalOperation: (_intent: unknown, result: { outcome: string }) => sequence.push(result.outcome)
    } as never);
    assert.equal(await scheduler.runCycle(), false);
    ready = true;
    assert.equal(await scheduler.runCycle(), false);
    assert.deepEqual(sequence, ["intent", "first", "failed"]);
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});
