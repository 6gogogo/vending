import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { tmpdir } from "node:os";

import {
  createPublicWebServer,
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
});

const requestRaw = ({ port, method = "GET", path }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const currentRequest = request(
      {
        host: "127.0.0.1",
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
    currentRequest.end();
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
