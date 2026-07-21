import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAuditLogEntry } from "../src/common/logging/audit-log-sanitizer";

test("审计日志将一次性开柜报价编号按能力凭证脱敏", () => {
  const sanitized = sanitizeAuditLogEntry({
    body: {
      quoteId: "open-quote-sensitive-value",
      nested: {
        quote_id: "open-quote-snake-case"
      }
    },
    requestUrl:
      "https://local.invalid/api/cabinet-events/open?quoteId=open-quote-query-value",
    metadata: {
      openQuoteHash: "sha256-safe-audit-correlation"
    }
  });
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(
    serialized,
    /open-quote-sensitive-value|open-quote-snake-case|open-quote-query-value/
  );
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /sha256-safe-audit-correlation/);
});

test("审计日志隐藏支付方身份、付款句柄和客户端调起签名", () => {
  const sanitized = sanitizeAuditLogEntry({
    buyer_user_id: "alipay-buyer-user-sensitive",
    buyer_logon_id: "buyer-sensitive@example.test",
    payerIdentityHandle: "opaque-payer-handle-sensitive",
    paySign: "client-payment-signature-sensitive",
    package: "prepay_id=client-prepay-sensitive"
  });
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(
    serialized,
    /alipay-buyer-user-sensitive|buyer-sensitive@example\.test|opaque-payer-handle-sensitive|client-payment-signature-sensitive|client-prepay-sensitive/
  );
  assert.match(serialized, /\[redacted\]/);
});
