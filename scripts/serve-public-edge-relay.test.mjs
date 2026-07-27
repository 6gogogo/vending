import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createPublicEdgeRelayServer,
  isAllowedTokenParentDirectory,
  listenPublicEdgeRelay,
  resolvePublicEdgeRelayConfig
} from "./serve-public-edge-relay.mjs";

const defaultTokenDirectory = mkdtempSync(join(tmpdir(), "vm-public-edge-default-token-"));
const defaultTokenFile = join(defaultTokenDirectory, "relay-token");
const defaultSocketDirectory = mkdtempSync(join(tmpdir(), "vm-public-edge-socket-"));
const defaultSocketPath = join(defaultSocketDirectory, "api-edge.sock");
const defaultSharedToken = "test-shared-token-012345678901234567890123456789";
writeFileSync(defaultTokenFile, defaultSharedToken, { encoding: "utf8", mode: 0o600 });
if (process.platform !== "win32") {
  chmodSync(defaultTokenFile, 0o600);
  chmodSync(defaultSocketDirectory, 0o2710);
}
process.once("exit", () => {
  rmSync(defaultTokenDirectory, { recursive: true, force: true });
  rmSync(defaultSocketDirectory, { recursive: true, force: true });
});

const listenTcp = (server) =>
  new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

const close = (server) =>
  new Promise((resolveClosed, rejectClosed) =>
    server.close((error) => (error ? rejectClosed(error) : resolveClosed()))
  );

const send = ({ port, socketPath, method = "GET", path = "/", headers, body = "" }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const clientRequest = request(
      {
        ...(socketPath ? { socketPath } : { host: "127.0.0.1", port }),
        method,
        path,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers
          })
        );
      }
    );
    clientRequest.once("error", rejectResponse);
    clientRequest.end(body);
  });

const apiConfig = (overrides = {}) =>
  resolvePublicEdgeRelayConfig({
    PUBLIC_EDGE_RELAY_MODE: "api",
    PUBLIC_EDGE_RELAY_SOCKET_DIRECTORY: defaultSocketDirectory,
    PUBLIC_EDGE_RELAY_SOCKET_PATH: defaultSocketPath,
    PUBLIC_EDGE_RELAY_UPSTREAM_HOST: "10.66.66.2",
    PUBLIC_EDGE_RELAY_UPSTREAM_PORT: "8100",
    PUBLIC_EDGE_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top",
    PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE: defaultTokenFile,
    ...overrides
  });

const staticConfig = (overrides = {}) =>
  resolvePublicEdgeRelayConfig({
    PUBLIC_EDGE_RELAY_MODE: "static",
    PUBLIC_EDGE_RELAY_BIND_HOST: "127.0.0.1",
    PUBLIC_EDGE_RELAY_PORT: "5795",
    PUBLIC_EDGE_RELAY_UPSTREAM_HOST: "10.66.66.2",
    PUBLIC_EDGE_RELAY_UPSTREAM_PORT: "5795",
    PUBLIC_EDGE_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top",
    ...overrides
  });

const nginxHeaders = {
  Host: "vending.5gogogo.top",
  "X-Real-IP": "198.51.100.13",
  "X-Forwarded-Proto": "https"
};

test("服务令牌目录只接受服务私有目录或 root 管理的 vnc 可遍历目录", () => {
  const serviceUserId = 1001;
  const serviceGroupId = 1001;
  const directory = (uid, gid, mode) => ({ uid, gid, mode });

  assert.equal(
    isAllowedTokenParentDirectory(directory(serviceUserId, serviceGroupId, 0o700), serviceUserId, serviceGroupId),
    true
  );
  assert.equal(
    isAllowedTokenParentDirectory(directory(0, serviceGroupId, 0o710), serviceUserId, serviceGroupId),
    true
  );
  assert.equal(
    isAllowedTokenParentDirectory(directory(0, serviceGroupId, 0o750), serviceUserId, serviceGroupId),
    false
  );
  assert.equal(
    isAllowedTokenParentDirectory(directory(0, 0, 0o710), serviceUserId, serviceGroupId),
    false
  );
});

test("API edge requires a controlled Unix socket while static mode remains loopback-only", () => {
  assert.deepEqual(apiConfig(), {
    mode: "api",
    bindHost: undefined,
    port: undefined,
    upstreamHost: "10.66.66.2",
    upstreamPort: 8100,
    allowedHosts: new Set(["vending.5gogogo.top"]),
    socketDirectory: resolve(defaultSocketDirectory),
    socketPath: resolve(defaultSocketPath),
    socketMode: 0o660,
    sharedToken: defaultSharedToken
  });
  assert.throws(
    () => apiConfig({ PUBLIC_EDGE_RELAY_SOCKET_PATH: "" }),
    /SOCKET_PATH and PUBLIC_EDGE_RELAY_SOCKET_DIRECTORY are required/u
  );
  assert.throws(
    () =>
      apiConfig({
        PUBLIC_EDGE_RELAY_SOCKET_PATH: join(defaultSocketDirectory, "nested", "api-edge.sock")
      }),
    /direct .sock child/u
  );
  assert.throws(
    () => apiConfig({ PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE: "" }),
    /SHARED_TOKEN_FILE is required/u
  );
  assert.throws(
    () => apiConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_HOST: "198.51.100.9" }),
    /RFC1918/u
  );
  assert.throws(
    () => staticConfig({ PUBLIC_EDGE_RELAY_BIND_HOST: "0.0.0.0" }),
    /loopback/u
  );
});

test(
  "API edge rejects symlinked or writable token parent chains",
  { skip: process.platform === "win32" },
  (t) => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "vm-public-edge-token-chain-"));
    const tokenDirectory = join(rootDirectory, "private");
    const linkedDirectory = join(rootDirectory, "linked");
    const tokenFile = join(tokenDirectory, "relay-token");
    mkdirSync(tokenDirectory, { mode: 0o700 });
    writeFileSync(tokenFile, defaultSharedToken, { encoding: "utf8", mode: 0o600 });
    chmodSync(tokenDirectory, 0o700);
    chmodSync(tokenFile, 0o600);
    symlinkSync(tokenDirectory, linkedDirectory, "dir");
    t.after(() => {
      chmodSync(rootDirectory, 0o700);
      rmSync(rootDirectory, { recursive: true, force: true });
    });

    assert.throws(
      () =>
        apiConfig({ PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE: join(linkedDirectory, "relay-token") }),
      /parent chain must contain only directories/u
    );

    chmodSync(rootDirectory, 0o720);
    assert.throws(
      () => apiConfig({ PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE: tokenFile }),
      /parent chain must not be group- or world-writable/u
    );
  }
);

test("API edge streams only authenticated Nginx socket headers and replaces forwarding controls", async () => {
  let received;
  const upstream = createServer((incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      received = {
        method: incoming.method,
        path: incoming.url,
        body: Buffer.concat(chunks).toString("utf8"),
        host: incoming.headers.host,
        realIp: incoming.headers["x-real-ip"],
        forwardedFor: incoming.headers["x-forwarded-for"],
        relayClientIp: incoming.headers["x-vending-relay-client-ip"],
        relayHost: incoming.headers["x-vending-relay-host"],
        relayProto: incoming.headers["x-vending-relay-proto"],
        relaySharedToken: incoming.headers["x-vending-relay-shared-token"]
      };
      response.writeHead(201, { "X-Edge-Test": "ok" });
      response.end("upstream-ok");
    });
  });
  await listenTcp(upstream);
  const relay = createPublicEdgeRelayServer({
    ...apiConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  // 该跨平台单测仅通过 TCP 覆盖处理器行为；
  // 生产 API 模式只能经 listenPublicEdgeRelay 的 Unix socket 路径启动。
  await listenTcp(relay);

  try {
    const response = await send({
      port: relay.address().port,
      method: "POST",
      path: "/api/example?mode=manual",
      headers: {
        ...nginxHeaders,
        "Content-Type": "application/json",
        Forwarded: "for=203.0.113.9;proto=http",
        "X-Forwarded-For": "203.0.113.9",
        "X-Vending-Relay-Client-IP": "203.0.113.9"
      },
      body: '{"mode":"manual"}'
    });

    assert.equal(response.status, 201);
    assert.equal(response.body, "upstream-ok");
    assert.equal(response.headers["x-edge-test"], "ok");
    assert.deepEqual(received, {
      method: "POST",
      path: "/api/example?mode=manual",
      body: '{"mode":"manual"}',
      host: "vending.5gogogo.top",
      realIp: undefined,
      forwardedFor: undefined,
      relayClientIp: "198.51.100.13",
      relayHost: "vending.5gogogo.top",
      relayProto: "https",
      relaySharedToken: defaultSharedToken
    });
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("API edge rejects missing or insecure Nginx controls before upstream", async () => {
  let upstreamRequests = 0;
  const upstream = createServer((_incoming, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  });
  await listenTcp(upstream);
  const relay = createPublicEdgeRelayServer({
    ...apiConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  await listenTcp(relay);

  try {
    const missingIp = await send({
      port: relay.address().port,
      headers: { Host: "vending.5gogogo.top", "X-Forwarded-Proto": "https" }
    });
    const insecureProto = await send({
      port: relay.address().port,
      headers: { ...nginxHeaders, "X-Forwarded-Proto": "http" }
    });
    assert.equal(missingIp.status, 403);
    assert.equal(insecureProto.status, 403);
    assert.equal(upstreamRequests, 0);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("static edge relay streams only after validating its public host", async () => {
  let received;
  const upstream = createServer((incoming, response) => {
    received = { path: incoming.url, host: incoming.headers.host };
    response.end("static-ok");
  });
  await listenTcp(upstream);
  const relay = createPublicEdgeRelayServer({
    ...staticConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  await listenTcp(relay);

  try {
    const allowed = await send({
      port: relay.address().port,
      path: "/mobile/",
      headers: { Host: "vending.5gogogo.top" }
    });
    const denied = await send({
      port: relay.address().port,
      path: "/",
      headers: { Host: "attacker.invalid" }
    });
    const apiRoute = await send({
      port: relay.address().port,
      path: "/api/health",
      headers: { Host: "vending.5gogogo.top" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "static-ok");
    assert.equal(denied.status, 403);
    assert.equal(apiRoute.status, 404);
    assert.deepEqual(received, { path: "/mobile/", host: "vending.5gogogo.top" });
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("public edge relay returns an empty 502 when Spark is unavailable", async () => {
  const unavailableUpstream = createServer();
  await listenTcp(unavailableUpstream);
  const unavailablePort = unavailableUpstream.address().port;
  await close(unavailableUpstream);

  const relay = createPublicEdgeRelayServer({
    ...apiConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(unavailablePort) }),
    upstreamHost: "127.0.0.1"
  });
  await listenTcp(relay);

  try {
    const response = await send({ port: relay.address().port, headers: nginxHeaders });
    assert.equal(response.status, 502);
    assert.equal(response.body, "");
  } finally {
    await close(relay);
  }
});

test("public edge relay closes the Spark response when its downstream client disconnects", async () => {
  let activeResponse;
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolveClosed) => {
    resolveUpstreamClosed = resolveClosed;
  });
  const upstream = createServer((_incoming, response) => {
    activeResponse = response;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("first");
    response.once("close", resolveUpstreamClosed);
  });
  await listenTcp(upstream);
  const relay = createPublicEdgeRelayServer({
    ...apiConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  await listenTcp(relay);

  try {
    await new Promise((resolveClosed, rejectClosed) => {
      const clientRequest = request(
        { host: "127.0.0.1", port: relay.address().port, path: "/", headers: nginxHeaders },
        (response) => {
          response.once("data", () => response.destroy());
        }
      );
      clientRequest.once("error", () => {});
      clientRequest.end();

      const timeout = setTimeout(() => rejectClosed(new Error("upstream response stayed open")), 1_000);
      upstreamClosed.then(() => {
        clearTimeout(timeout);
        resolveClosed();
      });
    });
  } finally {
    activeResponse?.destroy();
    await close(relay);
    await close(upstream);
  }
});

test(
  "API edge creates a group-restricted Unix socket only in the controlled directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "vm-public-edge-listen-"));
    const socketPath = join(directory, "api-edge.sock");
    chmodSync(directory, 0o2710);
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const upstream = createServer((_incoming, response) => response.end("socket-ok"));
    await listenTcp(upstream);
    t.after(() => close(upstream));

    const config = apiConfig({
      PUBLIC_EDGE_RELAY_SOCKET_DIRECTORY: directory,
      PUBLIC_EDGE_RELAY_SOCKET_PATH: socketPath,
      PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port)
    });
    const relay = createPublicEdgeRelayServer({ ...config, upstreamHost: "127.0.0.1" });
    await listenPublicEdgeRelay(relay, config);
    t.after(() => close(relay));

    const socketMetadata = statSync(socketPath);
    assert.equal(socketMetadata.mode & 0o007, 0);
    assert.equal(socketMetadata.gid, statSync(directory).gid);
    const response = await send({ socketPath, headers: nginxHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.body, "socket-ok");
  }
);
