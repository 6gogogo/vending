import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const expectedApiDirectives = [
  "proxy_pass http://unix:/run/vending/api-edge.sock:",
  "proxy_set_header Host $host",
  "proxy_set_header X-Real-IP $remote_addr",
  "proxy_set_header X-Forwarded-Proto $scheme"
];

const expectedStaticDirectives = [
  "proxy_pass http://127.0.0.1:5795",
  "proxy_set_header Host $host",
  "proxy_set_header X-Real-IP $remote_addr",
  "proxy_set_header X-Forwarded-Proto $scheme"
];

const stripComments = (text) => text.replace(/(^|\s)#.*$/gmu, "$1");

const extractBlocks = (text, pattern) => {
  const blocks = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const openingBrace = text.indexOf("{", match.index);
    if (openingBrace < 0) {
      continue;
    }

    let depth = 1;
    let cursor = openingBrace + 1;
    for (; cursor < text.length && depth > 0; cursor += 1) {
      if (text[cursor] === "{") {
        depth += 1;
      } else if (text[cursor] === "}") {
        depth -= 1;
      }
    }

    if (depth === 0) {
      blocks.push(text.slice(openingBrace + 1, cursor - 1));
    }
  }

  return blocks;
};

const hasDirective = (block, directive) => {
  const escaped = directive.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*;\\s*$`, "mu").test(block);
};

const topLevelContent = (block) => {
  let result = "";
  let depth = 0;

  for (const character of block) {
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      result += character;
    }
  }

  return result;
};

const extractTopLevelBlocks = (text, pattern) => {
  const blocks = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    let depthBeforeMatch = 0;
    for (let index = 0; index < match.index; index += 1) {
      if (text[index] === "{") {
        depthBeforeMatch += 1;
      } else if (text[index] === "}") {
        depthBeforeMatch = Math.max(0, depthBeforeMatch - 1);
      }
    }

    if (depthBeforeMatch !== 0) {
      continue;
    }

    const openingBrace = text.indexOf("{", match.index);
    if (openingBrace < 0) {
      continue;
    }

    let depth = 1;
    let cursor = openingBrace + 1;
    for (; cursor < text.length && depth > 0; cursor += 1) {
      if (text[cursor] === "{") {
        depth += 1;
      } else if (text[cursor] === "}") {
        depth -= 1;
      }
    }

    if (depth === 0) {
      blocks.push(text.slice(openingBrace + 1, cursor - 1));
    }
  }

  return blocks;
};

const locationMatches = (serverBlock, locationPattern, directives) =>
  extractBlocks(serverBlock, locationPattern).some((locationBlock) =>
    directives.every((directive) => hasDirective(topLevelContent(locationBlock), directive))
  );

const hasTargetServerName = (serverBlock) => {
  const serverNameDirectives = topLevelContent(serverBlock).matchAll(
    /^\s*server_name\s+([^;]+);\s*$/gmu
  );

  return Array.from(serverNameDirectives).some((directive) =>
    directive[1]
      .trim()
      .split(/\s+/u)
      .some((name) => name.toLowerCase() === "vending.5gogogo.top")
  );
};

const hasTls443Listener = (serverBlock) =>
  /^\s*listen\s+(?:\[::\]:)?443\b[^;]*\bssl\b[^;]*;\s*$/mu.test(
    topLevelContent(serverBlock)
  );

const hasHttpRedirect = (serverBlock) => {
  const topLevelServer = topLevelContent(serverBlock);
  const redirectDirective = /^\s*return\s+301\s+https:\/\/\$host\$request_uri\s*;\s*$/mu;
  const directRedirect = redirectDirective.test(topLevelServer);
  const targetHostIf = /(?:^|\n)\s*if\s*\(\s*\$host\s*=\s*vending\.5gogogo\.top\s*\)\s*\{/gmu;
  const conditionalRedirect = extractTopLevelBlocks(serverBlock, targetHostIf).some((ifBlock) =>
    redirectDirective.test(topLevelContent(ifBlock))
  );

  return (
    /^\s*listen\s+(?:\[::\]:)?80\b[^;]*;\s*$/mu.test(topLevelServer) &&
    (directRedirect || conditionalRedirect)
  );
};

export const verifyVncNginxEdgeContract = (nginxConfig) => {
  const source = stripComments(String(nginxConfig ?? ""));
  const serverBlocks = extractBlocks(source, /(?:^|\n)\s*server\s*\{/gmu);
  const targetServerBlocks = serverBlocks.filter(hasTargetServerName);

  const apiLocation = /(?:^|\n)\s*location\s+\^~\s+\/api\/\s*\{/gmu;
  const staticLocation = /(?:^|\n)\s*location\s+\/\s*\{/gmu;

  const hasCompleteTlsServer = targetServerBlocks.some(
    (serverBlock) =>
      hasTls443Listener(serverBlock) &&
      locationMatches(serverBlock, apiLocation, expectedApiDirectives) &&
      locationMatches(serverBlock, staticLocation, expectedStaticDirectives)
  );

  return hasCompleteTlsServer && targetServerBlocks.some(hasHttpRedirect);
};

const run = async () => {
  let config = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    config += chunk;
  }

  assert.ok(
    verifyVncNginxEdgeContract(config),
    "Nginx edge contract is incomplete or not found in an effective vending server block"
  );
  console.log("vnc_nginx_edge_contract=ok");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
