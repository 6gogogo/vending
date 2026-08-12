import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";

import type { MobileSessionSnapshot } from "@vm/shared-types";

import { useSessionStore } from "./session";
import { MOBILE_SESSION_STORAGE_KEY } from "../utils/session-storage";

test("缓存会话经服务端确认前不会向页面放行，并合并并发校验", async () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
  };
  const originalUni = runtimeGlobals.uni;
  const cachedUser = {
    id: "cached-user",
    role: "special" as const,
    name: "缓存用户",
    phone: "13000000000",
    tags: []
  };
  const validatedSession: MobileSessionSnapshot = {
    token: "validated-token",
    user: {
      ...cachedUser,
      name: "已确认用户"
    }
  };
  const storage = new Map<string, unknown>([
    [MOBILE_SESSION_STORAGE_KEY, { token: "cached-token", user: cachedUser }]
  ]);
  let requestCount = 0;
  let completeValidation: (() => void) | undefined;

  runtimeGlobals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: {
      success: (response: { statusCode: number; data: unknown }) => void;
    }) => {
      requestCount += 1;
      completeValidation = () => options.success({
        statusCode: 200,
        data: {
          code: 0,
          message: "操作成功",
          data: { state: "approved", ...validatedSession }
        }
      });
    }
  };

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const firstBootstrap = store.bootstrap();
    let secondResolved = false;
    const secondBootstrap = store.bootstrap().then((user) => {
      secondResolved = true;
      return user;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    const resolvedBeforeValidation = secondResolved;
    const bootstrappedBeforeValidation = store.bootstrapped;

    assert.ok(completeValidation);
    completeValidation();
    const [firstUser, secondUser] = await Promise.all([
      firstBootstrap,
      secondBootstrap
    ]);

    assert.equal(requestCount, 1);
    assert.equal(resolvedBeforeValidation, false);
    assert.equal(bootstrappedBeforeValidation, false);
    assert.equal(firstUser?.name, "已确认用户");
    assert.equal(secondUser?.name, "已确认用户");
    assert.equal(store.bootstrapped, true);
    assert.equal(
      storage.get(MOBILE_SESSION_STORAGE_KEY) &&
        (storage.get(MOBILE_SESSION_STORAGE_KEY) as { token?: string }).token,
      "validated-token"
    );
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});

test("审核凭证启动时恢复审核状态并继续保留受限 token", async () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
  };
  const originalUni = runtimeGlobals.uni;
  const application = {
    id: "application-pending",
    phone: "13700009991",
    requestedRole: "special" as const,
    profile: { name: "待审核用户", regionName: "扬名街道" },
    status: "pending" as const,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  };
  const draft = {
    token: "onboarding-token",
    phone: application.phone,
    requestedRole: application.requestedRole,
    applicationId: application.id
  };
  const storage = new Map<string, unknown>([[
    MOBILE_SESSION_STORAGE_KEY,
    { token: draft.token, draft, application }
  ]]);

  runtimeGlobals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: {
      success: (response: { statusCode: number; data: unknown }) => void;
    }) => options.success({
      statusCode: 200,
      data: {
        code: 0,
        message: "操作成功",
        data: { state: "pending_review", draft, application }
      }
    })
  };

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const user = await store.bootstrap();

    assert.equal(user, undefined);
    assert.equal(store.token, draft.token);
    assert.equal(store.draft?.token, draft.token);
    assert.equal(store.application?.status, "pending");
    assert.equal(store.isLoggedIn, false);
    assert.equal(
      (storage.get(MOBILE_SESSION_STORAGE_KEY) as { token?: string }).token,
      draft.token
    );
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});

test("服务端暂时不可用时保留本地登录态，不把网络故障当成退出登录", async () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
  };
  const originalUni = runtimeGlobals.uni;
  const cachedUser = {
    id: "cached-user",
    role: "special" as const,
    name: "缓存用户",
    phone: "13000000000",
    tags: []
  };
  const storage = new Map<string, unknown>([
    [MOBILE_SESSION_STORAGE_KEY, { token: "cached-token", user: cachedUser }]
  ]);

  runtimeGlobals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: {
      success: (response: { statusCode: number; data: unknown }) => void;
    }) => options.success({
      statusCode: 503,
      data: { code: 503, message: "服务暂不可用。", data: null }
    })
  };

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();

    const user = await store.bootstrap();

    assert.equal(user?.id, cachedUser.id);
    assert.equal(store.bootstrapped, true);
    assert.equal(store.token, "cached-token");
    assert.equal(
      (storage.get(MOBILE_SESSION_STORAGE_KEY) as { token?: string }).token,
      "cached-token"
    );
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});

test("服务端明确拒绝失效凭证时清除本地登录态", async () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
  };
  const originalUni = runtimeGlobals.uni;
  const storage = new Map<string, unknown>([
    [
      MOBILE_SESSION_STORAGE_KEY,
      {
        token: "revoked-token",
        user: {
          id: "revoked-user",
          role: "special",
          name: "失效用户",
          phone: "13000000001",
          tags: []
        }
      }
    ]
  ]);

  runtimeGlobals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: {
      success: (response: { statusCode: number; data: unknown }) => void;
    }) => options.success({
      statusCode: 401,
      data: { code: 401, message: "当前登录态已失效，请重新登录。", data: null }
    })
  };

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();

    const user = await store.bootstrap();

    assert.equal(user, undefined);
    assert.equal(store.token, undefined);
    assert.equal(store.bootstrapped, true);
    assert.equal(storage.has(MOBILE_SESSION_STORAGE_KEY), false);
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});

test("扫码柜机目标跨资料与审核状态持久化，续接后才消费", () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    uni?: Record<string, unknown>;
  };
  const originalUni = runtimeGlobals.uni;
  const storage = new Map<string, unknown>();
  runtimeGlobals.uni = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key)
  };

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();
    store.setPickupTarget({ deviceCode: "CAB-5005" });
    store.setDraft({
      draft: {
        token: "draft-token",
        phone: "13700009995",
        requestedRole: "special"
      },
      profileDraft: { name: "扫码用户" }
    });
    assert.equal(store.pickupTarget?.deviceCode, "CAB-5005");

    setActivePinia(createPinia());
    const restored = useSessionStore();
    restored.hydrate();
    assert.equal(restored.pickupTarget?.deviceCode, "CAB-5005");
    assert.equal(restored.consumePickupTarget()?.deviceCode, "CAB-5005");
    assert.equal(restored.pickupTarget, undefined);
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});

test("审核页可主动重置启动状态并重新向服务端刷新", () => {
  const runtimeGlobals = globalThis as typeof globalThis & { uni?: Record<string, unknown> };
  const originalUni = runtimeGlobals.uni;
  runtimeGlobals.uni = {
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined
  };

  try {
    setActivePinia(createPinia());
    const store = useSessionStore();
    store.bootstrapped = true;
    store.resetBootstrap();
    assert.equal(store.bootstrapped, false);
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});
