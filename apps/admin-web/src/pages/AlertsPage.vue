<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { AlertTask } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";

const sessionStore = useAdminSessionStore();
const alerts = ref<AlertTask[]>([]);
const loading = ref(false);
const resolvingId = ref("");
const activeAlert = ref<AlertTask>();
const loadError = ref("");
const actionMessage = ref<{ type: "success" | "error"; text: string }>();
const canManageAlerts = computed(() => sessionStore.can("alerts:manage"));

const openAlerts = computed(() => alerts.value.filter((alert) => alert.status !== "resolved"));
const resolvedAlerts = computed(() => alerts.value.filter((alert) => alert.status === "resolved"));
const gradeCount = (grade: AlertTask["grade"]) => openAlerts.value.filter((alert) => alert.grade === grade).length;
const resolveLabel = (alert: AlertTask) => (alert.grade === "fault" ? "标记已知晓" : "手动完成");
const statusLabel = (alert: AlertTask) => alert.status === "open" ? "待处理" : alert.status === "acknowledged" ? "已知晓" : "已完成";
const gradeLabel = (alert: AlertTask) => alert.grade === "fault" ? "故障" : alert.grade === "feedback" ? "反馈" : "预警";
const load = async () => {
  loading.value = true;
  loadError.value = "";
  try {
    alerts.value = await adminApi.alerts();
  } catch (error) {
    loadError.value = readErrorMessage(error, "任务列表加载失败");
  } finally {
    loading.value = false;
  }
};

const resolve = async (alert: AlertTask) => {
  if (resolvingId.value) {
    return;
  }

  if (!canManageAlerts.value) {
    actionMessage.value = {
      type: "error",
      text: "当前账号没有预警处理权限，不能处理待办。"
    };
    return;
  }

  if (!window.confirm(alert.grade === "fault" ? "确认标记为已知晓？该任务仍会保留在未完成列表，需要继续跟进设备状态。" : `确认${resolveLabel(alert)}？完成后会移入最近已完成记录。`)) return;
  resolvingId.value = alert.id;
  actionMessage.value = undefined;
  try {
    await adminApi.resolveAlert(alert.id);
    await load();
    actionMessage.value = {
      type: "success",
      text: alert.grade === "fault"
        ? "已标记为知晓。故障类任务仍会保留为未完成，请继续到柜机、日志或现场流程跟进。"
        : "待办已完成，记录已移入最近已完成。"
    };
  } catch (error) {
    actionMessage.value = {
      type: "error",
      text: `处理失败：${readErrorMessage(error, "请稍后重试")}`
    };
  } finally {
    resolvingId.value = "";
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
          <h3 class="admin-page__section-title">未完成任务优先，故障与反馈可直接查看完整详情</h3>
        </div>
        <p class="admin-copy">{{ loading ? "任务列表正在刷新。" : "处理按钮统一需要二次确认。" }}</p>
      </div>
      <div v-if="loadError" class="admin-alert admin-alert--danger">
        {{ loadError }}
        <button class="admin-text-button" type="button" @click="load">重试</button>
      </div>
      <div v-if="actionMessage" class="admin-alert" :class="{ 'admin-alert--danger': actionMessage.type === 'error' }">
        {{ actionMessage.text }}
      </div>

      <div class="admin-grid admin-grid--stats-4">
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">未完成任务</span>
          <h3 class="admin-page__section-title">{{ openAlerts.length }}</h3>
          <p class="admin-copy">开放和已知晓都算未完成。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">故障</span>
          <h3 class="admin-page__section-title">{{ gradeCount("fault") }}</h3>
          <p class="admin-copy">设备故障与回调异常。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">反馈</span>
          <h3 class="admin-page__section-title">{{ gradeCount("feedback") }}</h3>
          <p class="admin-copy">用户或商家反馈的问题。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">预警</span>
          <h3 class="admin-page__section-title">{{ gradeCount("warning") }}</h3>
          <p class="admin-copy">库存、临期等提醒。</p>
        </article>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">待办处理台</span>
            <h3 class="admin-panel__title">未完成任务始终排在前面</h3>
          </div>
        </div>

        <div v-if="openAlerts.length" class="admin-list">
          <div v-for="alert in openAlerts" :key="alert.id" class="admin-list__row">
            <div class="admin-list__main">
              <span class="admin-list__title">{{ alert.title }}</span>
              <span class="admin-list__meta">{{ alert.previewDetail || alert.detail }}</span>
              <span class="admin-list__meta">截止时间 {{ formatDateTime(alert.dueAt) }}</span>
            </div>
            <div class="alerts-actions">
              <span class="admin-pill" :class="alert.grade === 'fault' ? 'admin-pill--danger' : alert.grade === 'feedback' ? 'admin-pill--warning' : 'admin-pill--neutral'">{{ gradeLabel(alert) }}</span>
              <span class="admin-pill" :class="alert.status === 'open' ? 'admin-pill--warning' : 'admin-pill--neutral'">{{ statusLabel(alert) }}</span>
              <button class="admin-button admin-button--ghost" @click="activeAlert = alert">详情</button>
              <button v-if="canManageAlerts" class="admin-button admin-button--ghost" :disabled="resolvingId === alert.id" @click="resolve(alert)">{{ resolvingId === alert.id ? "处理中" : resolveLabel(alert) }}</button>
              <span v-else class="admin-table__subtext">需要预警处理权限</span>
            </div>
          </div>
        </div>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在刷新任务" : "当前没有未完成任务" }}</div>
          <div class="admin-empty__body">说明故障、反馈和预警都已处理完毕。</div>
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
            <div class="admin-note">优先处理故障，再处理反馈，最后处理库存和临期预警。</div>
            <div class="admin-note">故障类只表示“已知晓并接手”，不表示设备已经恢复。</div>
            <div class="admin-note">完整备注和详情统一放在详情弹层，列表只展示摘要。</div>
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
                <span class="admin-list__meta">{{ alert.previewDetail || alert.detail }}</span>
              </div>
              <span class="admin-pill admin-pill--success">已完成</span>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">暂时还没有已完成记录</div>
            <div class="admin-empty__body">完成一次任务闭环后，这里会保留最近结果。</div>
          </div>
        </article>
      </aside>
    </section>

    <div v-if="activeAlert" class="alerts-modal-backdrop">
      <section class="alerts-modal admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">{{ gradeLabel(activeAlert) }}</span>
            <h3 class="admin-panel__title">{{ activeAlert.title }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="activeAlert = undefined">关闭</button>
        </div>
        <div class="admin-kv">
          <div class="admin-kv__row">
            <span class="admin-kv__label">状态</span>
            <span class="admin-kv__value">{{ statusLabel(activeAlert) }}</span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">截止时间</span>
            <span class="admin-kv__value admin-code">{{ formatDateTime(activeAlert.dueAt) }}</span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">详细内容</span>
            <span class="admin-kv__value alerts-detail">{{ activeAlert.detail }}</span>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.alerts-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.alerts-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.alerts-modal {
  width: min(720px, 100%);
  padding: 14px;
}

.alerts-detail {
  white-space: pre-wrap;
}
</style>
