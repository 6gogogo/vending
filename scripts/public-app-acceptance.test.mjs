import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { runPublicAppAcceptance } from "./public-app-acceptance.mjs";

const publicApiBaseUrl = "https://vending.5gogogo.top/api";

const jsonResponse = (status, data = undefined) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() {
    return data === undefined ? {} : { data };
  }
});

const createFixtureFetch = () => {
  const calls = [];
  let appLoginCount = 0;

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method ?? "GET").toUpperCase();
    const path = parsed.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, headers: init.headers ?? {} });

    if (path === "/api/public-config" && method === "GET") {
      return jsonResponse(200, {
        runtimeDataPlane: "simulation",
        verificationProvider: "manual",
        verificationPreviewEnabled: false
      });
    }

    if (path === "/api/auth/backoffice-login" && method === "POST") {
      return jsonResponse(201, { token: "backoffice-session-token" });
    }

    if (path === "/api/auth/backoffice-session" && method === "GET") {
      return jsonResponse(200, {
        user: {
          backofficeRole: "admin",
          permissions: [
            "users:manage",
            "users:rules:manage",
            "verification-codes:manage",
            "devices:view"
          ]
        }
      });
    }

    if (path === "/api/reservations/settings" && method === "GET") {
      return jsonResponse(200, { enabled: true });
    }

    if (path === "/api/devices" && method === "GET") {
      return jsonResponse(200, [
        {
          deviceCode: "fixture-device",
          status: "online",
          doors: [
            {
              doorNum: "1",
              goods: [
                {
                  goodsId: "fixture-goods",
                  name: "验收物资",
                  category: "food",
                  stock: 2
                }
              ]
            }
          ]
        }
      ]);
    }

    if (path === "/api/users" && method === "POST") {
      return jsonResponse(201, { id: "fixture-user" });
    }

    if (path === "/api/users/fixture-user/access-policies" && method === "POST") {
      return jsonResponse(201, { id: "fixture-policy" });
    }

    if (path === "/api/auth/manual-verification-codes" && method === "POST") {
      return jsonResponse(201, { id: "fixture-grant" });
    }

    if (path === "/api/auth/app-login" && method === "POST") {
      appLoginCount += 1;
      return appLoginCount === 1
        ? jsonResponse(201, { state: "approved", token: "app-session-token" })
        : jsonResponse(401);
    }

    if (path === "/api/auth/app-session" && method === "GET") {
      return jsonResponse(200, { user: { role: "special" } });
    }

    if (path === "/api/devices/fixture-device" && method === "GET") {
      return jsonResponse(200, { deviceCode: "fixture-device" });
    }

    if (path === "/api/reservations" && method === "POST") {
      return jsonResponse(200, { id: "fixture-reservation", status: "active" });
    }

    if (path === "/api/reservations/my" && method === "GET") {
      return jsonResponse(200, [{ id: "fixture-reservation", status: "active" }]);
    }

    if (path === "/api/auth/manual-verification-codes" && method === "GET") {
      return jsonResponse(200, [{ id: "fixture-grant", status: "consumed" }]);
    }

    if (path === "/api/reservations/fixture-reservation/cancel" && method === "POST") {
      return jsonResponse(200, { id: "fixture-reservation", status: "cancelled" });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      return jsonResponse(201, {});
    }

    if (path === "/api/users/fixture-user" && method === "DELETE") {
      return jsonResponse(200, {});
    }

    throw new Error(`未预期的验收请求：${method} ${path}`);
  };

  return { calls, fetchImpl };
};

test("受控公网验收仅使用正式接口，并在成功后取消预约和删除自建夹具", async () => {
  const { calls, fetchImpl } = createFixtureFetch();
  const report = [];
  const inputs = {
    adminPassword: "test-admin-password",
    manualCode: "314159"
  };

  const result = await runPublicAppAcceptance({
    fetchImpl,
    publicApiBaseUrl,
    inputs,
    createRunReference: () => "f0f0f0f0-0000-4000-8000-000000000001",
    report: (event) => report.push(event)
  });

  assert.deepEqual(result, {
    publicIngressVerified: true,
    manualCodeReplayRejected: true,
    reservationCancelled: true,
    fixtureRemoved: true
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /api/public-config",
      "POST /api/auth/backoffice-login",
      "GET /api/auth/backoffice-session",
      "GET /api/reservations/settings",
      "GET /api/devices",
      "POST /api/users",
      "POST /api/users/fixture-user/access-policies",
      "POST /api/auth/manual-verification-codes",
      "POST /api/auth/app-login",
      "GET /api/auth/app-session",
      "GET /api/reservations/settings",
      "GET /api/devices",
      "GET /api/devices/fixture-device",
      "POST /api/reservations",
      "GET /api/reservations/my",
      "POST /api/auth/app-login",
      "GET /api/auth/manual-verification-codes",
      "POST /api/reservations/fixture-reservation/cancel",
      "POST /api/auth/logout",
      "DELETE /api/users/fixture-user",
      "POST /api/auth/logout"
    ]
  );
  assert.equal(calls.find((call) => call.path === "/api/users")?.body?.role, "special");
  assert.equal(
    calls.find((call) => call.path === "/api/users")?.body?.name,
    "公网验收专用账号-f0f0f0f0-0000-4000-8000-000000000001"
  );
  assert.equal(
    calls.find((call) => call.path === "/api/auth/manual-verification-codes")?.body?.expiresInSeconds,
    300
  );
  assert.equal(
    calls.find((call) => call.path === "/api/reservations")?.body?.deviceCode,
    "fixture-device"
  );

  const fixturePhone = calls.find((call) => call.path === "/api/users")?.body?.phone;
  assert.match(fixturePhone, /^1\d{10}$/u);

  const emitted = JSON.stringify(report);
  for (const sensitiveValue of [
    inputs.adminPassword,
    fixturePhone,
    inputs.manualCode,
    "backoffice-session-token",
    "app-session-token"
  ]) {
    assert.doesNotMatch(emitted, new RegExp(sensitiveValue, "u"));
  }
});

test("受控公网验收从运行参考号生成未回显的自建夹具手机号", async () => {
  const { calls, fetchImpl } = createFixtureFetch();
  const report = [];
  const inputs = {
    adminPassword: "test-admin-password",
    manualCode: "314159"
  };

  await runPublicAppAcceptance({
    fetchImpl,
    publicApiBaseUrl,
    inputs,
    createRunReference: () => "f0f0f0f0-0000-4000-8000-000000000006",
    report: (event) => report.push(event)
  });

  const fixturePhone = calls.find((call) => call.path === "/api/users")?.body?.phone;
  assert.match(fixturePhone, /^1\d{10}$/u);
  const appLoginCalls = calls.filter((call) => call.path === "/api/auth/app-login");
  assert.equal(appLoginCalls.length, 2);
  assert.ok(appLoginCalls.every((call) => call.body?.phone === fixturePhone));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(fixturePhone, "u"));
});

test("不符合隔离手动码前提时，在任何认证或写入前关闭式停止", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      runPublicAppAcceptance({
        publicApiBaseUrl,
        inputs: {
          adminPassword: "test-admin-password",
          manualCode: "314159"
        },
        fetchImpl: async (url, init = {}) => {
          calls.push({
            path: new URL(url).pathname,
            method: String(init.method ?? "GET").toUpperCase()
          });
          return jsonResponse(200, {
            runtimeDataPlane: "live",
            verificationProvider: "manual",
            verificationPreviewEnabled: false
          });
        },
        report: () => undefined
      }),
    /隔离模拟/u
  );

  assert.deepEqual(calls, [{ path: "/api/public-config", method: "GET" }]);
});

test("维护中柜机不会被当作可预约候选，且不会创建夹具", async () => {
  const { calls, fetchImpl: baseFetch } = createFixtureFetch();
  const fetchImpl = async (url, init = {}) => {
    if (new URL(url).pathname === "/api/devices") {
      const method = String(init.method ?? "GET").toUpperCase();
      calls.push({ path: "/api/devices", method, body: undefined, headers: init.headers ?? {} });
      return jsonResponse(200, [
        {
          deviceCode: "maintenance-device",
          status: "maintenance",
          doors: [
            {
              doorNum: "1",
              goods: [
                {
                  goodsId: "maintenance-goods",
                  name: "维护物资",
                  category: "food",
                  stock: 1
                }
              ]
            }
          ]
        }
      ]);
    }
    return baseFetch(url, init);
  };

  await assert.rejects(
    () =>
      runPublicAppAcceptance({
        fetchImpl,
        publicApiBaseUrl,
        inputs: {
          adminPassword: "test-admin-password",
          manualCode: "314159"
        },
        createRunReference: () => "f0f0f0f0-0000-4000-8000-000000000002"
      }),
    /没有可安全预约/u
  );

  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/api/users"), false);
});

test("签码后登录失败时接受撤销接口的 201，并清理已创建夹具", async () => {
  const { calls, fetchImpl: baseFetch } = createFixtureFetch();
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = String(init.method ?? "GET").toUpperCase();
    if (path === "/api/auth/app-login" && method === "POST") {
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers ?? {} });
      return jsonResponse(400);
    }
    if (path === "/api/auth/manual-verification-codes/fixture-grant/revoke" && method === "POST") {
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers ?? {} });
      return jsonResponse(201, { id: "fixture-grant", status: "revoked" });
    }
    return baseFetch(url, init);
  };

  await assert.rejects(
    () =>
      runPublicAppAcceptance({
        fetchImpl,
        publicApiBaseUrl,
        inputs: {
          adminPassword: "test-admin-password",
          manualCode: "314159"
        },
        createRunReference: () => "f0f0f0f0-0000-4000-8000-000000000003"
      }),
    /App 人工码登录/u
  );

  assert.ok(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/auth/manual-verification-codes/fixture-grant/revoke"
    )
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/api/users/fixture-user"));
});

test("创建人员响应无法确认时不猜测删除对象，只给出非敏感运行参考号", async () => {
  const { calls, fetchImpl: baseFetch } = createFixtureFetch();
  const reference = "f0f0f0f0-0000-4000-8000-000000000004";
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = String(init.method ?? "GET").toUpperCase();
    if (path === "/api/users" && method === "POST") {
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers ?? {} });
      return jsonResponse(201, {});
    }
    return baseFetch(url, init);
  };

  await assert.rejects(
    () =>
      runPublicAppAcceptance({
        fetchImpl,
        publicApiBaseUrl,
        inputs: {
          adminPassword: "test-admin-password",
          manualCode: "314159"
        },
        createRunReference: () => reference
      }),
    (error) =>
      error?.stage === "创建自建验收夹具" &&
      error?.recoveryReference === reference
  );

  assert.equal(calls.some((call) => call.path === "/api/users/fixture-user"), false);
  assert.equal(
    calls.some((call) => call.path === "/api/users/fixture-user/access-policies"),
    false
  );
});

test("取消预约未确认时保留夹具，不删除仍有有效预约的用户", async () => {
  const { calls, fetchImpl: baseFetch } = createFixtureFetch();
  const fetchImpl = async (url, init = {}) => {
    if (new URL(url).pathname === "/api/reservations/fixture-reservation/cancel") {
      const method = String(init.method ?? "GET").toUpperCase();
      calls.push({ path: new URL(url).pathname, method, body: undefined, headers: init.headers ?? {} });
      return jsonResponse(500);
    }
    return baseFetch(url, init);
  };

  await assert.rejects(
    () =>
      runPublicAppAcceptance({
        fetchImpl,
        publicApiBaseUrl,
        inputs: {
          adminPassword: "test-admin-password",
          manualCode: "314159"
        }
      }),
    /清理步骤未完整通过/u
  );

  assert.ok(
    calls.some(
      (call) => call.method === "POST" && call.path === "/api/reservations/fixture-reservation/cancel"
    )
  );
  assert.equal(
    calls.some((call) => call.method === "DELETE" && call.path === "/api/users/fixture-user"),
    false
  );
});

test("公网验收模块不读取环境、不控制服务，也不直接接触运行数据", () => {
  const source = readFileSync(resolve(import.meta.dirname, "public-app-acceptance.mjs"), "utf8");

  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(source, /systemctl|drop-in|InMemoryStoreService|API_DATA_FILE/u);
  assert.match(source, /https:\/\/vending\.5gogogo\.top\/api/u);
});
