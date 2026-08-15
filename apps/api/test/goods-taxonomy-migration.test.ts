import assert from "node:assert/strict";
import test from "node:test";

import { createSeededPersistedState } from "../src/common/store/persistence";
import {
  applyGoodsTaxonomyMigration,
  buildGoodsTaxonomyMigrationPreview
} from "../src/common/policies/goods-taxonomy-migration";

test("分类迁移可预览、哈希门禁并保留历史流水", () => {
  const state = createSeededPersistedState("migration-test-instance");
  const history = structuredClone(state.inventory);
  const preview = buildGoodsTaxonomyMigrationPreview(state, "2026-08-13T08:00:00.000Z");

  assert.equal(preview.nodes[0]?.name, "任意");
  assert.equal(preview.assignments.length, state.goodsCatalog.length);
  assert.throws(
    () => applyGoodsTaxonomyMigration(state, preview, "wrong"),
    /哈希不匹配/
  );
  const drifted = structuredClone(state);
  drifted.goodsCatalog[0]!.name = "迁移预览后发生变化";
  assert.throws(
    () => applyGoodsTaxonomyMigration(drifted, preview, preview.previewHash),
    /哈希不匹配/
  );

  const migrated = applyGoodsTaxonomyMigration(
    state,
    preview,
    preview.previewHash,
    "2026-08-13T08:01:00.000Z"
  );
  assert.deepEqual(migrated.inventory, history);
  assert.equal(migrated.specialAccessPolicies.length, 0);
  assert.ok(migrated.goodsCatalog.every((goods) => Boolean(goods.taxonomyNodeId)));
  assert.ok(migrated.users.every((user) => (user.accessPolicies ?? []).length === 0));
  assert.equal(migrated.logs[0]?.type, "goods-taxonomy-migration");
  assert.equal(migrated.logs[0]?.metadata?.previewHash, preview.previewHash);

  assert.throws(
    () => buildGoodsTaxonomyMigrationPreview(migrated, "2026-08-13T08:02:00.000Z"),
    /已经存在货品分类树/
  );
});
