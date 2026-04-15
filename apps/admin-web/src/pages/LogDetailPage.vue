<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { CallbackLogRecord, OperationLogRecord, SystemAuditLogEntry } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { resolveActorLink, resolveSubjectLink } from "../utils/entity-links";

const route = useRoute();
const log = ref<OperationLogRecord>();
const loading = ref(false);
const undoing = ref(false);
const relatedAuditLogs = ref<SystemAuditLogEntry[]>([]);
const relatedCallbackLogs = ref<CallbackLogRecord[]>([]);

const resolveActorRoute = (entry?: OperationLogRecord) => resolveActorLink(entry?.actor);

const formatLogStatus = (status?: OperationLogRecord["status"]) =>
  status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";

const undoStateLabel = (entry?: OperationLogRecord) => {
  const state = entry?.metadata?.undoState;

  if (state === "undoable") {
    return "可撤销";
  }

  if (state === "undone") {
    return "已撤销";
  }

  return "不可撤销";
};

const deviceCode = computed(() => {
  if (typeof log.value?.metadata?.deviceCode === "string") {
    return log.value.metadata.deviceCode;
  }

  if (log.value?.primarySubject?.type === "device") {
    return log.value.primarySubject.id;
  }

  if (log.value?.secondarySubject?.type === "device") {
    return log.value.secondarySubject.id;
  }

  return "";
});

const logIdentityTokens = computed(() => {
  const tokens = new Set<string>();

  if (log.value?.relatedOrderNo) {
    tokens.add(log.value.relatedOrderNo);
  }

  if (log.value?.relatedEventId) {
    tokens.add(log.value.relatedEventId);
  }

  if (log.value?.primarySubject?.id) {
    tokens.add(log.value.primarySubject.id);
  }

  if (log.value?.secondarySubject?.id) {
    tokens.add(log.value.secondarySubject.id);
  }

  return Array.from(tokens);
});

const stringifyForSearch = (value: unknown) => {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const formatJsonBlock = (value: unknown) => {
  if (value === undefined || value === null) {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const load = async () => {
  loading.value = true;
  try {
    log.value = await adminApi.logDetail(String(route.params.logId));
    if (deviceCode.value) {
      const [auditLogs, callbackLogs] = await Promise.all([
        adminApi.systemAuditLogs({ deviceCode: deviceCode.value, limit: 150 }),
        adminApi.deviceCallbackLogs(deviceCode.value, 150)
      ]);

      const matchesCurrentLog = (value: unknown) =>
        logIdentityTokens.value.some((token) => stringifyForSearch(value).includes(token));

      relatedAuditLogs.value = auditLogs.filter((entry) =>
        [entry.path, entry.body, entry.response, entry.error, entry.metadata].some((item) =>
          matchesCurrentLog(item)
        )
      );
      relatedCallbackLogs.value = callbackLogs.filter((entry) => matchesCurrentLog(entry.payload));
    } else {
      relatedAuditLogs.value = [];
      relatedCallbackLogs.value = [];
    }
  } finally {
    loading.value = false;
  }
};

const undoLog = async () => {
  if (!log.value) {
    return;
  }

  undoing.value = true;
  try {
    await adminApi.undoLog(log.value.id);
    await load();
  } finally {
    undoing.value = false;
  }
};

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section v-if="log" class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">日志主体</span>
            <h3 class="admin-panel__title">{{ log.description }}</h3>
          </div>
          <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
            {{ formatLogStatus(log.status) }}
          </span>
        </div>

        <div class="admin-kv">
          <div class="admin-kv__row">
            <span class="admin-kv__label">发生时间</span>
            <span class="admin-kv__value admin-code">{{ log.occurredAt.slice(0, 19).replace("T", " ") }}</span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">动作人</span>
            <span class="admin-kv__value">
              <RouterLink v-if="resolveActorRoute(log)" class="admin-link" :to="resolveActorRoute(log)!">
                {{ log.actor.name }}
              </RouterLink>
              <span v-else>{{ log.actor.name }}</span>
              <span class="admin-table__subtext">{{ log.actor.type }} · {{ log.type }}</span>
            </span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">详细说明</span>
            <span class="admin-kv__value">{{ log.detail }}</span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">撤销状态</span>
            <span class="admin-kv__value">{{ undoStateLabel(log) }}</span>
          </div>
          <div v-if="log.metadata" class="admin-kv__row">
            <span class="admin-kv__label">底层元数据</span>
            <span class="admin-kv__value">
              <pre class="log-detail__pre">{{ formatJsonBlock(log.metadata) }}</pre>
            </span>
          </div>
          <div v-if="log.relatedOrderNo || log.relatedEventId" class="admin-kv__row">
            <span class="admin-kv__label">关联业务编号</span>
            <span class="admin-kv__value admin-code">
              {{ log.relatedOrderNo ? `订单 ${log.relatedOrderNo}` : "" }}
              {{ log.relatedEventId ? ` · 事件 ${log.relatedEventId}` : "" }}
            </span>
          </div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">主体跳转</span>
              <h3 class="admin-panel__title">关联对象</h3>
            </div>
          </div>
          <div class="admin-list">
            <div v-if="log.primarySubject" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">主体一</span>
                <span class="admin-list__meta">{{ log.primarySubject.type }} · {{ log.primarySubject.id }}</span>
              </div>
              <RouterLink v-if="resolveSubjectLink(log.primarySubject)" class="admin-link" :to="resolveSubjectLink(log.primarySubject)!">
                {{ log.primarySubject.label }}
              </RouterLink>
            </div>
            <div v-if="log.secondarySubject" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">主体二</span>
                <span class="admin-list__meta">{{ log.secondarySubject.type }} · {{ log.secondarySubject.id }}</span>
              </div>
              <RouterLink v-if="resolveSubjectLink(log.secondarySubject)" class="admin-link" :to="resolveSubjectLink(log.secondarySubject)!">
                {{ log.secondarySubject.label }}
              </RouterLink>
            </div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">底层记录</span>
              <h3 class="admin-panel__title">相关系统审计与平台回调</h3>
            </div>
          </div>
          <div class="admin-list">
            <div v-if="relatedAuditLogs.length" class="log-detail__trace-list">
              <article v-for="entry in relatedAuditLogs" :key="`${entry.occurredAt}-${entry.path}`" class="log-detail__trace-card">
                <div class="log-detail__trace-head">
                  <span class="admin-code">{{ entry.occurredAt.slice(0, 19).replace("T", " ") }}</span>
                  <span class="admin-pill" :class="entry.path.startsWith('/external/smartvm') ? 'admin-pill--success' : 'admin-pill--neutral'">
                    {{ entry.path.startsWith("/external/smartvm") ? "发" : "收" }}
                  </span>
                  <span class="admin-table__subtext">{{ entry.path }}</span>
                </div>
                <div class="log-detail__trace-grid">
                  <pre class="log-detail__pre">{{ formatJsonBlock(entry.body) }}</pre>
                  <pre class="log-detail__pre">{{ formatJsonBlock(entry.response ?? entry.error) }}</pre>
                </div>
              </article>
            </div>
            <span v-else class="admin-table__subtext">暂无关联系统审计。</span>

            <div v-if="relatedCallbackLogs.length" class="log-detail__trace-list">
              <article v-for="entry in relatedCallbackLogs" :key="entry.id" class="log-detail__trace-card">
                <div class="log-detail__trace-head">
                  <span class="admin-code">{{ entry.receivedAt.slice(0, 19).replace("T", " ") }}</span>
                  <span class="admin-pill admin-pill--neutral">平台回调</span>
                  <span class="admin-table__subtext">{{ entry.type }}</span>
                </div>
                <pre class="log-detail__pre">{{ formatJsonBlock(entry.payload) }}</pre>
              </article>
            </div>
            <span v-else class="admin-table__subtext">暂无关联平台回调。</span>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">操作</span>
              <h3 class="admin-panel__title">撤销与继续追踪</h3>
            </div>
          </div>
          <div class="admin-list">
            <button
              v-if="log.metadata?.undoState === 'undoable'"
              class="admin-button admin-button--ghost"
              :disabled="undoing"
              @click="undoLog"
            >
              {{ undoing ? "撤销中" : "撤销这条操作" }}
            </button>
            <span v-else class="admin-table__subtext">{{ undoStateLabel(log) }}</span>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">回到列表</span>
              <h3 class="admin-panel__title">继续追踪</h3>
            </div>
          </div>
          <div class="admin-list">
            <RouterLink class="admin-link" to="/logs">返回日志总览</RouterLink>
          </div>
        </article>
      </aside>
    </section>

    <div v-else class="admin-empty">
      <div class="admin-empty__title">{{ loading ? "正在加载日志详情" : "未找到对应日志" }}</div>
      <div class="admin-empty__body">请返回日志总览重新选择，或确认日志编号是否正确。</div>
    </div>
  </section>
</template>

<style scoped>
.log-detail__pre {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 320px;
}

.log-detail__trace-list {
  display: grid;
  gap: 10px;
  max-height: 60vh;
  overflow: auto;
}

.log-detail__trace-card {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.log-detail__trace-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.log-detail__trace-grid {
  display: grid;
  gap: 8px;
}
</style>
