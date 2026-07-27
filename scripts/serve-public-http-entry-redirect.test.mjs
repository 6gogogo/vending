import assert from "node:assert/strict";
import { request } from "node:http";
import { createConnection } from "node:net";
import test from "node:test";

import {
  createPublicHttpEntryRedirectServer,
  resolvePublicHttpEntryRedirectConfig
} from "./serve-public-http-entry-redirect.mjs";

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

const send = ({ port, method = "GET", path = "/", headers }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const clientRequest = request(
      { host: "127.0.0.1", port, method, path, headers },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolveResponse({ status: response.statusCode, headers: response.headers })
        );
      }
    );
    clientRequest.once("error", rejectResponse);
    clientRequest.end();
  });

const sendRaw = ({ port, rawPath, host }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.once("error", rejectResponse);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("connect", () => {
      socket.end(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.once("close", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      resolveResponse({ status: Number(/^HTTP\/1\.1\s+(\d{3})\b/u.exec(response)?.[1]) });
    });
  });

const redirectConfig = (overrides = {}) =>
  resolvePublicHttpEntryRedirectConfig({
    PUBLIC_HTTP_ENTRY_REDIRECT_BIND_HOST: "127.0.0.1",
    PUBLIC_HTTP_ENTRY_REDIRECT_PORT: "5795",
    PUBLIC_HTTP_ENTRY_REDIRECT_ALLOWED_HOSTS: "5gogogo.top",
    PUBLIC_HTTP_ENTRY_REDIRECT_CANONICAL_HTTPS_URL: "https://vending.5gogogo.top/",
    ...overrides
  });

test("public HTTP entry redirect only binds a private address and fixed HTTPS origin", () => {
  assert.deepEqual(redirectConfig(), {
    bindHost: "127.0.0.1",
    port: 5795,
    allowedHosts: new Set(["5gogogo.top"]),
    canonicalHttpsOrigin: "https://vending.5gogogo.top"
  });
  assert.throws(
    () => redirectConfig({ PUBLIC_HTTP_ENTRY_REDIRECT_BIND_HOST: "0.0.0.0" }),
    /loopback or RFC1918/u
  );
  assert.throws(
    () =>
      redirectConfig({
        PUBLIC_HTTP_ENTRY_REDIRECT_CANONICAL_HTTPS_URL: "http://vending.5gogogo.top/"
      }),
    /credential-free HTTPS origin/u
  );
  assert.throws(
    () =>
      redirectConfig({
        PUBLIC_HTTP_ENTRY_REDIRECT_CANONICAL_HTTPS_URL: "https://user@example.invalid/"
      }),
    /credential-free HTTPS origin/u
  );
});

test("public HTTP entry redirects only safe navigation requests to the fixed HTTPS host", async () => {
  const server = createPublicHttpEntryRedirectServer(redirectConfig());
  await listen(server);
  try {
    const port = server.address().port;
    const allowed = await send({
      port,
      path: "/",
      headers: { Host: `5gogogo.top:${port}` }
    });
    const wrongHost = await send({
      port,
      path: "/",
      headers: { Host: "attacker.invalid" }
    });
    const nonRootTarget = await send({
      port,
      path: "/login?next=%2Fdashboard",
      headers: { Host: `5gogogo.top:${port}` }
    });
    const backslashTarget = await sendRaw({
      port,
      rawPath: "/\\attacker.invalid/path",
      host: `5gogogo.top:${port}`
    });
    const writeAttempt = await send({
      port,
      method: "POST",
      path: "/api/auth/login",
      headers: { Host: `5gogogo.top:${port}` }
    });

    assert.equal(allowed.status, 308);
    assert.equal(allowed.headers.location, "https://vending.5gogogo.top/");
    assert.equal(wrongHost.status, 403);
    assert.equal(nonRootTarget.status, 404);
    assert.equal(backslashTarget.status, 404);
    assert.equal(writeAttempt.status, 405);
    assert.equal(writeAttempt.headers.allow, "GET, HEAD");
  } finally {
    await close(server);
  }
});
