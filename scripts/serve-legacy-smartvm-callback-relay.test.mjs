import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import {
  createLegacySmartVmCallbackRelayServer,
  listenLegacySmartVmCallbackRelay
} from "./serve-legacy-smartvm-callback-relay.mjs";

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

const send = ({ port, method = "POST", path, headers = {}, body = "" }) =>
  new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request(
      {
        agent: false,
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Connection: "close",
          Host: "5gogogo.top:4000",
          ...headers
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode
          })
        );
      }
    );
    outgoing.once("error", rejectResponse);
    outgoing.end(body);
  });

test("旧门状态回调以原始正文转发到当前 Spark 入口", async (context) => {
  let received;
  const upstream = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      received = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: incoming.headers,
        method: incoming.method,
        path: incoming.url
      };
      outgoing.writeHead(202, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Upstream-Result": "accepted"
      });
      outgoing.end('{"code":200,"message":"请求成功"}');
    });
  });
  await listen(upstream);
  context.after(() => close(upstream));

  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");

  const relay = createLegacySmartVmCallbackRelayServer({
    bindHost: "127.0.0.1",
    port: 0,
    upstreamHost: "127.0.0.1",
    upstreamPort: upstreamAddress.port
  });
  await listenLegacySmartVmCallbackRelay(relay, {
    bindHost: "127.0.0.1",
    port: 0
  });
  context.after(() => close(relay));

  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const rawBody = '{"deviceCode":"91110265","status":"CLOSED","sign":"raw-signature"}';
  const response = await send({
    port: relayAddress.port,
    path: "/api/cabinet-events/callbacks/door-status",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Forwarded-For": "203.0.113.9",
      "X-Real-Ip": "203.0.113.10",
      "X-Vending-Relay-Shared-Token": "must-not-pass"
    },
    body: rawBody
  });

  assert.equal(response.status, 202);
  assert.equal(response.body, '{"code":200,"message":"请求成功"}');
  assert.equal(response.headers["x-upstream-result"], "accepted");
  assert.deepEqual(received, {
    body: rawBody,
    headers: {
      connection: "close",
      "content-length": String(Buffer.byteLength(rawBody)),
      "content-type": "application/json; charset=utf-8",
      host: "vending.5gogogo.top",
      "x-forwarded-proto": "http",
      "x-real-ip": "127.0.0.1"
    },
    method: "POST",
    path: "/api/cabinet-events/callbacks/door-status"
  });
});

test("旧入口只兼容四个已登记的 SmartVM 回调路径", async (context) => {
  const receivedPaths = [];
  const upstream = createServer((incoming, outgoing) => {
    incoming.resume();
    receivedPaths.push(incoming.url);
    outgoing.writeHead(204);
    outgoing.end();
  });
  await listen(upstream);
  context.after(() => close(upstream));

  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");
  const relay = createLegacySmartVmCallbackRelayServer({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstreamAddress.port
  });
  await listenLegacySmartVmCallbackRelay(relay, {
    bindHost: "127.0.0.1",
    port: 0
  });
  context.after(() => close(relay));

  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const paths = [
    "/api/cabinet-events/callbacks/door-status",
    "/api/cabinet-events/callbacks/settlement",
    "/api/cabinet-events/callbacks/adjustment",
    "/api/inventory-orders/callbacks/refund"
  ];
  for (const path of paths) {
    const response = await send({
      port: relayAddress.port,
      path,
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 204, path);
  }

  assert.deepEqual(receivedPaths, paths);
});

test("旧入口拒绝非 POST、未登记路径和非 JSON 正文", async (context) => {
  let upstreamCalls = 0;
  const upstream = createServer((incoming, outgoing) => {
    upstreamCalls += 1;
    incoming.resume();
    outgoing.writeHead(204);
    outgoing.end();
  });
  await listen(upstream);
  context.after(() => close(upstream));

  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");
  const relay = createLegacySmartVmCallbackRelayServer({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstreamAddress.port
  });
  await listenLegacySmartVmCallbackRelay(relay, {
    bindHost: "127.0.0.1",
    port: 0
  });
  context.after(() => close(relay));

  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const callbackPath = "/api/cabinet-events/callbacks/door-status";
  const getResponse = await send({
    port: relayAddress.port,
    method: "GET",
    path: callbackPath
  });
  const unknownResponse = await send({
    port: relayAddress.port,
    path: "/api/health",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const queryResponse = await send({
    port: relayAddress.port,
    path: `${callbackPath}?debug=1`,
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const nonJsonResponse = await send({
    port: relayAddress.port,
    path: callbackPath,
    headers: { "Content-Type": "text/plain" },
    body: "{}"
  });
  const wrongHostResponse = await send({
    port: relayAddress.port,
    path: callbackPath,
    headers: {
      "Content-Type": "application/json",
      Host: "unrelated.example"
    },
    body: "{}"
  });

  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.allow, "POST");
  assert.equal(unknownResponse.status, 404);
  assert.equal(queryResponse.status, 404);
  assert.equal(nonJsonResponse.status, 415);
  assert.equal(wrongHostResponse.status, 403);
  assert.equal(upstreamCalls, 0);
});

test("旧入口在转发前拒绝超过一兆字节的回调正文", async (context) => {
  let upstreamCalls = 0;
  const upstream = createServer((incoming, outgoing) => {
    upstreamCalls += 1;
    incoming.resume();
    outgoing.writeHead(204);
    outgoing.end();
  });
  await listen(upstream);
  context.after(() => close(upstream));

  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");
  const relay = createLegacySmartVmCallbackRelayServer({
    upstreamHost: "127.0.0.1",
    upstreamPort: upstreamAddress.port
  });
  await listenLegacySmartVmCallbackRelay(relay, {
    bindHost: "127.0.0.1",
    port: 0
  });
  context.after(() => close(relay));

  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const response = await send({
    port: relayAddress.port,
    path: "/api/cabinet-events/callbacks/settlement",
    headers: { "Content-Type": "application/json" },
    body: Buffer.alloc(1_048_577, 0x20)
  });

  assert.equal(response.status, 413);
  assert.equal(upstreamCalls, 0);
});

test("Spark 入口不可用时旧入口只返回空的 502", async (context) => {
  const reservedPortServer = createServer();
  await listen(reservedPortServer);
  const reservedAddress = reservedPortServer.address();
  assert(reservedAddress && typeof reservedAddress === "object");
  await close(reservedPortServer);

  const relay = createLegacySmartVmCallbackRelayServer({
    upstreamHost: "127.0.0.1",
    upstreamPort: reservedAddress.port
  });
  await listenLegacySmartVmCallbackRelay(relay, {
    bindHost: "127.0.0.1",
    port: 0
  });
  context.after(() => close(relay));

  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress === "object");
  const response = await send({
    port: relayAddress.port,
    path: "/api/inventory-orders/callbacks/refund",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });

  assert.equal(response.status, 502);
  assert.equal(response.body, "");
  assert.equal(response.headers["cache-control"], "no-store");
});
