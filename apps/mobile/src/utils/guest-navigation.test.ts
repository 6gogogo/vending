import assert from "node:assert/strict";
import test from "node:test";
import { buildQueryLoginUrl, resolvePickupLoginTarget, resolvePickupPostLoginUrl, type PickupLoginTarget } from "./cabinet-entry";
import { resolveBrowseReturn, resolveGuestReturnTab, resumeGuestBrowsing } from "./guest-navigation";

test("浏览库存后登录保留查询模式，扫码登录才保留扫码模式", () => {
  const queryTarget = resolvePickupLoginTarget({ entry: "query", deviceCode: "91110265" });
  assert.equal(buildQueryLoginUrl("91110265"), "/pages/common/app-login?entry=query&deviceCode=91110265");
  assert.equal(resolvePickupPostLoginUrl("special", queryTarget), "/pages/special/device-detail?deviceCode=91110265");
  const scannedTarget = resolvePickupLoginTarget({ entry: "pickup", deviceCode: "91110265" });
  assert.equal(resolvePickupPostLoginUrl("special", scannedTarget), "/pages/special/device-detail?deviceCode=91110265&scan=1");
  assert.equal(resolvePickupPostLoginUrl("merchant", queryTarget), undefined);
  assert.equal(resolvePickupLoginTarget({ entry: "query", deviceCode: "../admin" }), undefined);
  assert.equal(resolvePickupLoginTarget({ entry: "unknown", deviceCode: "91110265" }), undefined);
});

test("取消登录只返回允许的浏览页面，不接受外部地址或管理页面", () => {
  assert.deepEqual(resolveBrowseReturn(undefined, "records"), { kind: "tab", url: "/pages/tabs/records" });
  assert.equal(resolveGuestReturnTab("settings"), "/pages/tabs/settings");
  for (const value of ["https://other.example", "/pages/admin/users", null, {}, undefined]) {
    assert.equal(resolveGuestReturnTab(value), "/pages/tabs/primary");
  }
  assert.deepEqual(resolveBrowseReturn({ deviceCode: "91110265", mode: "query" }), {
    kind: "page", url: "/pages/special/device-detail?deviceCode=91110265"
  });
});

test("取消登录撤销待领取目标，后续普通登录不会续接旧柜机", () => {
  const runtime = globalThis as typeof globalThis & { uni?: unknown };
  const previous = runtime.uni;
  const navigations: string[] = [];
  let pending: PickupLoginTarget | undefined = { deviceCode: "91110265" };
  runtime.uni = {
    redirectTo: ({ url }: { url: string }) => navigations.push(url),
    switchTab: ({ url }: { url: string }) => navigations.push(url)
  };
  try {
    resumeGuestBrowsing({ pickupTarget: pending, setPickupTarget: (value) => { pending = value; } });
    assert.equal(pending, undefined);
    assert.deepEqual(navigations, ["/pages/special/device-detail?deviceCode=91110265&scan=1"]);
    assert.equal(resolvePickupPostLoginUrl("special", pending), undefined);
  } finally {
    runtime.uni = previous;
  }
});
