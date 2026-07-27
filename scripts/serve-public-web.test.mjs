import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { tmpdir } from "node:os";

import {
  createPublicWebServer,
  resolvePublicWebApiRelayConfig,
  resolvePublicWebBindHost,
  resolvePublicWebPort,
  resolvePublicWebRoute
} from "./serve-public-web.mjs";

test("pure router keeps mobile and admin namespaces separate", () => {
  assert.deepEqual(
    resolvePublicWebRoute({ method: "GET", requestTarget: "/mobile?source=test" }),
    {
      kind: "redirect",
      status: 308,
      location: "/mobile/?source=test"
    }
  );
  assert.deepEqual(
    resolvePublicWebRoute({ method: "GET", requestTarget: "/mobile/" }),
    {
      kind: "file",
      root: "mobile",
      relativePath: "index.html",
      fallback: false
    }
  );
  assert.deepEqual(
    resolvePublicWebRoute({ method: "HEAD", requestTarget: "/mobile/assets/app.js" }),
    {
      kind: "file",
      root: "mobile",
      relativePath: "assets/app.js",
      fallback: false
    }
  );
  assert.deepEqual(
    resolvePublicWebRoute({ method: "GET", requestTarget: "/login" }),
    {
      kind: "file",
      root: "admin",
      relativePath: "login",
      fallback: true
    }
  );
  assert.equal(
    resolvePublicWebRoute({ method: "GET", requestTarget: "/mobile/unknown" }).status,
    404
  );
  for (const requestTarget of ["/api", "/api/health"]) {
    assert.deepEqual(
      resolvePublicWebRoute({ method: "GET", requestTarget }),
      {
        kind: "error",
        status: 404,
        message: "Not Found"
      }
    );
  }
});

test("pure router fails closed for writes, malformed paths, and traversal", () => {
  for (const requestTarget of [
    "//example.test/mobile/",
    "/mobile/assets/%ZZ",
    "/mobile/assets/%2e%2e/index.html",
    "/mobile/assets/%2Fetc/passwd",
    "/mobile/assets/%5Csecret",
    "/mobile/assets/\0secret"
  ]) {
    assert.equal(
      resolvePublicWebRoute({ method: "GET", requestTarget }).status,
      400,
      requestTarget
    );
  }

  const writeRoute = resolvePublicWebRoute({
    method: "POST",
    requestTarget: "/mobile/"
  });
  assert.equal(writeRoute.status, 405);
  assert.throws(() => resolvePublicWebPort("0"));
  assert.throws(() => resolvePublicWebPort("70000"));
  assert.equal(resolvePublicWebPort(undefined), 5795);
  assert.equal(resolvePublicWebPort("5797"), 5797);

  assert.equal(resolvePublicWebApiRelayConfig({}), undefined);
  assert.throws(
    () => resolvePublicWebApiRelayConfig({ PUBLIC_WEB_API_RELAY_ENABLED: "true" }),
    /ENABLED/u
  );
  assert.throws(
    () =>
      resolvePublicWebApiRelayConfig({
        PUBLIC_WEB_API_RELAY_ENABLED: "1",
        PUBLIC_WEB_API_RELAY_ALLOWED_SOURCES: "10.66.66.99",
        PUBLIC_WEB_API_RELAY_ALLOWED_HOST: "vending.5gogogo.top",
        PUBLIC_WEB_API_RELAY_CLIENT_IP_POLICY: "nginx-real-ip",
        PUBLIC_WEB_API_RELAY_UPSTREAM_HOST: "127.0.0.1",
        PUBLIC_WEB_API_RELAY_UPSTREAM_PORT: "8100"
      }),
    /ALLOWED_SOURCES/u
  );
  assert.deepEqual(
    resolvePublicWebApiRelayConfig({
      PUBLIC_WEB_API_RELAY_ENABLED: "1",
      PUBLIC_WEB_API_RELAY_ALLOWED_SOURCES: "10.66.66.1",
      PUBLIC_WEB_API_RELAY_ALLOWED_HOST: "vending.5gogogo.top",
      PUBLIC_WEB_API_RELAY_CLIENT_IP_POLICY: "nginx-real-ip",
      PUBLIC_WEB_API_RELAY_UPSTREAM_HOST: "127.0.0.1",
      PUBLIC_WEB_API_RELAY_UPSTREAM_PORT: "8100"
    }),
    {
      allowedSources: new Set(["10.66.66.1"]),
      host: "vending.5gogogo.top",
      clientIpPolicy: "nginx-real-ip",
      upstreamHost: "127.0.0.1",
      upstreamPort: 8100
    }
  );

  assert.equal(resolvePublicWebBindHost(undefined), "127.0.0.1");
  assert.equal(resolvePublicWebBindHost("10.66.66.2"), "10.66.66.2");
  assert.equal(resolvePublicWebBindHost("192.168.1.20"), "192.168.1.20");
  assert.equal(resolvePublicWebBindHost("172.16.0.1"), "172.16.0.1");
  assert.equal(resolvePublicWebBindHost("172.31.255.254"), "172.31.255.254");
  assert.equal(resolvePublicWebBindHost("::1"), "::1");
  for (const unsafeHost of [
    "0.0.0.0",
    "8.8.8.8",
    "0172.16.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "localhost"
  ]) {
    assert.throws(() => resolvePublicWebBindHost(unsafeHost), unsafeHost);
  }
});

const requestRaw = ({ port, method = "GET", path, headers, body = "" }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const currentRequest = request(
      {
        agent: false,
        host: "127.0.0.1",
        headers,
        method,
        path,
        port
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolveResponse({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode
          });
        });
      }
    );
    currentRequest.once("error", rejectResponse);
    currentRequest.end(body);
  });

let temporaryRoot;
let server;
let port;

before(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "vm-public-web-"));
  const adminRoot = join(temporaryRoot, "admin");
  const mobileRoot = join(temporaryRoot, "mobile");
  await mkdir(join(adminRoot, "assets"), { recursive: true });
  await mkdir(join(mobileRoot, "assets"), { recursive: true });
  await writeFile(join(adminRoot, "index.html"), "<title>ADMIN</title>");
  await writeFile(join(adminRoot, "assets", "admin.css"), "body{color:#123}");
  await writeFile(join(mobileRoot, "index.html"), "<title>MOBILE</title>");
  await writeFile(join(mobileRoot, "assets", "mobile.js"), "globalThis.mobile=true;");

  server = await createPublicWebServer({ adminRoot, mobileRoot });
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  port = server.address().port;
});

after(async () => {
  if (server) {
    await new Promise((resolveClosed, rejectClosed) =>
      server.close((error) => error ? rejectClosed(error) : resolveClosed())
    );
  }
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("integration serves both SPAs and their assets with safe headers", async () => {
  const root = await requestRaw({ port, path: "/" });
  const login = await requestRaw({ port, path: "/login" });
  const mapAcceptance = await requestRaw({ port, path: "/__acceptance/map" });
  const mobileRedirect = await requestRaw({ port, path: "/mobile" });
  const mobile = await requestRaw({ port, path: "/mobile/" });
  const mobileAsset = await requestRaw({ port, path: "/mobile/assets/mobile.js" });
  const adminAsset = await requestRaw({ port, path: "/assets/admin.css" });
  const apiRoute = await requestRaw({ port, path: "/api/health" });
  const apiHead = await requestRaw({ port, method: "HEAD", path: "/api/health" });

  for (const response of [root, login, mapAcceptance]) {
    assert.equal(response.status, 200);
    assert.match(response.body, /<title>ADMIN<\/title>/);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal(mobileRedirect.status, 308);
  assert.equal(mobileRedirect.headers.location, "/mobile/");
  assert.equal(mobile.status, 200);
  assert.match(mobile.body, /<title>MOBILE<\/title>/);
  assert.equal(mobile.headers["cache-control"], "no-store");
  assert.equal(mobileAsset.status, 200);
  assert.equal(mobileAsset.body, "globalThis.mobile=true;");
  assert.match(mobileAsset.headers["content-type"], /^text\/javascript/);
  assert.equal(mobileAsset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(adminAsset.status, 200);
  assert.match(adminAsset.headers["content-type"], /^text\/css/);
  assert.equal(apiRoute.status, 404);
  assert.equal(apiRoute.headers["cache-control"], "no-store");
  assert.doesNotMatch(apiRoute.body, /ADMIN/);
  assert.equal(apiHead.status, 404);
  assert.equal(apiHead.body, "");
});

test("integration returns HEAD without a body and rejects unsafe requests", async () => {
  const head = await requestRaw({
    port,
    method: "HEAD",
    path: "/mobile/assets/mobile.js"
  });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength("globalThis.mobile=true;"));

  const write = await requestRaw({
    port,
    method: "POST",
    path: "/mobile/"
  });
  assert.equal(write.status, 405);
  assert.equal(write.headers.allow, "GET, HEAD");

  const traversal = await requestRaw({
    port,
    path: "/mobile/assets/%2e%2e/index.html"
  });
  assert.equal(traversal.status, 400);

  const missingMobileAsset = await requestRaw({
    port,
    path: "/mobile/assets/missing.js"
  });
  assert.equal(missingMobileAsset.status, 404);
  assert.doesNotMatch(missingMobileAsset.body, /ADMIN/);

  const missingAdminAsset = await requestRaw({
    port,
    path: "/assets/missing.js"
  });
  assert.equal(missingAdminAsset.status, 404);
  assert.doesNotMatch(missingAdminAsset.body, /ADMIN/);
});

test("API relay stays closed to non-VNC sources", async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  });
  await new Promise((resolveListening) => upstream.listen(0, "127.0.0.1", resolveListening));
  t.after(
    () => new Promise((resolveClosed, rejectClosed) =>
      upstream.close((error) => (error ? rejectClosed(error) : resolveClosed()))
    )
  );

  const restrictedServer = await createPublicWebServer({
    adminRoot: join(temporaryRoot, "admin"),
    mobileRoot: join(temporaryRoot, "mobile"),
    apiRelay: {
      allowedSources: new Set(["10.66.66.1"]),
      clientIpPolicy: "nginx-real-ip",
      host: "vending.5gogogo.top",
      upstreamHost: "127.0.0.1",
      upstreamPort: upstream.address().port
    }
  });
  await new Promise((resolveListening) => restrictedServer.listen(0, "127.0.0.1", resolveListening));
  t.after(
    () => new Promise((resolveClosed, rejectClosed) =>
      restrictedServer.close((error) => (error ? rejectClosed(error) : resolveClosed()))
    )
  );

  const response = await requestRaw({
    port: restrictedServer.address().port,
    path: "/api/health",
    headers: { "X-Real-IP": "198.51.100.13" }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body, "");
  assert.equal(upstreamRequests, 0);
});

test("API relay proxies only an authorized VNC peer and rebuilds forwarding headers", async (t) => {
  const received = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        forwarded: request.headers.forwarded,
        forwardedFor: request.headers["x-forwarded-for"],
        forwardedHost: request.headers["x-forwarded-host"],
        forwardedProto: request.headers["x-forwarded-proto"],
        host: request.headers.host,
        realIp: request.headers["x-real-ip"],
        relayControl: request.headers["x-vending-relay-client-ip"],
        retained: request.headers["x-retained-header"],
        path: request.url
      });
      response.writeHead(201, { "X-Relay-Test": "ok" });
      response.end("proxied");
    });
  });
  await new Promise((resolveListening) => upstream.listen(0, "127.0.0.1", resolveListening));
  t.after(
    () => new Promise((resolveClosed, rejectClosed) =>
      upstream.close((error) => (error ? rejectClosed(error) : resolveClosed()))
    )
  );

  const relayServer = await createPublicWebServer({
    adminRoot: join(temporaryRoot, "admin"),
    mobileRoot: join(temporaryRoot, "mobile"),
    apiRelay: {
      allowedSources: new Set(["127.0.0.1"]),
      clientIpPolicy: "nginx-real-ip",
      host: "vending.5gogogo.top",
      upstreamHost: "127.0.0.1",
      upstreamPort: upstream.address().port
    }
  });
  await new Promise((resolveListening) => relayServer.listen(0, "127.0.0.1", resolveListening));
  t.after(
    () => new Promise((resolveClosed, rejectClosed) =>
      relayServer.close((error) => (error ? rejectClosed(error) : resolveClosed()))
    )
  );

  const apiResponse = await requestRaw({
    port: relayServer.address().port,
    method: "POST",
    path: "/api/example?mode=manual",
    headers: {
      "Content-Type": "application/json",
      Forwarded: "for=203.0.113.9;proto=http",
      "X-Forwarded-For": "203.0.113.9",
      "X-Forwarded-Host": "attacker.invalid",
      "X-Forwarded-Proto": "http",
      "X-Real-IP": "198.51.100.13",
      "X-Retained-Header": "kept",
      "X-Vending-Relay-Client-IP": "203.0.113.9"
    },
    body: '{"purpose":"app-login"}'
  });
  const apiBaseResponse = await requestRaw({
    port: relayServer.address().port,
    path: "/api",
    headers: { "X-Real-IP": "198.51.100.13" }
  });
  const fallbackClientIpResponse = await requestRaw({
    port: relayServer.address().port,
    path: "/api/health"
  });
  const staticResponse = await requestRaw({ port: relayServer.address().port, path: "/login" });

  assert.equal(apiResponse.status, 201);
  assert.equal(apiResponse.body, "proxied");
  assert.equal(apiResponse.headers["x-relay-test"], "ok");
  assert.equal(apiBaseResponse.status, 201);
  assert.equal(fallbackClientIpResponse.status, 201);
  assert.deepEqual(received[0], {
    body: '{"purpose":"app-login"}',
    forwarded: undefined,
    forwardedFor: "198.51.100.13",
    forwardedHost: "vending.5gogogo.top",
    forwardedProto: "https",
    host: "vending.5gogogo.top",
    realIp: undefined,
    relayControl: undefined,
    retained: "kept",
    path: "/api/example?mode=manual"
  });
  assert.equal(received[1].path, "/api");
  assert.equal(received[2].path, "/api/health");
  assert.equal(received[2].forwardedFor, "127.0.0.1");
  assert.equal(staticResponse.status, 200);
  assert.match(staticResponse.body, /<title>ADMIN<\/title>/);
});
