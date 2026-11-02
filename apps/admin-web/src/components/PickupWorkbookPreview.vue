<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PreviewSheet } from "../utils/pickup-workbook-preview";

const props = defineProps<{ sheets: PreviewSheet[]; loading: boolean; error: string; invalid: string }>();
defineEmits<{ refresh: [] }>();
const activeName = ref("");
const zoom = ref(.85);
watch(() => props.sheets, sheets => {
  if (sheets.length && !sheets.some(sheet => sheet.name === activeName.value)) activeName.value = sheets[0].name;
});
const active = computed(() => props.sheets.find(sheet => sheet.name === activeName.value));
const maximum = computed(() => Math.max(1, ...active.value?.chart?.points.map(point => point.value) ?? []));
</script>

<template>
  <section id="excel-preview" class="workbook-preview" aria-label="Excel 预览" :aria-busy="loading">
    <header class="workbook-preview__header">
      <div><h3>Excel 预览</h3><p>与本次下载使用同一份文件，修改选项后自动更新。</p></div>
      <div class="workbook-preview__tools">
        <label>缩放 <select v-model.number="zoom" aria-label="预览缩放"><option :value=".65">65%</option><option :value=".85">85%</option><option :value="1">100%</option></select></label>
        <button type="button" class="admin-button admin-button--ghost" :disabled="loading || !!invalid" @click="$emit('refresh')">刷新预览</button>
      </div>
    </header>
    <p v-if="invalid" class="workbook-preview__state" role="status">{{ invalid }}</p>
    <p v-else-if="loading" class="workbook-preview__state" role="status">正在生成 Excel 预览…</p>
    <p v-else-if="error" class="workbook-preview__state workbook-preview__error" role="alert">{{ error }}，可点击“刷新预览”重试。</p>
    <template v-else-if="active">
      <div class="workbook-preview__scroll" tabindex="0" :aria-label="`${active.name}预览，可横向滚动`">
        <div :style="{ width: `${active.width * zoom}px`, height: `${active.height * zoom}px` }">
          <div class="workbook-preview__sheet" :style="{ width: `${active.width}px`, transform: `scale(${zoom})` }">
            <table :aria-label="active.name" :style="{ width: `${active.width}px` }">
              <colgroup><col style="width:42px" /><col v-for="column in active.columns" :key="column.label" :style="{ width: `${column.width}px` }" /></colgroup>
              <thead><tr><th></th><th v-for="column in active.columns" :key="column.label" scope="col">{{ column.label }}</th></tr></thead>
              <tbody><tr v-for="row in active.rows" :key="row.number" :style="{ height: `${row.height}px` }">
                <th scope="row">{{ row.number }}</th>
                <td v-for="cell in row.cells" :key="cell.address" :colspan="cell.colspan" :rowspan="cell.rowspan" :style="cell.style">{{ cell.text }}</td>
              </tr></tbody>
            </table>
            <svg v-if="active.chart" class="workbook-preview__chart" :style="{ left: `${active.chart.left}px`, top: `${active.chart.top}px`, width: `${active.chart.width}px`, height: `${active.chart.height}px` }" viewBox="0 0 500 250" role="img" aria-label="每日领取件数柱状图">
              <rect width="500" height="250" fill="white" />
              <g v-for="tick in [0, 1, 2, 3, 4]" :key="tick"><line x1="35" x2="490" :y1="210 - tick * 45" :y2="210 - tick * 45" stroke="#dde5e8" /><text x="28" :y="214 - tick * 45" text-anchor="end">{{ +(maximum * tick / 4).toFixed(1) }}</text></g>
              <g v-for="(point, i) in active.chart.points" :key="i">
                <rect :x="40 + i * 450 / active.chart.points.length" :y="210 - point.value / maximum * 180" :width="450 / active.chart.points.length * .65" :height="point.value / maximum * 180" fill="#337f84"><title>{{ point.date }}：{{ point.value }} 件</title></rect>
                <text v-if="active.chart.points.length <= 14" :x="40 + (i + .325) * 450 / active.chart.points.length" :y="203 - point.value / maximum * 180" text-anchor="middle">{{ point.value }}</text>
                <text v-if="i % Math.max(1, Math.ceil(active.chart.points.length / 8)) === 0" :x="40 + (i + .325) * 450 / active.chart.points.length" y="233" text-anchor="middle">{{ point.date }}</text>
              </g>
            </svg>
          </div>
        </div>
      </div>
      <nav class="workbook-preview__tabs" aria-label="预览工作表"><button v-for="sheet in sheets" :key="sheet.name" type="button" :aria-pressed="activeName === sheet.name" @click="activeName = sheet.name">{{ sheet.name }}</button></nav>
      <p class="workbook-preview__caption">{{ active.name }} · {{ active.totalRows > 100 ? `预览前 100 行，共 ${active.totalRows} 行；下载包含完整内容。` : '已显示全部内容。' }} 可滚动查看，概览图表在网页中重绘。</p>
    </template>
  </section>
</template>

<style scoped>
.workbook-preview { width: 100%; min-width: 0; max-width: 100%; margin-top: 28px; border: 1px solid var(--admin-line, #dce5e5); border-radius: 12px; overflow: hidden; background: white; }
.workbook-preview__header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; padding: 20px; }
.workbook-preview__header h3 { font-size: 17px; margin: 0 0 6px; }
.workbook-preview__header p, .workbook-preview__caption { margin: 0; font-size: 12px; color: var(--admin-muted, #627482); }
.workbook-preview__tools { display: flex; gap: 12px; align-items: center; font-size: 13px; }
.workbook-preview__tools select { margin-left: 5px; padding: 7px; border: 1px solid #cdd7dd; border-radius: 6px; background: white; color: inherit; }
.workbook-preview__scroll { max-height: 480px; overflow: auto; border-block: 1px solid #dce5e5; background: #f0f3f5; }
.workbook-preview__sheet { position: relative; transform-origin: top left; font-family: "Microsoft YaHei", sans-serif; }
.workbook-preview table { table-layout: fixed; border-collapse: collapse; margin: 0; }
.workbook-preview th, .workbook-preview td { border: 1px solid #e4e9ed; padding: 0 5px; vertical-align: middle; overflow: hidden; text-overflow: clip; }
.workbook-preview th { background: #f0f3f5; color: #627482; font-size: 11px; font-weight: 400; text-align: center; }
.workbook-preview thead tr { height: 28px; }
.workbook-preview__chart { position: absolute; pointer-events: auto; }
.workbook-preview__chart text { font-size: 11px; fill: #243b4a; }
.workbook-preview__tabs { display: flex; overflow-x: auto; padding: 0 14px; background: #f6f8f9; border-bottom: 1px solid #dce5e5; }
.workbook-preview__tabs button { flex-shrink: 0; padding: 13px 18px; border: 0; border-bottom: 3px solid transparent; background: transparent; font: inherit; font-size: 13px; color: #627482; cursor: pointer; }
.workbook-preview__tabs button[aria-pressed=true] { color: #087f6e; background: white; border-bottom-color: #087f6e; font-weight: 600; }
.workbook-preview__caption { padding: 12px 20px; }
.workbook-preview__state { margin: 0; padding: 55px 20px; text-align: center; color: #627482; }
.workbook-preview__error { color: #b42318; }
@media(max-width:600px) { .workbook-preview__header { padding: 16px; } .workbook-preview__scroll { max-height: 400px; } .workbook-preview__caption { padding: 12px 16px; } }
</style>
