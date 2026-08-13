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
          data: validatedSession
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

test("分层额度池会随移动会话持久化，重新打开后仍能展示同一份任意额度", () => {
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
    store.setSession({
      token: "taxonomy-token",
      user: {
        id: "taxonomy-user",
        role: "special",
        name: "分类额度用户",
        phone: "13000000002",
        tags: []
      },
      quota: {
        remainingToday: { food: 2 },
        remainingPools: [
          {
            id: "any-limit",
            poolId: "any-pool",
            limitId: "any-limit",
            policyId: "policy",
            policyName: "今日额度",
            targetType: "taxonomy_node",
            targetId: "taxonomy:any",
            quantity: 2,
            remaining: 2
          }
        ],
        taxonomyRevision: 1
      }
    });

    const persisted = storage.get(MOBILE_SESSION_STORAGE_KEY) as {
      quota?: MobileSessionSnapshot["quota"];
    };
    assert.equal(persisted.quota?.remainingPools?.[0]?.poolId, "any-pool");
    assert.equal(persisted.quota?.taxonomyRevision, 1);
  } finally {
    runtimeGlobals.uni = originalUni;
  }
});
