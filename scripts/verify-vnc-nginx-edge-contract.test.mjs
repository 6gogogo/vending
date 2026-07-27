import assert from "node:assert/strict";
import test from "node:test";

import { verifyVncNginxEdgeContract } from "./verify-vnc-nginx-edge-contract.mjs";

const validConfig = `
server {
  listen 443 ssl;
  server_name vending.5gogogo.top;

  location ^~ /api/ {
    proxy_pass http://unix:/run/vending/api-edge.sock:;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:5795;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 80;
  server_name vending.5gogogo.top;
  if ($host = vending.5gogogo.top) {
    return 301 https://$host$request_uri;
  }
  return 404;
}
`;

test("VNC Nginx edge contract requires both complete locations in one vending server", () => {
  assert.equal(verifyVncNginxEdgeContract(validConfig), true);
  assert.equal(
    verifyVncNginxEdgeContract(
      validConfig.replace("proxy_set_header X-Real-IP $remote_addr;", "")
    ),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(
      `${validConfig}\nserver {\n  server_name another.example;\n  location / {\n    proxy_pass http://127.0.0.1:5795;\n  }\n}`
    ),
    true
  );
  assert.equal(
    verifyVncNginxEdgeContract(validConfig.replace("vending.5gogogo.top", "other.example")),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(
      validConfig.replace("server_name vending.5gogogo.top;", "server_name vending.5gogogo.top.evil;")
    ),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(validConfig.replace("listen 443 ssl;", "listen 8080;")),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(validConfig.replace("return 301 https://$host$request_uri;", "return 302 /;")),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(
      validConfig.replace(
        "    proxy_pass http://unix:/run/vending/api-edge.sock:;",
        "    proxy_pass http://127.0.0.1:9999;\n    if ($request_method = GET) { proxy_pass http://unix:/run/vending/api-edge.sock:; }"
      )
    ),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(
      validConfig.replace(
        "  if ($host = vending.5gogogo.top) {\n    return 301 https://$host$request_uri;\n  }",
        "  location /redirect-only {\n    return 301 https://$host$request_uri;\n  }"
      )
    ),
    false
  );
  assert.equal(
    verifyVncNginxEdgeContract(
      validConfig.replace(
        "  if ($host = vending.5gogogo.top) {\n    return 301 https://$host$request_uri;\n  }",
        "  location /redirect-only {\n    if ($host = vending.5gogogo.top) {\n      return 301 https://$host$request_uri;\n    }\n  }"
      )
    ),
    false
  );
});
