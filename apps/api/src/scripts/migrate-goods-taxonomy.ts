import {
  applyGoodsTaxonomyMigration,
  buildGoodsTaxonomyMigrationPreview
} from "../common/policies/goods-taxonomy-migration.js";
import {
  readPersistedState,
  writePersistedState
} from "../common/store/persistence.js";

const state = readPersistedState();
if (!state) throw new Error("未找到可迁移的运行数据文件。");
const preview = buildGoodsTaxonomyMigrationPreview(state);
const apply = process.argv.includes("--apply");
const expectedHash = process.argv
  .find((argument) => argument.startsWith("--expected-hash="))
  ?.slice("--expected-hash=".length);

console.log(JSON.stringify(preview, null, 2));
if (!apply) {
  console.log("当前仅输出预览；应用时必须追加 --apply --expected-hash=<previewHash>。 ");
  process.exit(0);
}
if (!expectedHash) throw new Error("应用迁移必须提供预览哈希。");
writePersistedState(applyGoodsTaxonomyMigration(state, preview, expectedHash));
console.log(`货品分类迁移已应用：${preview.previewHash}`);
