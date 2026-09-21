import assert from "node:assert/strict";
import test from "node:test";
import { createGuestLaunchGuard } from "./guest-launch";
import { resolveGuestPrimaryActionUrl } from "./guest-pickup";
import { resolveBrowseReturn } from "./guest-navigation";
import { resolvePickupLoginTarget } from "./cabinet-entry";

test("旧登录页或注册页冷启动先回商品首页，不直接展示登录表单", () => {
  for (const path of ["pages/common/app-login", "/pages/common/app-login", "pages/common/register"]) {
    const guard = createGuestLaunchGuard();
    guard.launched(path);
    assert.deepEqual(guard.takeBrowseDestination({}), { kind: "tab", url: "/pages/tabs/primary" });
    assert.equal(guard.takeBrowseDestination({}), undefined, "后续主动登录不能再次被拦截");
  }
});

test("普通首页启动后主动登录不受影响，退出重启不复用上次意图", () => {
  const guard = createGuestLaunchGuard();
  for (const path of [undefined, "pages/tabs/primary", "pages/common/login", "pages/special/device-detail"]) {
    guard.launched(path);
    assert.equal(guard.takeBrowseDestination({ entry: "pickup", deviceCode: "CAB-1001" }), undefined);
  }
  guard.launched("pages/common/app-login");
  assert.equal(guard.takeBrowseDestination({})?.kind, "tab");
});

test("旧扫码登录链接冷启动先浏览原柜机，错误二维码不能回退伪造目标", () => {
  const guard = createGuestLaunchGuard();
  for (const query of [
    { entry: "pickup", deviceCode: "91110265" },
    { q: encodeURIComponent("https://vending.5gogogo.top/cabinet/91110265") }
  ]) {
    guard.launched("pages/common/app-login");
    assert.deepEqual(guard.takeBrowseDestination(query), { kind: "page", url: "/pages/special/device-detail?deviceCode=91110265&scan=1" });
  }
  guard.launched("pages/common/app-login");
  assert.equal(guard.takeBrowseDestination({ entry: "query", deviceCode: "CAB-1001" })?.url, "/pages/special/device-detail?deviceCode=CAB-1001");
  for (const query of [{ q: "https://evil.example/cabinet/CAB-1001", entry: "pickup", deviceCode: "CAB-1001" }, { entry: "pickup", deviceCode: "../admin" }]) {
    guard.launched("pages/common/app-login");
    assert.equal(guard.takeBrowseDestination(query)?.kind, "tab");
  }
});

test("完整游客流程：扫码浏览、主动开门才登录、取消登录仍回原扫码页", async () => {
  const guard = createGuestLaunchGuard();
  guard.launched("pages/tabs/primary");
  const browseUrl = await resolveGuestPrimaryActionUrl({}, async () => "CAB-1001");
  assert.equal(browseUrl, "/pages/special/device-detail?deviceCode=CAB-1001&scan=1");
  assert.doesNotMatch(browseUrl!, /login/);
  const loginUrl = await resolveGuestPrimaryActionUrl({ deviceCode: "CAB-1001", scanned: true }, async () => { assert.fail("点击开门不再扫码"); });
  assert.equal(loginUrl, "/pages/common/app-login?entry=pickup&deviceCode=CAB-1001");
  const query = { entry: "pickup", deviceCode: "CAB-1001" };
  assert.equal(guard.takeBrowseDestination(query), undefined);
  assert.equal(resolveBrowseReturn(resolvePickupLoginTarget(query)).url, browseUrl);
});
