<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import type { InventoryMovement, MerchantGoodsTemplate, OperationLogRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";

const loading = ref(false);
const errorMessage = ref("");
const templates = ref<MerchantGoodsTemplate[]>([]);
const traces = ref<{
  batches: Array<{
    batchId: string;
    goodsId: string;
    goodsName: string;
    deviceCode: string;
    deviceName: string;
    quantity: number;
    remainingQuantity: number;
    expiresAt?: string;
    createdAt: string;
  }>;
  records: InventoryMovement[];
  logs: OperationLogRecord[];
  dailySummary: Array<{
    dateKey: string;
    claimedUnits: number;
    helpedUsers: number;
    helpTimes: number;
    cumulativeHelpTimes: number;
  }>;
  cumulativeHelpTimes: number;
}>();

const activeTemplates = computed(() => templates.value.filter((entry) => entry.status === "active"));
const donatedUnits = computed(() =>
  traces.value?.records
    .filter((entry) => entry.type === "donation" || entry.type === "manual-restock")
    .reduce((sum, entry) => sum + entry.quantity, 0) ?? 0
);
const claimedUnits = computed(() =>
  traces.value?.dailySummary.reduce((sum, entry) => sum + entry.claimedUnits, 0) ?? 0
);
const load = async () => {
  loading.value = true;
  errorMessage.value = "";

  try {
    const [templateResponse, traceResponse] = await Promise.all([
      adminApi.merchantTemplates(),
      adminApi.merchantRestockTraces()
    ]);

    templates.value = templateResponse;
    traces.value = traceResponse;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "商家后台数据加载失败。";
  } finally {
    loading.value = false;
  }
};

const formatDate = (value?: string) => {
  if (!value) {
    return "-";
  }

  return value.slice(0, 16).replace("T", " ");
};

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="merchant-page admin-grid">
    <div v-if="errorMessage" class="admin-note merchant-page__error">{{ errorMessage }}</div>

    <section class="admin-grid admin-grid--stats-4">
      <article class="admin-panel stat-card">
        <span class="admin-kicker">可用模板</span>
        <strong>{{ activeTemplates.length }}</strong>
        <span class="admin-copy">当前可用于补货登记的货品模板</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">累计补货</span>
        <strong>{{ donatedUnits }}</strong>
        <span class="admin-copy">按商家补货记录统计</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">被领取件数</span>
        <strong>{{ claimedUnits }}</strong>
        <span class="admin-copy">来自批次去向追踪</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">实例任务</span>
        <strong aria-label="由实例管理员统一处理">—</strong>
        <span class="admin-copy">由实例管理员统一处理</span>
      </article>
    </section>

    <section class="admin-panel admin-panel-block">
      <div class="admin-panel__head">
        <div>
          <span class="admin-kicker">补货批次</span>
          <h3 class="admin-panel__title">最近入柜记录</h3>
        </div>
        <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
          {{ loading ? "刷新中" : "刷新" }}
        </button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>柜机</th>
              <th>数量</th>
              <th>剩余</th>
              <th>到期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in traces?.batches.slice(0, 8)" :key="batch.batchId">
              <td>{{ batch.goodsName }}</td>
              <td>{{ batch.deviceName }}</td>
              <td>{{ batch.quantity }}</td>
              <td>{{ batch.remainingQuantity }}</td>
              <td>{{ formatDate(batch.expiresAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!traces?.batches.length" class="admin-empty">
        <div class="admin-empty__title">暂无补货批次</div>
      </div>
    </section>

    <section class="admin-grid admin-grid--two">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">货品模板</span>
            <h3 class="admin-panel__title">可补货清单</h3>
          </div>
        </div>
        <div v-if="activeTemplates.length" class="admin-list">
          <div v-for="template in activeTemplates.slice(0, 8)" :key="template.id" class="admin-list__row">
            <div class="admin-list__main">
              <span class="admin-list__title">{{ template.goodsName }}</span>
              <span class="admin-list__meta">{{ template.defaultQuantity }} 件 / 保质期 {{ template.defaultShelfLifeDays }} 天</span>
            </div>
            <span class="admin-pill admin-pill--success">可用</span>
          </div>
        </div>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">暂无可用模板</div>
          <div class="admin-empty__body">当前没有启用的补货货品模板。</div>
        </div>
      </article>

      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">任务提醒</span>
            <h3 class="admin-panel__title">任务由实例管理员统一处理</h3>
          </div>
        </div>
        <div class="admin-empty">
          <div class="admin-empty__body">当前账号可查看本人补货记录；需要处理任务时请联系实例管理员。</div>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.merchant-page__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}

.stat-card {
  display: grid;
  gap: 8px;
}

.stat-card strong {
  font-size: 2rem;
  line-height: 1;
  color: var(--admin-text);
}
</style>
