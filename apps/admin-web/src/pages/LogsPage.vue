<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { OperationLogCategory, OperationLogRecord, OperationLogStatus, OperationLogSubject } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { resolveActorLink, resolveSubjectLink } from "../utils/entity-links";

const route = useRoute();
const router = useRouter();
const sessionStore = useAdminSessionStore();

const logs = ref<OperationLogRecord[]>([]);
const loading = ref(false);
const undoingLogId = ref("");
const exporting = ref(false);
const category = ref<"" | OperationLogCategory>("");
const status = ref<"" | OperationLogStatus>("");
const subjectType = ref<"" | OperationLogSubject["type"]>("");
const subjectId = ref("");

const resolveActorRoute = (log: OperationLogRecord) => resolveActorLink(log.actor);

const formatLogStatus = (value: OperationLogRecord["status"]) =>
  value === "success" ? "成功" : value === "warning" ? "预警" : value === "failed" ? "失败" : "待处理";

const undoStateLabel = (log: OperationLogRecord) => {
  const state = log.metadata?.undoState;

  if (state === "undoable") {
    return "可撤销";
  }

  if (state === "undone") {
    return "已撤销";
  }

  return "不可撤销";
};

const syncFromRoute = () => {
  category.value = (route.query.category as OperationLogCategory | undefined) ?? "";
  status.value = (route.query.status as OperationLogStatus | undefined) ?? "";
  subjectType.value = (route.query.subjectType as OperationLogSubject["type"] | undefined) ?? "";
  subjectId.value = typeof route.query.subjectId === "string" ? route.query.subjectId : "";
};

const load = async () => {
  loading.value = true;
  try {
    logs.value = await adminApi.logs({
      category: category.value || undefined,
      status: status.value || undefined,
      subjectType: subjectType.value || undefined,
      subjectId: subjectId.value || undefined
    });
  } finally {
    loading.value = false;
  }
};

const applyFilters = async () => {
  await router.push({
    path: "/logs",
    query: {
      category: category.value || undefined,
      status: status.value || undefined,
      subjectType: subjectType.value || undefined,
      subjectId: subjectId.value || undefined
    }
  });
};

const exportLogs = async () => {
  if (!sessionStore.token) {
    window.alert("操作失败：登录状态已失效");
    return;
  }

  exporting.value = true;
  try {
    const exported = await adminApi.exportLogs(sessionStore.token, {
      category: category.value || undefined,
      status: status.value || undefined,
      subjectType: subjectType.value || undefined,
      subjectId: subjectId.value || undefined
    });
    const url = window.URL.createObjectURL(exported.blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = exported.filename;
    link.click();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    exporting.value = false;
  }
};

const undoLog = async (logId: string) => {
  if (!window.confirm("确认撤销这条操作记录？")) {
    return;
  }
  undoingLogId.value = logId;
  try {
    await adminApi.undoLog(logId);
    await load();
  } finally {
    undoingLogId.value = "";
  }
};

watch(
  () => route.fullPath,
  async () => {
    syncFromRoute();
    await load();
  }
);

onMounted(async () => {
  syncFromRoute();
  await load();
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">筛选日志</p>
          <h3 class="admin-page__section-title">默认按时间倒序展示全部日志</h3>
        </div>
      </div>

      <div class="logs-filters admin-panel admin-panel-block">
        <label class="admin-field">
          <span class="admin-field__label">分类</span>
          <select v-model="category" class="admin-select">
            <option value="">全部</option>
            <option value="pickup">取货</option>
            <option value="restock">补货</option>
            <option value="device">柜机</option>
            <option value="admin">管理员</option>
            <option value="alert">预警</option>
            <option value="inventory">库存</option>
            <option value="user">人员</option>
            <option value="policy">策略</option>
            <option value="goods">货品</option>
          </select>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">状态</span>
          <select v-model="status" class="admin-select">
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="pending">待完成</option>
            <option value="warning">预警</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">主体类型</span>
          <select v-model="subjectType" class="admin-select">
            <option value="">全部</option>
            <option value="user">人员</option>
            <option value="device">柜机</option>
            <option value="event">事件</option>
            <option value="alert">预警</option>
            <option value="goods">货品</option>
            <option value="warehouse">仓库</option>
            <option value="stocktake">盘点</option>
          </select>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">主体编号</span>
          <input v-model="subjectId" class="admin-input" placeholder="例如 CAB-1001 / special-001 / evt-001" />
        </label>
        <div class="logs-filters__actions">
          <button class="admin-button" @click="applyFilters">应用筛选</button>
          <button class="admin-button admin-button--ghost" :disabled="exporting" @click="exportLogs">
            {{ exporting ? "导出中" : "导出 Excel" }}
          </button>
        </div>
      </div>
    </section>

    <section class="admin-page__section">
      <article class="admin-panel admin-panel-block">
        <table v-if="logs.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>动作人</th>
              <th>主体</th>
              <th>状态</th>
              <th>撤销</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log.id">
              <td class="admin-code">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</td>
              <td>
                <RouterLink class="admin-link" :to="`/logs/${log.id}`">{{ log.description }}</RouterLink>
                <span class="admin-table__subtext">{{ log.detail }}</span>
              </td>
              <td>
                <RouterLink v-if="resolveActorRoute(log)" class="admin-link" :to="resolveActorRoute(log)!">
                  {{ log.actor.name }}
                </RouterLink>
                <span v-else>{{ log.actor.name }}</span>
                <span class="admin-table__subtext">{{ log.actor.type }} · {{ log.category }}</span>
              </td>
              <td>
                <div class="admin-inline-links">
                  <RouterLink
                    v-if="resolveSubjectLink(log.primarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.primarySubject)!"
                  >
                    {{ log.primarySubject?.label }}
                  </RouterLink>
                  <RouterLink
                    v-if="resolveSubjectLink(log.secondarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.secondarySubject)!"
                  >
                    {{ log.secondarySubject?.label }}
                  </RouterLink>
                  <span v-if="!log.primarySubject && !log.secondarySubject">-</span>
                </div>
              </td>
              <td>
                <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                  {{ formatLogStatus(log.status) }}
                </span>
                <span class="admin-table__subtext">{{ undoStateLabel(log) }}</span>
              </td>
              <td>
                <button
                  v-if="log.metadata?.undoState === 'undoable'"
                  class="admin-button admin-button--ghost"
                  :disabled="undoingLogId === log.id"
                  @click="undoLog(log.id)"
                >
                  {{ undoingLogId === log.id ? "撤销中" : "撤销" }}
                </button>
                <span v-else class="admin-table__subtext">{{ undoStateLabel(log) }}</span>
              </td>
              <td>
                <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载日志" : "没有符合条件的日志" }}</div>
          <div class="admin-empty__body">请调整筛选条件，或等待新的操作、回调和处理动作产生后再查看。</div>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.logs-filters {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.logs-filters__actions {
  display: grid;
  gap: 8px;
  align-self: end;
}

@media (max-width: 1024px) {
  .logs-filters {
    grid-template-columns: 1fr;
  }
}
</style>
