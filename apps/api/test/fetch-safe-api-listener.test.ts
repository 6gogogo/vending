import assert from "node:assert/strict";
import test from "node:test";

import {
  isFetchSafeLoopbackPort,
  listenOnFetchSafeLoopbackPort
} from "./support/fetch-safe-api-listener";

test("测试 API 命中 Fetch 禁用端口时关闭并重新申请", async () => {
  const assignedPorts = [10_080, 30_001];
  const listenPorts: number[] = [];
  let closeCalls = 0;
  const application = {
    async listen(port: number) {
      listenPorts.push(port);
    },
    getHttpServer() {
      return {
        address: () => ({ port: assignedPorts[listenPorts.length - 1] }),
        close: (callback: (error?: Error | null) => void) => {
          closeCalls += 1;
          callback();
        }
      };
    }
  };

  const port = await listenOnFetchSafeLoopbackPort(application);

  assert.equal(port, 30_001);
  assert.deepEqual(listenPorts, [0, 0]);
  assert.equal(closeCalls, 1);
  assert.equal(isFetchSafeLoopbackPort(10_080), false);
  assert.equal(isFetchSafeLoopbackPort(30_001), true);
  assert.equal(isFetchSafeLoopbackPort(65_536), false);
});

test("测试 API 无法读取监听端口时仍关闭已打开的服务", async () => {
  let closeCalls = 0;
  const application = {
    async listen() {},
    getHttpServer() {
      return {
        address: () => null,
        close: (callback: (error?: Error | null) => void) => {
          closeCalls += 1;
          callback();
        }
      };
    }
  };

  await assert.rejects(
    () => listenOnFetchSafeLoopbackPort(application),
    /未返回有效的回环监听端口/
  );
  assert.equal(closeCalls, 1);
});
