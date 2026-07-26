import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 5795;
const DEFAULT_ADMIN_ROOT = "apps/admin-web/dist";
const DEFAULT_MOBILE_ROOT = "apps/mobile/dist/build/h5";

const mimeTypeByExtension = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".otf", "font/otf"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

const errorRoute = (status, message) => ({
  kind: "error",
  status,
  message
});

const decodeRequestPath = (requestTarget) => {
  if (
    typeof requestTarget !== "string" ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//")
  ) {
    return undefined;
  }

  const rawPath = requestTarget.split("?", 1)[0];
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }

  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("//") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("\0") ||
    /[\u0000-\u001f\u007f]/u.test(decodedPath)
  ) {
    return undefined;
  }

  const pathSegments = decodedPath.split("/");
  if (pathSegments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }

  return decodedPath;
};

export const resolvePublicWebRoute = ({ method, requestTarget }) => {
  if (method !== "GET" && method !== "HEAD") {
    return errorRoute(405, "Method Not Allowed");
  }

  const pathname = decodeRequestPath(requestTarget);
  if (!pathname) {
    return errorRoute(400, "Bad Request");
  }

  const queryIndex = requestTarget.indexOf("?");
  const query = queryIndex >= 0 ? requestTarget.slice(queryIndex) : "";

  if (pathname === "/mobile") {
    return {
      kind: "redirect",
      status: 308,
      location: `/mobile/${query}`
    };
  }

  if (pathname === "/mobile/") {
    return {
      kind: "file",
      root: "mobile",
      relativePath: "index.html",
      fallback: false
    };
  }

  if (pathname.startsWith("/mobile/assets/")) {
    const relativePath = pathname.slice("/mobile/".length);
    if (!relativePath || relativePath.endsWith("/")) {
      return errorRoute(404, "Not Found");
    }

    return {
      kind: "file",
      root: "mobile",
      relativePath,
      fallback: false
    };
  }

  if (pathname.startsWith("/mobile/")) {
    return errorRoute(404, "Not Found");
  }

  return {
    kind: "file",
    root: "admin",
    relativePath: pathname.slice(1),
    fallback: !pathname.startsWith("/assets/") && extname(pathname) === ""
  };
};

export const resolvePublicWebPort = (value) => {
  if (value === undefined || String(value).trim() === "") {
    return DEFAULT_PORT;
  }

  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error("PUBLIC_WEB_PORT must be an integer between 1 and 65535");
  }

  return normalized;
};

const isPathInside = (root, candidate) => {
  const relationship = relative(root, candidate);
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship));
};

const resolveExistingFile = async (root, relativePath) => {
  const candidate = resolve(root, relativePath || ".");
  if (!isPathInside(root, candidate)) {
    return undefined;
  }

  try {
    const resolvedCandidate = await realpath(candidate);
    if (!isPathInside(root, resolvedCandidate)) {
      return undefined;
    }

    const fileStat = await stat(resolvedCandidate);
    if (!fileStat.isFile()) {
      return undefined;
    }

    return {
      path: resolvedCandidate,
      size: fileStat.size
    };
  } catch {
    return undefined;
  }
};

const cacheControlFor = (filePath) =>
  extname(filePath).toLowerCase() === ".html"
    ? "no-store"
    : /[/\\]assets[/\\]/u.test(filePath)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";

const writeTextResponse = (response, method, status, message, extraHeaders = {}) => {
  const body = `${message}\n`;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(body);
};

const streamFileResponse = (response, method, file) => {
  const contentType = mimeTypeByExtension.get(extname(file.path).toLowerCase()) ??
    "application/octet-stream";

  response.writeHead(200, {
    "Cache-Control": cacheControlFor(file.path),
    "Content-Length": file.size,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff"
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(file.path);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
};

export const createPublicWebServer = async ({ adminRoot, mobileRoot } = {}) => {
  const effectiveAdminRoot = await realpath(resolve(adminRoot ?? DEFAULT_ADMIN_ROOT));
  const effectiveMobileRoot = await realpath(resolve(mobileRoot ?? DEFAULT_MOBILE_ROOT));
  const adminIndex = await resolveExistingFile(effectiveAdminRoot, "index.html");
  const mobileIndex = await resolveExistingFile(effectiveMobileRoot, "index.html");

  if (!adminIndex || !mobileIndex) {
    throw new Error("Both admin and mobile build roots must contain index.html");
  }

  return createServer(async (request, response) => {
    const method = request.method ?? "";
    const route = resolvePublicWebRoute({
      method,
      requestTarget: request.url ?? ""
    });

    if (route.kind === "error") {
      writeTextResponse(
        response,
        method,
        route.status,
        route.message,
        route.status === 405 ? { Allow: "GET, HEAD" } : {}
      );
      return;
    }

    if (route.kind === "redirect") {
      response.writeHead(route.status, {
        "Cache-Control": "no-store",
        "Content-Length": "0",
        Location: route.location,
        "X-Content-Type-Options": "nosniff"
      });
      response.end();
      return;
    }

    const root = route.root === "mobile" ? effectiveMobileRoot : effectiveAdminRoot;
    const requestedFile = await resolveExistingFile(root, route.relativePath);
    const file = requestedFile ?? (route.fallback ? adminIndex : undefined);

    if (!file) {
      writeTextResponse(response, method, 404, "Not Found");
      return;
    }

    streamFileResponse(response, method, file);
  });
};

const run = async () => {
  const port = resolvePublicWebPort(process.env.PUBLIC_WEB_PORT);
  const server = await createPublicWebServer();

  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

  console.log(`public_web_listening=${LOOPBACK_HOST}:${port}`);

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
