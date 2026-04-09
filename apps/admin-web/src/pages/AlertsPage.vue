<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminApi } from "../api/admin";

const alerts = ref<Array<{ id: string; title: string; detail: string; dueAt: string; status: string }>>([]);
const loading = ref(false);
const resolvingId = ref<string>();

const openAlerts = computed(() => alerts.value.filter((alert) => alert.status === "open"));
const resolvedAlerts = computed(() => alerts.value.filter((alert) => alert.status === "resolved"));

const load = async () => {
  loading.value = true;
  try {
    alerts.value = await adminApi.alerts();
  } finally {
    loading.value = false;
  }
};

const resolve = async (id: string) => {
  resolvingId.value = id;
  try {
    await adminApi.resolveAlert(id);
    await load();
  } finally {
    resolvingId.value = undefined;
  }
};

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">任务总览</p>
          <h3 class="admin-page__section-title">优先处理开放状态任务，减少库存浪费和状态断链</h3>
        </div>
        <p class="admin-copy">{{ loading ? "预警任务正在刷新。" : "建议按截止时间和异常影响程度逐项处理。" }}</p>
      </div>

      <div class="admin-grid admin-grid--stats-3">
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">开放任务</span>
          <h3 class="admin-page__section-title">{{ openAlerts.length }}</h3>
          <p class="admin-copy">需要立即跟进的任务数量。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">已处理任务</span>
          <h3 class="admin-page__section-title">{{ resolvedAlerts.length }}</h3>
          <p class="admin-copy">用于回顾处理节奏和执行闭环。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">任务总数</span>
          <h3 class="admin-page__section-title">{{ alerts.length }}</h3>
          <p class="admin-copy">包含开放和已解决的历史记录。</p>
        </article>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">待办处理台</span>
            <h3 class="admin-panel__title">开放任务</h3>
          </div>
        </div>

        <div v-if="openAlerts.length" class="admin-list">
          <div v-for="alert in openAlerts" :key="alert.id" class="admin-list__row">
            <div class="admin-list__main">
              <span class="admin-list__title">{{ alert.title }}</span>
              <span class="admin-list__meta">{{ alert.detail }}</span>
              <span class="admin-list__meta">截止时间 {{ alert.dueAt.slice(0, 16).replace("T", " ") }}</span>
            </div>
            <div class="alerts-actions">
              <span class="admin-pill admin-pill--warning">待处理</span>
              <button class="admin-button admin-button--ghost" :disabled="resolvingId === alert.id" @click="resolve(alert.id)">
                {{ resolvingId === alert.id ? "处理中" : "标记已处理" }}
              </button>
            </div>
          </div>
        </div>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在刷新预警任务" : "当前没有开放任务" }}</div>
          <div class="admin-empty__body">说明过期与异常任务已经清理完毕，可以转到其他模块继续巡检。</div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">处理提示</span>
              <h3 class="admin-panel__title">建议顺序</h3>
            </div>
          </div>
          <div class="admin-list">
            <div class="admin-note">先处理即将截止的到期任务，再处理纯状态类异常，避免造成物资浪费。</div>
            <div class="admin-note">处理完成后，建议切到“柜机监控”核对回调和事件状态是否同步闭环。</div>
            <div class="admin-note">如果同类任务反复出现，需要回到规则或设备台账核对源头配置。</div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">处理记录</span>
              <h3 class="admin-panel__title">最近已完成</h3>
            </div>
          </div>
          <div v-if="resolvedAlerts.length" class="admin-list">
            <div v-for="alert in resolvedAlerts.slice(0, 5)" :key="alert.id" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ alert.title }}</span>
                <span class="admin-list__meta">{{ alert.detail }}</span>
              </div>
              <span class="admin-pill admin-pill--neutral">已处理</span>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">暂时还没有已处理记录</div>
            <div class="admin-empty__body">完成一次任务闭环后，这里会保留最近处理结果。</div>
          </div>
        </article>
      </aside>
    </section>
  </section>
</template>

<style scoped>
.alerts-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
