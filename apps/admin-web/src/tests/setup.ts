import { afterEach, beforeEach, vi } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";

enableAutoUnmount(afterEach);
beforeEach(() => {
  localStorage.clear();
  window.alert = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
