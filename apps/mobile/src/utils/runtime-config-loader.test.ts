import assert from "node:assert/strict";
import test from "node:test";

import { createCachedAsyncLoader } from "./runtime-config-loader";

test("运行配置默认复用请求，强制刷新时重新读取当前设置", async () => {
  let requestCount = 0;
  const loader = createCachedAsyncLoader(async () => ({
    verificationProvider: `provider-${++requestCount}`
  }));

  assert.deepEqual(await loader.load(), { verificationProvider: "provider-1" });
  assert.deepEqual(await loader.load(), { verificationProvider: "provider-1" });
  assert.equal(requestCount, 1);

  assert.deepEqual(await loader.load({ forceRefresh: true }), {
    verificationProvider: "provider-2"
  });
  assert.equal(requestCount, 2);
});

test("失败的运行配置请求不会污染下一次读取", async () => {
  let requestCount = 0;
  const loader = createCachedAsyncLoader(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      throw new Error("temporary failure");
    }
    return "ready";
  });

  await assert.rejects(() => loader.load(), /temporary failure/);
  assert.equal(await loader.load(), "ready");
  assert.equal(requestCount, 2);
});
