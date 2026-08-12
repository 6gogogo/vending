<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { GoodsCatalogItem, GoodsTaxonomyNode } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";

const sessionStore = useAdminSessionStore();
const canManage = computed(() => sessionStore.can("goods:manage"));
const loading = ref(false);
const saving = ref(false);
const revision = ref(0);
const nodes = ref<GoodsTaxonomyNode[]>([]);
const goods = ref<GoodsCatalogItem[]>([]);
const selectedNodeId = ref("");
const selectedGoodsIds = ref<string[]>([]);
const message = ref<{ type: "success" | "error"; text: string }>();
const createForm = reactive({ name: "", parentId: "" });
const changeForm = reactive({ nodeId: "", name: "", parentId: "", status: "active" as "active" | "inactive" });

const depthById = computed(() => {
  const result = new Map<string, number>();
  const nodeById = new Map(nodes.value.map((node) => [node.id, node]));
  const depth = (id: string): number => {
    if (result.has(id)) return result.get(id)!;
    const node = nodeById.get(id);
    const value = node?.parentId ? depth(node.parentId) + 1 : 1;
    result.set(id, value);
    return value;
  };
  nodes.value.forEach((node) => depth(node.id));
  return result;
});
const sortedNodes = computed(() => [...nodes.value].sort((left, right) =>
  (depthById.value.get(left.id) ?? 0) - (depthById.value.get(right.id) ?? 0) ||
  left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-Hans-CN")
));
const nodeName = (id?: string) => nodes.value.find((node) => node.id === id)?.name ?? "未归类";
const pathLabel = (item: GoodsCatalogItem) => item.taxonomyPath?.map((node) => node.name).join(" / ") || "未归类";

const load = async () => {
  loading.value = true;
  try {
    const snapshot = await adminApi.goodsTaxonomy();
    revision.value = snapshot.revision;
    nodes.value = snapshot.nodes;
    goods.value = snapshot.goods;
    const root = snapshot.nodes.find((node) => node.parentId === null && node.status === "active");
    if (root && !createForm.parentId) createForm.parentId = root.id;
  } catch (error) {
    message.value = { type: "error", text: `分类树加载失败：${readErrorMessage(error, "请稍后重试")}` };
  } finally {
    loading.value = false;
  }
};

const createNode = async () => {
  if (!canManage.value || !createForm.name.trim()) return;
  saving.value = true;
  try {
    await adminApi.createGoodsTaxonomyNode({
      name: createForm.name.trim(),
      parentId: createForm.parentId || null
    });
    createForm.name = "";
    await load();
    message.value = { type: "success", text: "分类节点已创建。" };
  } catch (error) {
    message.value = { type: "error", text: `创建失败：${readErrorMessage(error, "请核对层级与名称")}` };
  } finally {
    saving.value = false;
  }
};

const editNode = (node: GoodsTaxonomyNode) => {
  changeForm.nodeId = node.id;
  changeForm.name = node.name;
  changeForm.parentId = node.parentId ?? "";
  changeForm.status = node.status;
};

const applyChange = async () => {
  if (!canManage.value || !changeForm.nodeId) return;
  saving.value = true;
  try {
    const payload = {
      name: changeForm.name.trim(),
      parentId: changeForm.parentId || null,
      status: changeForm.status
    };
    const preview = await adminApi.previewGoodsTaxonomyChange(changeForm.nodeId, payload);
    if (!preview.allowed) throw new Error(preview.blockReason || "当前变更不可执行");
    const summary = [
      `影响分类 ${preview.affectedNodeIds.length} 个`,
      `货品 ${preview.affectedGoodsIds.length} 个`,
      `人员 ${preview.affectedUserIds.length} 人`,
      `有效预约 ${preview.affectedReservationIds.length} 条`
    ].join("；");
    if (!window.confirm(`${summary}。受影响的有效预约会立即取消，确认应用？`)) return;
    await adminApi.applyGoodsTaxonomyChange(changeForm.nodeId, {
      ...payload,
      expectedRevision: preview.expectedRevision
    });
    changeForm.nodeId = "";
    await load();
    message.value = { type: "success", text: `分类变更已应用：${summary}。` };
  } catch (error) {
    message.value = { type: "error", text: `变更失败：${readErrorMessage(error, "请重新预览")}` };
  } finally {
    saving.value = false;
  }
};

const toggleGoods = (goodsId: string) => {
  selectedGoodsIds.value = selectedGoodsIds.value.includes(goodsId)
    ? selectedGoodsIds.value.filter((id) => id !== goodsId)
    : [...selectedGoodsIds.value, goodsId];
};

const assignGoods = async () => {
  if (!canManage.value || !selectedNodeId.value || !selectedGoodsIds.value.length) return;
  saving.value = true;
  try {
    const payload = {
      taxonomyNodeId: selectedNodeId.value,
      goodsIds: selectedGoodsIds.value
    };
    const preview = await adminApi.previewGoodsTaxonomyAssignment(payload);
    const summary = `实际变更 ${preview.affectedGoodsIds.length} 个货品；影响 ${preview.affectedUserIds.length} 人；取消 ${preview.affectedReservationIds.length} 条有效预约`;
    if (!preview.affectedGoodsIds.length) {
      message.value = { type: "success", text: "所选货品已经属于该分类，无需重复保存。" };
      return;
    }
    if (!window.confirm(`确认归入“${nodeName(selectedNodeId.value)}”？${summary}。`)) return;
    await adminApi.assignGoodsTaxonomy({
      ...payload,
      expectedRevision: preview.expectedRevision
    });
    selectedGoodsIds.value = [];
    await load();
    message.value = { type: "success", text: `货品归属已更新：${summary}。` };
  } catch (error) {
    message.value = { type: "error", text: `归类失败：${readErrorMessage(error, "请稍后重试")}` };
  } finally {
    saving.value = false;
  }
};

onMounted(load);
</script>

<template>
  <section class="admin-page taxonomy-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">领取分类树</p>
          <h3 class="admin-page__section-title">维护货品唯一归属与可领取额度范围</h3>
          <p class="admin-copy">额度设在某个分类后，该分类当前和未来的全部后代货品均可使用；最多支持 8 层。</p>
        </div>
        <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">{{ loading ? "刷新中" : "刷新" }}</button>
      </div>
      <div v-if="message" class="admin-note" :class="{ 'taxonomy-error': message.type === 'error' }">{{ message.text }}</div>
      <div class="taxonomy-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><h3 class="admin-panel__title">分类节点</h3><span class="admin-pill">版本 {{ revision }}</span></div>
          <div v-if="canManage" class="taxonomy-form">
            <input v-model="createForm.name" class="admin-input" maxlength="40" placeholder="新分类名称" />
            <select v-model="createForm.parentId" class="admin-select"><option value="">作为根节点</option><option v-for="node in sortedNodes.filter((item) => item.status === 'active')" :key="node.id" :value="node.id">{{ "　".repeat((depthById.get(node.id) ?? 1) - 1) }}{{ node.name }}</option></select>
            <button class="admin-button" :disabled="saving" @click="createNode">新增节点</button>
          </div>
          <button v-for="node in sortedNodes" :key="node.id" class="taxonomy-node" :class="{ 'taxonomy-node--selected': changeForm.nodeId === node.id }" @click="editNode(node)">
            <span>{{ "　".repeat((depthById.get(node.id) ?? 1) - 1) }}{{ node.name }}</span>
            <span class="admin-table__subtext">{{ node.status === "inactive" ? "已停用" : `第 ${depthById.get(node.id)} 层` }}</span>
          </button>
          <div v-if="canManage && changeForm.nodeId" class="taxonomy-form taxonomy-form--change">
            <input v-model="changeForm.name" class="admin-input" maxlength="40" />
            <select v-model="changeForm.parentId" class="admin-select"><option value="">根节点</option><option v-for="node in sortedNodes.filter((item) => item.id !== changeForm.nodeId && item.status === 'active')" :key="node.id" :value="node.id">{{ node.name }}</option></select>
            <select v-model="changeForm.status" class="admin-select"><option value="active">启用</option><option value="inactive">停用</option></select>
            <button class="admin-button" :disabled="saving" @click="applyChange">预览并应用</button>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><h3 class="admin-panel__title">货品唯一归属</h3><span class="admin-copy">已选 {{ selectedGoodsIds.length }} 个</span></div>
          <div v-if="canManage" class="taxonomy-assign">
            <select v-model="selectedNodeId" class="admin-select"><option value="">选择目标分类</option><option v-for="node in sortedNodes.filter((item) => item.status === 'active')" :key="node.id" :value="node.id">{{ node.name }}</option></select>
            <button class="admin-button" :disabled="saving || !selectedNodeId || !selectedGoodsIds.length" @click="assignGoods">批量归类</button>
          </div>
          <table class="admin-table">
            <thead><tr><th v-if="canManage">选择</th><th>货品</th><th>当前路径</th></tr></thead>
            <tbody><tr v-for="item in goods" :key="item.goodsId"><td v-if="canManage"><input type="checkbox" :checked="selectedGoodsIds.includes(item.goodsId)" @change="toggleGoods(item.goodsId)" /></td><td><strong>{{ item.name }}</strong><span class="admin-table__subtext">{{ item.goodsCode }}</span></td><td>{{ pathLabel(item) }}</td></tr></tbody>
          </table>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.taxonomy-grid { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(520px, 1.4fr); gap: 18px; }
.taxonomy-form, .taxonomy-assign { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; margin-bottom: 14px; }
.taxonomy-form--change { grid-template-columns: 1fr 1fr 130px auto; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--admin-line); }
.taxonomy-node { width: 100%; display: flex; justify-content: space-between; gap: 12px; padding: 11px 12px; border: 1px solid var(--admin-line); background: var(--admin-surface); color: var(--admin-text); text-align: left; cursor: pointer; }
.taxonomy-node + .taxonomy-node { border-top: 0; }
.taxonomy-node--selected { background: var(--admin-accent-soft); border-color: var(--admin-accent); }
.taxonomy-error { color: #9f1d15; border-color: #e6aaa4; background: #fff1ef; }
@media (max-width: 1100px) { .taxonomy-grid { grid-template-columns: 1fr; } }
@media (max-width: 720px) { .taxonomy-form, .taxonomy-form--change, .taxonomy-assign { grid-template-columns: 1fr; } }
</style>
