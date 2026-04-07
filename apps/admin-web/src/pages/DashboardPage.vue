<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { DashboardSnapshot } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import SparkBars from "../components/charts/SparkBars.vue";
import { categoryLabelMap } from "../utils/labels";

const dashboard = ref<DashboardSnapshot>();

onMounted(async () => {
  dashboard.value = await adminApi.dashboard();
});
</script>

<template>
  <section class="page">
    <header class="page__hero">
      <div>
        <span class="admin-pill">实时总览</span>
        <h1 class="admin-title">街道公益柜运行情况一屏掌握。</h1>
      </div>
      <p class="admin-subtitle page__lead">
        当前首版先聚焦真实业务流、领取额度控制和过期预警，用户画像与布局建议接口已经预留，后续可继续扩展。
      </p>
    </header>

    <div v-if="dashboard" class="page__grid">
      <div class="page__stats">
        <StatTile title="活跃特殊群体" :value="dashboard.stats.activeSpecialUsers" hint="今日处于可用状态的登记用户" />
        <StatTile title="活跃商户" :value="dashboard.stats.activeMerchants" hint="可执行投放的商户账号" />
        <StatTile title="今日开柜事件" :value="dashboard.stats.todayOpenEvents" hint="今日累计开柜申请次数" />
        <StatTile title="待处理预警" :value="dashboard.stats.pendingAlerts" hint="需要人工跟进的任务" />
      </div>

      <article class="admin-card panel">
        <div class="panel__header">
          <div>
            <span class="admin-pill">近 7 天趋势</span>
            <h2 class="panel__title">领取与投放对比</h2>
          </div>
          <p class="admin-subtitle">在高级分析上线前，先保证基础报表足够能看、能用。</p>
        </div>
        <SparkBars :points="dashboard.weeklyTrend" />
      </article>

      <article class="admin-card panel">
        <div class="panel__header">
          <div>
            <span class="admin-pill">需求结构</span>
            <h2 class="panel__title">品类需求分布</h2>
          </div>
        </div>
        <div class="demand">
          <div v-for="item in dashboard.demandByCategory" :key="item.category" class="demand__row">
            <span>{{ categoryLabelMap[item.category] }}</span>
            <strong>{{ item.count }}</strong>
          </div>
        </div>
      </article>

      <article class="admin-card panel">
        <div class="panel__header">
          <div>
            <span class="admin-pill">预警队列</span>
            <h2 class="panel__title">当前待办</h2>
          </div>
        </div>
        <div class="alert-list">
          <div v-for="alert in dashboard.openAlerts" :key="alert.id" class="alert-list__row">
            <div>
              <strong>{{ alert.title }}</strong>
              <p class="admin-subtitle">{{ alert.detail }}</p>
            </div>
            <span class="admin-pill">{{ alert.dueAt.slice(5, 10) }}</span>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 24px;
}

.page__hero {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 24px;
  align-items: end;
}

.page__lead {
  max-width: 42ch;
}

.page__grid {
  display: grid;
  gap: 24px;
}

.page__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
}

.panel {
  padding: 22px;
}

.panel__header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.panel__title {
  margin: 0.8rem 0 0;
  font-size: 1.6rem;
}

.demand,
.alert-list {
  display: grid;
  gap: 14px;
}

.demand__row,
.alert-list__row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--admin-line);
}

@media (max-width: 1100px) {
  .page__hero,
  .page__stats {
    grid-template-columns: 1fr;
  }
}
</style>
