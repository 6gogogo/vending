import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, request as createUpstreamRequest } from "node:http";
import { isIP, isIPv4 } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELAY_TIMEOUT_MS = 30_000;
const DEFAULT_API_SOCKET_MODE = 0o660;
const loopbackHosts = new Set(["127.0.0.1", "::1"]);
const modes = new Set(["api", "static"]);
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

const resolvePort = (value, name) => {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return normalized;
};

const normalizeIp = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
};

const isLoopbackHost = (value) => {
  const normalized = normalizeIp(value).replace(/^\[|\]$/gu, "");
  return (
    loopbackHosts.has(normalized) ||
    (isIPv4(normalized) && normalized.split(".")[0] === "127")
  );
};

const isPrivateIpv4 = (value) => {
  const normalized = String(value ?? "").trim();
  if (!isIPv4(normalized)) {
    return false;
  }

  const [first, second] = normalized.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const assertPrivateTokenPathChain = (filePath, variableName) => {
  if (process.platform === "win32") {
    return;
  }

  const serviceUserId = process.getuid();
  let directoryPath = dirname(filePath);
  for (;;) {
    const metadata = lstatSync(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${variableName} parent chain must contain only directories`);
    }

    const isWritableByGroupOrOthers = (metadata.mode & 0o022) !== 0;
    const isProtectedStickyDirectory =
      metadata.uid !== serviceUserId && (metadata.mode & 0o1000) !== 0;
    if (isWritableByGroupOrOthers && !isProtectedStickyDirectory) {
      throw new Error(`${variableName} parent chain must not be group- or world-writable`);
    }

    const parentPath = dirname(directoryPath);
    if (parentPath === directoryPath) {
      return;
    }
    directoryPath = parentPath;
  }
};

export const isAllowedTokenParentDirectory = (metadata, serviceUserId, serviceGroupId) => {
  const mode = metadata.mode & 0o777;
  const serviceOwnedPrivateDirectory =
    metadata.uid === serviceUserId && (mode & 0o022) === 0;
  const rootManagedTraverseDirectory =
    metadata.uid === 0 &&
    metadata.gid === serviceGroupId &&
    mode === 0o710;

  return serviceOwnedPrivateDirectory || rootManagedTraverseDirectory;
};

const readSharedToken = (filePath) => {
  const resolvedFilePath = resolve(filePath);
  const metadata = lstatSync(resolvedFilePath);
  const parentMetadata = lstatSync(dirname(resolvedFilePath));
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE must be a regular file");
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE parent must be a directory");
  }
  if (
    process.platform !== "win32" &&
    ((metadata.mode & 0o077) !== 0 ||
      (parentMetadata.mode & 0o022) !== 0 ||
      metadata.uid !== process.getuid() ||
      !isAllowedTokenParentDirectory(parentMetadata, process.getuid(), process.getgid()))
  ) {
    throw new Error(
      "PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE must be service-private beneath a protected directory"
    );
  }
  assertPrivateTokenPathChain(resolvedFilePath, "PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE");

  const token = readFileSync(resolvedFilePath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    throw new Error("PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE must contain a high-entropy token");
  }
  return token;
};

const resolveApiSocketPath = (value, directory) => {
  const rawPath = String(value ?? "").trim();
  const rawDirectory = String(directory ?? "").trim();
  if (!rawPath || !rawDirectory || !isAbsolute(rawPath) || !isAbsolute(rawDirectory)) {
    throw new Error("PUBLIC_EDGE_RELAY_SOCKET_PATH and PUBLIC_EDGE_RELAY_SOCKET_DIRECTORY are required");
  }

  const socketPath = resolve(rawPath);
  const socketDirectory = resolve(rawDirectory);
  if (dirname(socketPath) !== socketDirectory || !socketPath.endsWith(".sock")) {
    throw new Error("PUBLIC_EDGE_RELAY_SOCKET_PATH must be a direct .sock child of the controlled socket directory");
  }

  return { socketDirectory, socketPath };
};

const assertApiSocketDirectory = (config) => {
  if (process.platform === "win32") {
    return;
  }

  const metadata = lstatSync(config.socketDirectory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o007) !== 0 ||
    (metadata.mode & 0o2000) === 0
  ) {
    throw new Error("PUBLIC_EDGE_RELAY_SOCKET_DIRECTORY must be a private setgid service directory");
  }
};

const removeStaleApiSocket = (socketPath) => {
  try {
    const metadata = lstatSync(socketPath);
    if (!metadata.isSocket() || metadata.isSymbolicLink()) {
      throw new Error("PUBLIC_EDGE_RELAY_SOCKET_PATH exists but is not a socket");
    }
    if (process.platform !== "win32" && metadata.uid !== process.getuid()) {
      throw new Error("PUBLIC_EDGE_RELAY_SOCKET_PATH is not owned by the service user");
    }
    unlinkSync(socketPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const normalizeAllowedHost = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\.$/u, "");
  const labels = normalized.split(".");
  const validLabel = (label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label);

  if (
    !normalized ||
    normalized.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !validLabel(label))
  ) {
    throw new Error("PUBLIC_EDGE_RELAY_ALLOWED_HOSTS must contain valid DNS hostnames");
  }

  return normalized;
};

const resolveAllowedHosts = (value) => {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("PUBLIC_EDGE_RELAY_ALLOWED_HOSTS is required");
  }
  return new Set(entries.map(normalizeAllowedHost));
};

const getSingleHeader = (headers, name) => {
  const value = headers[name];
  if (Array.isArray(value) || typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized && !normalized.includes(",") ? normalized : undefined;
};

const connectionHeaderNames = (headers) => {
  const value = headers.connection;
  const raw = Array.isArray(value) ? value.join(",") : value;
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
};

const isRemovedInboundHeader = (name, connectionNames) => {
  const normalized = name.toLowerCase();
  return (
    hopByHopHeaders.has(normalized) ||
    connectionNames.has(normalized) ||
    normalized === "host" ||
    normalized === "forwarded" ||
    normalized === "x-real-ip" ||
    normalized.startsWith("x-forwarded-") ||
    normalized.startsWith("x-vending-relay-")
  );
};

const copyUpstreamHeaders = (incoming, context, mode) => {
  const headers = {};
  const connectionNames = connectionHeaderNames(incoming.headers);

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || isRemovedInboundHeader(name, connectionNames)) {
      continue;
    }
    headers[name.toLowerCase()] = value;
  }

  headers.host = context.host;
  if (mode === "api") {
    headers["x-vending-relay-client-ip"] = context.clientIp;
    headers["x-vending-relay-host"] = context.host;
    headers["x-vending-relay-proto"] = "https";
    headers["x-vending-relay-shared-token"] = context.sharedToken;
  }
  return headers;
};

const copyDownstreamHeaders = (headers) => {
  const result = {};
  const connectionNames = connectionHeaderNames(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value !== undefined &&
      !hopByHopHeaders.has(normalized) &&
      !connectionNames.has(normalized) &&
      !normalized.startsWith("x-accel-")
    ) {
      result[name] = value;
    }
  }
  return result;
};

const writeEmptyResponse = (response, status) => {
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
    "X-Content-Type-Options": "nosniff"
  });
  response.end();
};

const resolveRequestContext = (incoming, config) => {
  const host = normalizeAllowedHost(getSingleHeader(incoming.headers, "host"));
  if (!config.allowedHosts.has(host)) {
    return undefined;
  }

  if (config.mode === "static") {
    return { host };
  }

  const clientIp = normalizeIp(getSingleHeader(incoming.headers, "x-real-ip"));
  const proto = getSingleHeader(incoming.headers, "x-forwarded-proto")?.toLowerCase();
  if (isIP(clientIp) === 0 || proto !== "https") {
    return undefined;
  }

  return {
    clientIp,
    host,
    sharedToken: config.sharedToken
  };
};

const isSafeRequestTarget = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//");

export const resolvePublicEdgeRelayConfig = (env = process.env) => {
  const mode = String(env.PUBLIC_EDGE_RELAY_MODE ?? "").trim();
  if (!modes.has(mode)) {
    throw new Error("PUBLIC_EDGE_RELAY_MODE must be api or static");
  }

  const upstreamHost = String(env.PUBLIC_EDGE_RELAY_UPSTREAM_HOST ?? "").trim();
  if (!isPrivateIpv4(upstreamHost)) {
    throw new Error("PUBLIC_EDGE_RELAY_UPSTREAM_HOST must be an RFC1918 IPv4 address");
  }

  const sharedTokenFile = String(env.PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE ?? "").trim();
  if (mode === "api" && !sharedTokenFile) {
    throw new Error("PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE is required for API mode");
  }

  const socketConfig =
    mode === "api"
      ? resolveApiSocketPath(
          env.PUBLIC_EDGE_RELAY_SOCKET_PATH,
          env.PUBLIC_EDGE_RELAY_SOCKET_DIRECTORY
        )
      : undefined;
  const bindHost = String(env.PUBLIC_EDGE_RELAY_BIND_HOST ?? "").trim();
  if (mode === "static" && !isLoopbackHost(bindHost)) {
    throw new Error("PUBLIC_EDGE_RELAY_BIND_HOST must be a loopback address for static mode");
  }

  return {
    mode,
    bindHost: mode === "static" ? bindHost : undefined,
    port:
      mode === "static"
        ? resolvePort(env.PUBLIC_EDGE_RELAY_PORT, "PUBLIC_EDGE_RELAY_PORT")
        : undefined,
    upstreamHost,
    upstreamPort: resolvePort(
      env.PUBLIC_EDGE_RELAY_UPSTREAM_PORT,
      "PUBLIC_EDGE_RELAY_UPSTREAM_PORT"
    ),
    allowedHosts: resolveAllowedHosts(env.PUBLIC_EDGE_RELAY_ALLOWED_HOSTS),
    socketDirectory: socketConfig?.socketDirectory,
    socketPath: socketConfig?.socketPath,
    socketMode: mode === "api" ? DEFAULT_API_SOCKET_MODE : undefined,
    sharedToken: mode === "api" ? readSharedToken(sharedTokenFile) : undefined
  };
};

export const createPublicEdgeRelayServer = (config) => {
  const server = createServer((incoming, outgoing) => {
    if (config.mode === "static" && !isLoopbackHost(incoming.socket.remoteAddress)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }

    if (!isSafeRequestTarget(incoming.url)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 400);
      return;
    }

    if (
      config.mode === "static" &&
      (incoming.url === "/api" || incoming.url?.startsWith("/api/"))
    ) {
      incoming.resume();
      writeEmptyResponse(outgoing, 404);
      return;
    }

    let context;
    try {
      context = resolveRequestContext(incoming, config);
    } catch {
      context = undefined;
    }

    if (!context) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }

    let upstreamResponse;
    const upstream = createUpstreamRequest(
      {
        hostname: config.upstreamHost,
        port: config.upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: copyUpstreamHeaders(incoming, context, config.mode)
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
      upstream.destroy(new Error("public edge relay upstream timeout"));
    });
    upstream.once("error", () => writeEmptyResponse(outgoing, 502));
    incoming.once("aborted", () => upstream.destroy());
    incoming.once("error", () => upstream.destroy());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) {
        upstreamResponse?.destroy();
        upstream.destroy();
      }
    });
    incoming.pipe(upstream);
  });

  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  return server;
};

export const listenPublicEdgeRelay = (server, config) =>
  new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);

    if (config.mode === "api") {
      try {
        assertApiSocketDirectory(config);
        removeStaleApiSocket(config.socketPath);
      } catch (error) {
        server.off("error", rejectListening);
        rejectListening(error);
        return;
      }

      server.listen(config.socketPath, () => {
        try {
          if (process.platform !== "win32") {
            chmodSync(config.socketPath, config.socketMode);
            const socketMetadata = lstatSync(config.socketPath);
            const directoryMetadata = lstatSync(config.socketDirectory);
            if (
              socketMetadata.uid !== process.getuid() ||
              socketMetadata.gid !== directoryMetadata.gid ||
              (socketMetadata.mode & 0o007) !== 0
            ) {
              throw new Error("PUBLIC_EDGE_RELAY_SOCKET_PATH ownership or mode is unsafe");
            }
          }
          server.off("error", rejectListening);
          resolveListening();
        } catch (error) {
          server.close(() => rejectListening(error));
        }
      });
      return;
    }

    server.listen(config.port, config.bindHost, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

const run = async () => {
  const config = resolvePublicEdgeRelayConfig();
  const server = createPublicEdgeRelayServer(config);

  await listenPublicEdgeRelay(server, config);

  console.log(
    `public_edge_relay_listening=${config.mode}:${config.socketPath ?? `${config.bindHost}:${config.port}`}`
  );

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
