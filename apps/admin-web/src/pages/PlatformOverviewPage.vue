<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import type { PlatformOverviewSnapshot } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { formatDateTime } from "../utils/datetime";

const loading = ref(false);
const errorMessage = ref("");
const overview = ref<PlatformOverviewSnapshot>();

const tenants = computed(() => overview.value?.tenants ?? []);
const totals = computed(() => overview.value?.totals);

const statusLabel = (status: "active" | "trial" | "paused") => {
  if (status === "active") return "运行中";
  if (status === "trial") return "试运行";
  return "已暂停";
};

const load = async () => {
  loading.value = true;
  errorMessage.value = "";

  try {
    overview.value = await adminApi.platformOverview();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "服务商总览加载失败。";
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-grid admin-grid--four">
      <article class="admin-panel stat-card">
        <span class="admin-kicker">客户实例</span>
        <strong>{{ totals?.tenants ?? 0 }}</strong>
        <span class="admin-copy">运行中 {{ totals?.activeTenants ?? 0 }}</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">柜机总数</span>
        <strong>{{ totals?.devices ?? 0 }}</strong>
        <span class="admin-copy">在线 {{ totals?.onlineDevices ?? 0 }}</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">服务对象</span>
        <strong>{{ totals?.users ?? 0 }}</strong>
        <span class="admin-copy">商家 {{ totals?.merchants ?? 0 }}</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">待处理事项</span>
        <strong>{{ totals?.pendingTasks ?? 0 }}</strong>
        <span class="admin-copy">跨实例汇总</span>
      </article>
    </section>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">客户实例</p>
          <h3 class="admin-page__section-title">按公司查看使用情况</h3>
        </div>
        <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
          {{ loading ? "刷新中" : "刷新" }}
        </button>
      </div>

      <div v-if="errorMessage" class="admin-note platform-overview__error">{{ errorMessage }}</div>

      <article class="admin-panel admin-panel-block">
        <table v-if="tenants.length" class="admin-table">
          <thead>
            <tr>
              <th>公司实例</th>
              <th>状态</th>
              <th>柜机</th>
              <th>人员</th>
              <th>库存/领取</th>
              <th>最后活动</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in tenants" :key="entry.tenant.id">
              <td>
                <span class="admin-table__strong">{{ entry.tenant.name }}</span>
                <span class="admin-table__subtext">{{ entry.tenant.code }} · {{ entry.tenant.instanceUrl ?? "未配置实例地址" }}</span>
              </td>
              <td>
                <span class="admin-pill" :class="entry.tenant.status === 'active' ? 'admin-pill--success' : entry.tenant.status === 'trial' ? 'admin-pill--warning' : 'admin-pill--neutral'">
                  {{ statusLabel(entry.tenant.status) }}
                </span>
              </td>
              <td>{{ entry.metrics.onlineDevices }}/{{ entry.metrics.devices }}</td>
              <td>{{ entry.metrics.users }} 人 / 商家 {{ entry.metrics.merchants }}</td>
              <td>{{ entry.metrics.inventoryUnits }} 件 / 领取 {{ entry.metrics.pickupCount }}</td>
              <td class="admin-code">{{ entry.lastActivityAt ? formatDateTime(entry.lastActivityAt) : "-" }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载客户实例" : "暂无客户实例" }}</div>
          <div class="admin-empty__body">客户实例接入后会在这里展示各自使用情况和汇总数据。</div>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.stat-card {
  display: grid;
  gap: 8px;
}

.stat-card strong {
  font-size: 2rem;
  line-height: 1;
  color: var(--admin-text);
}

.platform-overview__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}
</style>
