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
