import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { usePagePolling } from "../utils/use-page-polling";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const mountPolling = (load: () => Promise<unknown>) => mount(defineComponent({
  setup() { usePagePolling(load, 1_000); return () => h("p", "轮询测试"); }
}));

it("慢请求未完成时不叠加刷新，请求完成后再按间隔刷新", async () => {
  let finish!: () => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const wrapper = mountPolling(load);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(load).toHaveBeenCalledTimes(1);
  finish(); await flushPromises();
  await vi.advanceTimersByTimeAsync(999);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2);
  wrapper.unmount();
});

it("页面隐藏暂停刷新，重新可见立即刷新，卸载后不再响应可见性事件", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const load = vi.fn().mockResolvedValue(undefined);
  const wrapper = mountPolling(load); await flushPromises();
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(load).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange")); await flushPromises();
  expect(load).toHaveBeenCalledTimes(2);
  wrapper.unmount();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(load).toHaveBeenCalledTimes(2);
});

it("后台打开页面也先加载一次，之后等待可见才开始轮询", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const load = vi.fn().mockResolvedValue(undefined);
  const wrapper = mountPolling(load); await flushPromises();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(load).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
