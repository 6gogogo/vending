import assert from "node:assert/strict";
import test from "node:test";

import type { AppLoginResult, UserRole } from "@vm/shared-types";

import { createAppLoginContinuation } from "./app-login-continuation";

const approvedSession = (role: UserRole): Extract<AppLoginResult, { state: "approved" }> => ({
  state: "approved",
  token: "test-token",
  user: {
    id: `USER-${role}`,
    role,
    name: role,
    phone: "13800000000",
    tags: []
  }
});

test("已有会话恢复完成后直接回到扫码柜机", async () => {
  let bootstrapCount = 0;
  let sessionRole: UserRole | undefined = "special";
  const redirectedUrls: string[] = [];
  const homeRoles: UserRole[] = [];

  const continuation = createAppLoginContinuation({
    getPickupTarget: () => ({ deviceCode: "CAB-1001" }),
    bootstrapSession: async () => {
      bootstrapCount += 1;
    },
    getSessionRole: () => sessionRole,
    setSession: () => {
      throw new Error("恢复已有会话时不应覆盖会话");
    },
    redirectTo: (url) => redirectedUrls.push(url),
    routeRoleHome: (role) => homeRoles.push(role)
  });

  await continuation.restoreExistingSession();

  assert.equal(bootstrapCount, 1);
  assert.deepEqual(redirectedUrls, [
    "/pages/special/device-detail?deviceCode=CAB-1001&scan=1"
  ]);
  assert.deepEqual(homeRoles, []);

  sessionRole = undefined;
  await continuation.restoreExistingSession();
  assert.equal(bootstrapCount, 2);
  assert.equal(redirectedUrls.length, 1);
});

test("验证码登录成功保存会话后直接回到扫码柜机", () => {
  const savedSessions: Array<Extract<AppLoginResult, { state: "approved" }>> = [];
  const redirectedUrls: string[] = [];
  const homeRoles: UserRole[] = [];
  const continuation = createAppLoginContinuation({
    getPickupTarget: () => ({ deviceCode: "CAB-2002" }),
    bootstrapSession: async () => undefined,
    getSessionRole: () => undefined,
    setSession: (session) => savedSessions.push(session),
    redirectTo: (url) => redirectedUrls.push(url),
    routeRoleHome: (role) => homeRoles.push(role)
  });
  const session = approvedSession("special");

  continuation.continueApprovedLogin(session);

  assert.deepEqual(savedSessions, [session]);
  assert.deepEqual(redirectedUrls, [
    "/pages/special/device-detail?deviceCode=CAB-2002&scan=1"
  ]);
  assert.deepEqual(homeRoles, []);
});

test("非特殊角色登录成功后返回角色首页", () => {
  const homeRoles: UserRole[] = [];
  const continuation = createAppLoginContinuation({
    getPickupTarget: () => ({ deviceCode: "CAB-3003" }),
    bootstrapSession: async () => undefined,
    getSessionRole: () => undefined,
    setSession: () => undefined,
    redirectTo: () => {
      throw new Error("非特殊角色不得进入扫码领取页");
    },
    routeRoleHome: (role) => homeRoles.push(role)
  });

  continuation.continueApprovedLogin(approvedSession("restocker"));

  assert.deepEqual(homeRoles, ["restocker"]);
});
