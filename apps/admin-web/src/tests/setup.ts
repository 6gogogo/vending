import { afterEach, beforeEach, vi } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";

enableAutoUnmount(afterEach);
beforeEach(() => {
  localStorage.clear();
  window.alert = vi.fn();
  window.confirm = vi.fn(() => false);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
