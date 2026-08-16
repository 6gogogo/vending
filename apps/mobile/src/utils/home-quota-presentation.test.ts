import assert from "node:assert/strict";
import test from "node:test";

import { buildHomeQuotaRows } from "./home-quota-presentation";

const legacyRows = [
  { goodsId: "8242266", goodsName: "8242266", quantity: 1 },
  { goodsId: "9230204", goodsName: "9230204", quantity: 4 }
];

test("新版大类额度在首页聚合为额度，不展示推演出的商品编号", () => {
  assert.deepEqual(
    buildHomeQuotaRows({
      taxonomyRevision: 6,
      remainingTotal: 4,
      aggregateLabel: "额度",
      legacyRows
    }),
    [{ goodsId: "hierarchical-quota", goodsName: "额度", quantity: 4 }]
  );
});

test("旧版逐商品额度保持原有名称和数量不变", () => {
  assert.deepEqual(
    buildHomeQuotaRows({
      taxonomyRevision: undefined,
      remainingTotal: 4,
      aggregateLabel: "额度",
      legacyRows
    }),
    legacyRows
  );
});
