import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import {
  createPrivateApiRelayServer,
  resolvePrivateApiRelayConfig
} from "./serve-private-api-relay.mjs";

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
      {
        host: "127.0.0.1",
        port,
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

const trustedRelayHeaders = {
  "X-Vending-Relay-Client-IP": "198.51.100.13",
  "X-Vending-Relay-Host": "vending.5gogogo.top",
  "X-Vending-Relay-Proto": "https"
};

const testRelayConfig = (overrides = {}) =>
  resolvePrivateApiRelayConfig({
    PRIVATE_API_RELAY_BIND_HOST: "127.0.0.1",
    PRIVATE_API_RELAY_ALLOWED_SOURCES: "127.0.0.1",
    PRIVATE_API_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top",
    PRIVATE_API_RELAY_UPSTREAM_HOST: "127.0.0.1",
    ...overrides
  });

test("private API relay requires an explicit private source and public host allowlist", () => {
  assert.deepEqual(
    resolvePrivateApiRelayConfig({
      PRIVATE_API_RELAY_BIND_HOST: "10.66.66.2",
      PRIVATE_API_RELAY_PORT: "8100",
      PRIVATE_API_RELAY_ALLOWED_SOURCES: "10.66.66.1",
      PRIVATE_API_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top"
    }),
    {
      bindHost: "10.66.66.2",
      port: 8100,
      allowedSources: new Set(["10.66.66.1"]),
      allowedHosts: new Set(["vending.5gogogo.top"]),
      healthProbeSource: undefined,
      upstreamHost: "127.0.0.1",
      upstreamPort: 8100
    }
  );

  assert.throws(
    () =>
      resolvePrivateApiRelayConfig({
        PRIVATE_API_RELAY_BIND_HOST: "10.66.66.2",
        PRIVATE_API_RELAY_ALLOWED_SOURCES: "10.66.66.1"
      }),
    /ALLOWED_HOSTS/u
  );
  assert.throws(
    () =>
      resolvePrivateApiRelayConfig({
        PRIVATE_API_RELAY_BIND_HOST: "10.66.66.2",
        PRIVATE_API_RELAY_ALLOWED_SOURCES: "8.8.8.8",
        PRIVATE_API_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top"
      }),
    /private/u
  );
  assert.throws(
    () =>
      resolvePrivateApiRelayConfig({
        PRIVATE_API_RELAY_BIND_HOST: "10.66.66.2",
        PRIVATE_API_RELAY_ALLOWED_SOURCES: "10.66.66.1",
        PRIVATE_API_RELAY_ALLOWED_HOSTS: "vending.5gogogo.top",
        PRIVATE_API_RELAY_UPSTREAM_HOST: "10.66.66.2"
      }),
    /loopback/u
  );
});

test("private API relay permits its local health gateway only for two fixed GET paths", async () => {
  const receivedRequests = [];
  const upstream = createServer((incoming, response) => {
    receivedRequests.push({
      path: incoming.url,
      forwardedFor: incoming.headers["x-forwarded-for"],
      forwardedHost: incoming.headers["x-forwarded-host"],
      forwardedProto: incoming.headers["x-forwarded-proto"]
    });
    response.end("healthy");
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const relay = createPrivateApiRelayServer(
    testRelayConfig({
      PRIVATE_API_RELAY_UPSTREAM_PORT: String(upstreamPort),
      PRIVATE_API_RELAY_HEALTH_PROBE_SOURCE: "127.0.0.1"
    })
  );
  await listen(relay);

  try {
    const allowedHealth = await send({
      port: relay.address().port,
      path: "/api/health"
    });
    const allowedReadiness = await send({
      port: relay.address().port,
      path: "/api/health/production-readiness"
    });
    const deniedApi = await send({
      port: relay.address().port,
      path: "/api/private",
      headers: trustedRelayHeaders
    });
    const deniedHealthQuery = await send({
      port: relay.address().port,
      path: "/api/health?spoof=1"
    });

    assert.equal(allowedHealth.status, 200);
    assert.equal(allowedReadiness.status, 200);
    assert.equal(deniedApi.status, 403);
    assert.equal(deniedHealthQuery.status, 403);
    assert.deepEqual(receivedRequests, [
      {
        path: "/api/health",
        forwardedFor: "127.0.0.1",
        forwardedHost: "vending.5gogogo.top",
        forwardedProto: "https"
      },
      {
        path: "/api/health/production-readiness",
        forwardedFor: "127.0.0.1",
        forwardedHost: "vending.5gogogo.top",
        forwardedProto: "https"
      }
    ]);
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("private API relay streams an allowed request and replaces all forwarding headers", async () => {
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
        forwarded: incoming.headers.forwarded,
        forwardedFor: incoming.headers["x-forwarded-for"],
        forwardedHost: incoming.headers["x-forwarded-host"],
        forwardedProto: incoming.headers["x-forwarded-proto"],
        realIp: incoming.headers["x-real-ip"],
        relayControl: incoming.headers["x-vending-relay-client-ip"]
      };
      response.writeHead(201, { "X-Relay-Test": "ok" });
      response.end("upstream-ok");
    });
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const relay = createPrivateApiRelayServer(
    testRelayConfig({ PRIVATE_API_RELAY_UPSTREAM_PORT: String(upstreamPort) })
  );
  await listen(relay);

  try {
    const response = await send({
      port: relay.address().port,
      method: "POST",
      path: "/api/example?mode=manual",
      headers: {
        "Content-Type": "application/json",
        ...trustedRelayHeaders,
        Forwarded: "for=203.0.113.9;proto=http",
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Host": "attacker.invalid",
        "X-Forwarded-Proto": "http",
        "X-Real-IP": "203.0.113.9"
      },
      body: '{"purpose":"app-login"}'
    });

    assert.equal(response.status, 201);
    assert.equal(response.body, "upstream-ok");
    assert.equal(response.headers["x-relay-test"], "ok");
    assert.deepEqual(received, {
      method: "POST",
      path: "/api/example?mode=manual",
      body: '{"purpose":"app-login"}',
      host: "vending.5gogogo.top",
      forwarded: undefined,
      forwardedFor: "198.51.100.13",
      forwardedHost: "vending.5gogogo.top",
      forwardedProto: "https",
      realIp: undefined,
      relayControl: undefined
    });
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("private API relay rejects untrusted peers or incomplete relay control headers before upstream", async () => {
  let upstreamRequests = 0;
  const upstream = createServer((_incoming, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const localRelay = createPrivateApiRelayServer(
    testRelayConfig({
      PRIVATE_API_RELAY_UPSTREAM_PORT: String(upstreamPort),
      PRIVATE_API_RELAY_ALLOWED_SOURCES: "10.66.66.1"
    })
  );
  const missingControlRelay = createPrivateApiRelayServer(
    testRelayConfig({ PRIVATE_API_RELAY_UPSTREAM_PORT: String(upstreamPort) })
  );
  await listen(localRelay);
  await listen(missingControlRelay);

  try {
    const deniedPeer = await send({
      port: localRelay.address().port,
      headers: trustedRelayHeaders
    });
    const incompleteHeaders = await send({
      port: missingControlRelay.address().port,
      headers: { "X-Vending-Relay-Host": "vending.5gogogo.top" }
    });

    assert.equal(deniedPeer.status, 403);
    assert.equal(deniedPeer.body, "");
    assert.equal(incompleteHeaders.status, 403);
    assert.equal(incompleteHeaders.body, "");
    assert.equal(upstreamRequests, 0);
  } finally {
    await close(localRelay);
    await close(missingControlRelay);
    await close(upstream);
  }
});

test("private API relay returns an empty 502 when the loopback API is unavailable", async () => {
  const unavailableUpstream = createServer();
  await listen(unavailableUpstream);
  const unavailablePort = unavailableUpstream.address().port;
  await close(unavailableUpstream);

  const relay = createPrivateApiRelayServer(
    testRelayConfig({ PRIVATE_API_RELAY_UPSTREAM_PORT: String(unavailablePort) })
  );
  await listen(relay);

  try {
    const response = await send({
      port: relay.address().port,
      headers: trustedRelayHeaders
    });
    assert.equal(response.status, 502);
    assert.equal(response.body, "");
  } finally {
    await close(relay);
  }
});

test("private API relay closes the loopback response when its downstream client disconnects", async () => {
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
  const relay = createPrivateApiRelayServer(
    testRelayConfig({ PRIVATE_API_RELAY_UPSTREAM_PORT: String(upstream.address().port) })
  );
  await listen(relay);

  try {
    await new Promise((resolveClosed, rejectClosed) => {
      const clientRequest = request(
        { host: "127.0.0.1", port: relay.address().port, path: "/api/health", headers: trustedRelayHeaders },
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
