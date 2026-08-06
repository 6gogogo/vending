import { createServer, request as createUpstreamRequest } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_HOST = "vending.5gogogo.top";
const RELAY_TIMEOUT_MS = 30_000;
const MAX_CALLBACK_BODY_BYTES = 1_048_576;
const allowedLegacyHosts = new Set(["5gogogo.top", "5gogogo.top:4000"]);
const allowedCallbackPaths = new Set([
  "/api/cabinet-events/callbacks/door-status",
  "/api/cabinet-events/callbacks/settlement",
  "/api/cabinet-events/callbacks/adjustment",
  "/api/inventory-orders/callbacks/refund"
]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const normalizeIp = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
};

const hasJsonContentType = (headers) => {
  const value = headers["content-type"];
  return (
    typeof value === "string" &&
    /^application\/json(?:\s*;|$)/iu.test(value.trim())
  );
};

const hasAllowedLegacyHost = (headers) => {
  const value = headers.host;
  return typeof value === "string" && allowedLegacyHosts.has(value.trim().toLowerCase());
};

const writeEmptyResponse = (response, status, extraHeaders = {}) => {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end();
};

const copyDownstreamHeaders = (headers) => {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value !== undefined &&
      !hopByHopHeaders.has(normalized) &&
      !normalized.startsWith("x-accel-")
    ) {
      result[name] = value;
    }
  }
  return result;
};

const readBody = (request) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      length += chunk.length;
      if (length > MAX_CALLBACK_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        request.resume();
        resolveBody(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (!settled) {
        settled = true;
        resolveBody(Buffer.concat(chunks, length));
      }
    });
    request.once("aborted", () => {
      if (!settled) {
        settled = true;
        rejectBody(new Error("request aborted"));
      }
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        rejectBody(error);
      }
    });
  });

const forwardCallback = async (incoming, outgoing, config) => {
  const body = await readBody(incoming);
  if (!body) {
    writeEmptyResponse(outgoing, 413);
    return;
  }
  const clientIp = normalizeIp(incoming.socket.remoteAddress);
  if (isIP(clientIp) === 0) {
    writeEmptyResponse(outgoing, 400);
    return;
  }

  let upstreamResponse;
  const upstream = createUpstreamRequest(
    {
      agent: false,
      hostname: config.upstreamHost,
      port: config.upstreamPort,
      method: "POST",
      path: incoming.url,
      headers: {
        connection: "close",
        "content-length": String(body.length),
        "content-type": String(incoming.headers["content-type"] ?? ""),
        host: PUBLIC_HOST,
        "x-forwarded-proto": "http",
        "x-real-ip": clientIp
      }
    },
    (receivedUpstreamResponse) => {
      upstreamResponse = receivedUpstreamResponse;
      outgoing.writeHead(
        receivedUpstreamResponse.statusCode ?? 502,
        copyDownstreamHeaders(receivedUpstreamResponse.headers)
      );
      receivedUpstreamResponse.once("error", () => outgoing.destroy());
      receivedUpstreamResponse.pipe(outgoing);
    }
  );

  upstream.setTimeout(RELAY_TIMEOUT_MS, () => {
    upstream.destroy(new Error("legacy callback relay upstream timeout"));
  });
  upstream.once("error", () => writeEmptyResponse(outgoing, 502));
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) {
      upstreamResponse?.destroy();
      upstream.destroy();
    }
  });
  upstream.end(body);
};

export const createLegacySmartVmCallbackRelayServer = (config) => {
  const server = createServer((incoming, outgoing) => {
    if (!hasAllowedLegacyHost(incoming.headers)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }
    if (!allowedCallbackPaths.has(incoming.url)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 404);
      return;
    }
    if (incoming.method !== "POST") {
      incoming.resume();
      writeEmptyResponse(outgoing, 405, { Allow: "POST" });
      return;
    }
    if (!hasJsonContentType(incoming.headers)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 415);
      return;
    }
    const declaredLength = Number(incoming.headers["content-length"]);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CALLBACK_BODY_BYTES
    ) {
      incoming.resume();
      writeEmptyResponse(outgoing, 413);
      return;
    }

    void forwardCallback(incoming, outgoing, config).catch(() => {
      writeEmptyResponse(outgoing, 400);
    });
  });

  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  return server;
};

export const listenLegacySmartVmCallbackRelay = (server, config) =>
  new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(config.port, config.bindHost, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

const run = async () => {
  const config = {
    bindHost: "0.0.0.0",
    port: 4000,
    upstreamHost: "10.66.66.2",
    upstreamPort: 5795
  };
  const server = createLegacySmartVmCallbackRelayServer(config);
  await listenLegacySmartVmCallbackRelay(server, config);
  console.log("legacy_smartvm_callback_relay_listening=0.0.0.0:4000");

  const shutdown = () => {
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
