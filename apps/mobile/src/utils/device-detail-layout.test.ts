import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deviceDetailPagePath = new URL("../pages/special/device-detail.vue", import.meta.url);

test("柜机详情在悬浮操作栏前保留真实滚动占位，最后一件商品可以完整操作", async () => {
  const source = await readFile(deviceDetailPagePath, "utf8");
  const spacerMarkup = '<view v-if="showPrimaryAction" class="primary-action-spacer" aria-hidden="true" />';
  const spacerIndex = source.indexOf(spacerMarkup);
  const actionIndex = source.indexOf('<view v-if="showPrimaryAction" class="primary-action">');

  assert.ok(spacerIndex >= 0, "悬浮操作栏必须在滚动内容中有一个真实占位节点");
  assert.ok(actionIndex > spacerIndex, "占位节点必须位于悬浮操作栏之前");
  assert.match(
    source,
    /\.primary-action-spacer\s*\{[\s\S]*?height:\s*260rpx;[\s\S]*?flex-shrink:\s*0;[\s\S]*?pointer-events:\s*none;[\s\S]*?\}/,
    "普通字号下的占位高度必须覆盖操作栏，并且不能拦截商品点击"
  );
  assert.match(
    source,
    /\.vm-page--accessible \.primary-action-spacer\s*\{[\s\S]*?height:\s*340rpx;[\s\S]*?\}/,
    "大字模式需要为更高的操作栏保留额外空间"
  );
});
