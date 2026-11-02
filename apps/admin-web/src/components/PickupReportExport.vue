<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import PickupWorkbookPreview from "./PickupWorkbookPreview.vue";
import type { PreviewSheet } from "../utils/pickup-workbook-preview";
import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { getTodayDateKeyInBeijing } from "../utils/datetime";

const session = useAdminSessionStore();
const visible = computed(() => session.can("analytics:data-monitor:view") && session.can("operation-logs:export"));
const endDate = ref(getTodayDateKeyInBeijing());
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const startDate = ref(shift(endDate.value, -6));
const fields = ref(["date", "person", "time", "goods", "quantity"]);
const sections = ref(["detail", "overview"]);
const busy = ref(false), error = ref(""), success = ref("");
const previewBusy = ref(false), previewError = ref("");
const previewSheets = shallowRef<PreviewSheet[]>([]);
const reportFile = shallowRef<{ blob: Blob; filename: string }>();
let previewVersion = 0, previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewController: AbortController | undefined;
const fieldOptions = [
  { id: "date", label: "领取日期" }, { id: "person", label: "领取人" }, { id: "time", label: "领取时间（开门时间）" },
  { id: "goods", label: "派发出的物资" }, { id: "quantity", label: "领取件数" }
];
const extras = [{ id: "device", label: "柜机名称 / 编号" }, { id: "region", label: "社区 / 街道" }, { id: "phone", label: "脱敏手机号" }];
const invalid = computed(() => {
  if (!startDate.value || !endDate.value) return "请选择开始和结束日期";
  const days = (Date.parse(endDate.value) - Date.parse(startDate.value)) / 86_400_000 + 1;
  if (!Number.isFinite(days) || days < 1 || days > 366) return "日期范围须为 1 至 366 天，开始日期不能晚于结束日期";
  if (!sections.value.length) return "请至少选择一个工作表";
  if (sections.value.includes("detail") && !fields.value.length) return "请为领取明细至少选择一个字段";
  return "";
});
function recent(days: number) { endDate.value = getTodayDateKeyInBeijing(); startDate.value = shift(endDate.value, 1 - days); }
function refreshPreview(delay = 0) {
  const version = ++previewVersion;
  clearTimeout(previewTimer); previewController?.abort();
  reportFile.value = undefined; previewSheets.value = []; previewError.value = ""; success.value = "";
  previewBusy.value = !invalid.value && visible.value && !!session.token;
  if (!previewBusy.value) return;
  const filters = { startDate: startDate.value, endDate: endDate.value, fields: [...fields.value], sections: [...sections.value] };
  previewTimer = setTimeout(async () => {
    previewController = new AbortController();
    try {
      const [file, reader] = await Promise.all([
        adminApi.exportPickups(filters, session.token!, previewController.signal),
        import("../utils/pickup-workbook-preview")
      ]);
      if (version !== previewVersion) return;
      const sheets = await reader.readPickupWorkbook(await file.blob.arrayBuffer());
      if (version !== previewVersion) return;
      previewSheets.value = sheets; reportFile.value = file;
    } catch (cause) {
      if (version === previewVersion) previewError.value = cause instanceof Error ? cause.message : "预览生成失败";
    } finally { if (version === previewVersion) previewBusy.value = false; }
  }, delay);
}
watch(() => [startDate.value, endDate.value, fields.value.join(","), sections.value.join(","), session.token, visible.value], () => refreshPreview(450), { immediate: true });
onBeforeUnmount(() => { ++previewVersion; clearTimeout(previewTimer); previewController?.abort(); });
async function download() {
  error.value = ""; success.value = "";
  if (invalid.value) { error.value = invalid.value; return; }
  if (!reportFile.value || busy.value) return;
  busy.value = true;
  try {
    const file = reportFile.value;
    const url = URL.createObjectURL(file.blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = file.filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    success.value = "Excel 已生成，请查看浏览器下载。";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "导出失败，请重试"; }
  finally { busy.value = false; }
}
</script>

<template>
  <details v-if="visible" class="pickup-export admin-page__section" open>
    <summary class="pickup-export__summary"><strong>导出领取报告</strong><span>选择日期和内容，下载 Excel</span></summary>
    <form class="pickup-export__form" @submit.prevent="download">
      <fieldset :disabled="busy">
        <legend>时间范围</legend>
        <div class="pickup-export__dates">
          <label>开始日期<input v-model="startDate" type="date" required :max="endDate || undefined" /></label>
          <label>结束日期<input v-model="endDate" type="date" required :min="startDate || undefined" /></label>
          <button type="button" class="admin-button admin-button--ghost" @click="recent(7)">最近 7 天</button>
          <button type="button" class="admin-button admin-button--ghost" @click="recent(30)">最近 30 天</button>
        </div>
        <p class="admin-copy">包含起止业务日，单次最多 366 天。日期从旧到新，同一天内领取时间从早到晚。</p>
      </fieldset>
      <fieldset :disabled="busy">
        <legend>工作表</legend>
        <div class="pickup-export__choices">
          <label><input v-model="sections" type="checkbox" value="detail" />领取明细（第一个工作表）</label>
          <label><input v-model="sections" type="checkbox" value="overview" />领取概览（统计、物资及每日领取情况）</label>
        </div>
      </fieldset>
      <fieldset :disabled="busy || !sections.includes('detail')">
        <legend>明细字段</legend>
        <div class="pickup-export__choices"><label v-for="field in fieldOptions" :key="field.id"><input v-model="fields" type="checkbox" :value="field.id" />{{ field.label }}</label></div>
        <p class="pickup-export__subheading">额外字段 · 默认不勾选</p>
        <div class="pickup-export__choices"><label v-for="field in extras" :key="field.id"><input v-model="fields" type="checkbox" :value="field.id" />{{ field.label }}</label></div>
      </fieldset>
      <fieldset :disabled="busy">
        <legend>独立汇总表 · 默认不勾选</legend>
        <div class="pickup-export__choices">
          <label><input v-model="sections" type="checkbox" value="people" />按人员汇总（领取天数、人次、件数及物资）</label>
          <label><input v-model="sections" type="checkbox" value="devices" />按柜机汇总（服务人数、人次、件数及物资）</label>
        </div>
      </fieldset>
      <p class="admin-copy">保留按天交替底色、浅色格线和左侧留白。未核对的领取时间会在报告中提示，不导出关门时间、结算时间或领取小时。</p>
      <p v-if="error" class="pickup-export__error" role="alert">{{ error }}</p>
      <p v-else-if="invalid" class="pickup-export__error" role="status">{{ invalid }}</p>
      <p v-if="success" role="status">{{ success }}</p>
      <button class="admin-button" type="submit" :disabled="busy || previewBusy || !!invalid || !reportFile">{{ previewBusy ? '正在生成 Excel…' : '导出 Excel' }}</button>
    </form>
    <PickupWorkbookPreview :sheets="previewSheets" :loading="previewBusy" :error="previewError" :invalid="invalid" @refresh="refreshPreview()" />
  </details>
</template>

<style scoped>
.pickup-export { display: block; min-width: 0; }
.pickup-export__summary { cursor: pointer; padding: 4px 0; }
.pickup-export__summary strong { margin-right: 14px; }
.pickup-export__summary span { color: var(--text-muted, #657479); font-size: .9rem; }
.pickup-export__form { display: grid; gap: 16px; margin-top: 20px; }
.pickup-export fieldset { min-width: 0; margin: 0; padding: 12px 16px 16px; border: 1px solid var(--border-color, #dce5e5); border-radius: 10px; }
.pickup-export legend { padding: 0 6px; font-weight: 600; }
.pickup-export__dates, .pickup-export__choices { display: flex; gap: 14px 22px; flex-wrap: wrap; align-items: center; }
.pickup-export__dates { align-items: end; }
.pickup-export__dates label { display: grid; gap: 6px; }
.pickup-export__dates input { min-width: 160px; padding: 9px 12px; border: 1px solid #bdcaca; border-radius: 6px; font: inherit; color: inherit; background: transparent; }
.pickup-export__choices label { display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; }
.pickup-export input[type=checkbox] { width: 17px; height: 17px; accent-color: #337f84; flex-shrink: 0; }
.pickup-export__subheading { margin: 14px 0 6px; color: var(--text-muted, #657479); }
.pickup-export__error { color: #b42318; }
.pickup-export__form > button { justify-self: start; }
@media(max-width:600px) { .pickup-export__summary span { display: block; margin-top: 6px; } .pickup-export__dates label { flex: 1 1 100%; } .pickup-export__choices { gap: 8px; flex-direction: column; align-items: start; } .pickup-export__form > button { width: 100%; } }
</style>
