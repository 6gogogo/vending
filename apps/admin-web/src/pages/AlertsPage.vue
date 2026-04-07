<script setup lang="ts">
import { onMounted, ref } from "vue";

import { adminApi } from "../api/admin";

const alerts = ref<Array<{ id: string; title: string; detail: string; dueAt: string; status: string }>>([]);

const load = async () => {
  alerts.value = await adminApi.alerts();
};

const resolve = async (id: string) => {
  await adminApi.resolveAlert(id);
  await load();
};

onMounted(load);
</script>

<template>
  <section class="page">
    <header>
      <span class="admin-pill">预警流转</span>
      <h1 class="admin-title">过期与回调异常任务</h1>
      <p class="admin-subtitle">这个页面强调处理效率而不是装饰性，目标是帮助工作人员尽快清掉待办任务。</p>
    </header>

    <article class="admin-card panel">
      <div v-for="alert in alerts" :key="alert.id" class="row">
        <div>
          <strong>{{ alert.title }}</strong>
          <p class="admin-subtitle">{{ alert.detail }}</p>
        </div>
        <div class="row__actions">
          <span class="admin-pill">{{ alert.dueAt.slice(0, 10) }}</span>
          <button class="admin-button admin-button--ghost" @click="resolve(alert.id)">标记已处理</button>
        </div>
      </div>
    </article>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 24px;
}

.panel {
  padding: 24px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: center;
  padding: 18px 0;
  border-bottom: 1px solid var(--admin-line);
}

.row p {
  margin: 0.45rem 0 0;
}

.row__actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

@media (max-width: 900px) {
  .row,
  .row__actions {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
