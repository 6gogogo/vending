import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import {
  createPublicEdgeRelayServer,
  resolvePublicEdgeRelayConfig
} from "./serve-public-edge-relay.mjs";

const listen = (server) =>
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

const send = ({ port, method = "GET", path = "/", headers, body = "" }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const clientRequest = request(
      { host: "127.0.0.1", port, method, path, headers },
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

const edgeConfig = (overrides = {}) =>
  resolvePublicEdgeRelayConfig({
    PUBLIC_EDGE_RELAY_MODE: "api",
    PUBLIC_EDGE_RELAY_BIND_HOST: "127.0.0.1",
    PUBLIC_EDGE_RELAY_PORT: "4000",
    PUBLIC_EDGE_RELAY_UPSTREAM_HOST: "10.66.66.2",
    PUBLIC_EDGE_RELAY_UPSTREAM_PORT: "8100",
    PUBLIC_EDGE_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top",
    ...overrides
  });

const nginxHeaders = {
  Host: "vending.5gogogo.top",
  "X-Real-IP": "198.51.100.13",
  "X-Forwarded-Proto": "https"
};

test("public edge relay requires a loopback listener and private upstream", () => {
  assert.deepEqual(edgeConfig(), {
    mode: "api",
    bindHost: "127.0.0.1",
    port: 4000,
    upstreamHost: "10.66.66.2",
    upstreamPort: 8100,
    allowedHosts: new Set(["vending.5gogogo.top"])
  });
  assert.throws(
    () => edgeConfig({ PUBLIC_EDGE_RELAY_BIND_HOST: "0.0.0.0" }),
    /loopback/u
  );
  assert.throws(
    () => edgeConfig({ PUBLIC_EDGE_RELAY_BIND_HOST: "localhost" }),
    /loopback/u
  );
  assert.throws(
    () => edgeConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_HOST: "198.51.100.9" }),
    /RFC1918/u
  );
});

test("API edge relay streams Nginx requests and replaces client forwarding headers", async () => {
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
        relayProto: incoming.headers["x-vending-relay-proto"]
      };
      response.writeHead(201, { "X-Edge-Test": "ok" });
      response.end("upstream-ok");
    });
  });
  await listen(upstream);
  const relay = createPublicEdgeRelayServer({
    ...edgeConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  await listen(relay);

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
      relayProto: "https"
    });
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("API edge relay rejects missing Nginx controls before upstream", async () => {
  let upstreamRequests = 0;
  const upstream = createServer((_incoming, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  });
  await listen(upstream);
  const relay = createPublicEdgeRelayServer({
    ...edgeConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  await listen(relay);

  try {
    const missingRealIp = await send({
      port: relay.address().port,
      headers: { Host: "vending.5gogogo.top", "X-Forwarded-Proto": "https" }
    });
    const insecureProto = await send({
      port: relay.address().port,
      headers: { ...nginxHeaders, "X-Forwarded-Proto": "http" }
    });
    assert.equal(missingRealIp.status, 403);
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
  await listen(upstream);
  const relay = createPublicEdgeRelayServer({
    ...edgeConfig({
      PUBLIC_EDGE_RELAY_MODE: "static",
      PUBLIC_EDGE_RELAY_PORT: "5795",
      PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port)
    }),
    upstreamHost: "127.0.0.1"
  });
  await listen(relay);

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
  await listen(unavailableUpstream);
  const unavailablePort = unavailableUpstream.address().port;
  await close(unavailableUpstream);

  const relay = createPublicEdgeRelayServer({
    ...edgeConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(unavailablePort) }),
    upstreamHost: "127.0.0.1"
  });
  await listen(relay);

  try {
    const response = await send({
      port: relay.address().port,
      headers: nginxHeaders
    });
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
  await listen(upstream);
  const relay = createPublicEdgeRelayServer({
    ...edgeConfig({ PUBLIC_EDGE_RELAY_UPSTREAM_PORT: String(upstream.address().port) }),
    upstreamHost: "127.0.0.1"
  });
  await listen(relay);

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
