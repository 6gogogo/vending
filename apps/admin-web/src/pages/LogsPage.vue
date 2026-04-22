<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { OperationLogCategory, OperationLogRecord, OperationLogStatus, OperationLogSubject } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { resolveActorLink, resolveSubjectLink } from "../utils/entity-links";
import { formatDateTime } from "../utils/datetime";
import {
  buildLogContextSummary,
  buildLogReferenceSummary,
  buildLogSubjectSummary,
  formatActorTypeLabel,
  formatLogCategoryLabel
} from "../utils/business-context";

const route = useRoute();
const router = useRouter();
const sessionStore = useAdminSessionStore();

const logs = ref<OperationLogRecord[]>([]);
const loading = ref(false);
const undoingLogId = ref("");
const exporting = ref(false);
const exportingSystem = ref(false);
const category = ref<"" | OperationLogCategory>("");
const status = ref<"" | OperationLogStatus>("");
const subjectType = ref<"" | OperationLogSubject["type"]>("");
const subjectId = ref("");
const dateFrom = ref("");
const dateTo = ref("");

const resolveActorRoute = (log: OperationLogRecord) => resolveActorLink(log.actor);
const logContextSummary = (log: OperationLogRecord) =>
  buildLogContextSummary(log) || buildLogSubjectSummary(log) || "未识别到明确业务对象";
const logReferenceSummary = (log: OperationLogRecord) => buildLogReferenceSummary(log);
const logSubjectSummary = (log: OperationLogRecord) => buildLogSubjectSummary(log);

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
  dateFrom.value = typeof route.query.dateFrom === "string" ? route.query.dateFrom : "";
  dateTo.value = typeof route.query.dateTo === "string" ? route.query.dateTo : "";
};

const load = async () => {
  loading.value = true;
  try {
    logs.value = await adminApi.logs({
      category: category.value || undefined,
      status: status.value || undefined,
      subjectType: subjectType.value || undefined,
      subjectId: subjectId.value || undefined,
      dateFrom: dateFrom.value || undefined,
      dateTo: dateTo.value || undefined
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
      subjectId: subjectId.value || undefined,
      dateFrom: dateFrom.value || undefined,
      dateTo: dateTo.value || undefined
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
      subjectId: subjectId.value || undefined,
      dateFrom: dateFrom.value || undefined,
      dateTo: dateTo.value || undefined
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

const exportSystemLogs = async () => {
  if (!sessionStore.token) {
    window.alert("操作失败：登录状态已失效");
    return;
  }

  exportingSystem.value = true;
  try {
    const exported = await adminApi.exportSystemAuditLog(sessionStore.token);
    const url = window.URL.createObjectURL(exported.blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = exported.filename;
    link.click();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    exportingSystem.value = false;
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

      <div class="admin-note">
        日志列表默认优先展示商品、服务对象和柜机信息，订单号、事件号与主体编号保留在追溯信息中。
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
          <input v-model="subjectId" class="admin-input" placeholder="例如 CAB-1001 / special-001 / goods-1001" />
        </label>
        <label class="admin-field">
          <span class="admin-field__label">起始业务日</span>
          <input v-model="dateFrom" type="date" class="admin-input" />
        </label>
        <label class="admin-field">
          <span class="admin-field__label">结束业务日</span>
          <input v-model="dateTo" type="date" class="admin-input" />
        </label>
        <div class="logs-filters__actions">
          <button class="admin-button" @click="applyFilters">应用筛选</button>
          <button class="admin-button admin-button--ghost" :disabled="exporting" @click="exportLogs">
            {{ exporting ? "导出中" : "导出 Excel" }}
          </button>
          <button class="admin-button admin-button--ghost" :disabled="exportingSystem" @click="exportSystemLogs">
            {{ exportingSystem ? "下载中" : "下载完整日志" }}
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
              <th>业务对象</th>
              <th>状态</th>
              <th>撤销</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in logs" :key="log.id">
              <td class="admin-code">{{ formatDateTime(log.occurredAt) }}</td>
              <td>
                <div class="admin-context-main">
                  <RouterLink class="admin-link" :to="`/logs/${log.id}`">{{ log.description }}</RouterLink>
                </div>
                <div class="logs-actor-line">
                  <RouterLink v-if="resolveActorRoute(log)" class="admin-link" :to="resolveActorRoute(log)!">
                    {{ log.actor.name }}
                  </RouterLink>
                  <span v-else>{{ log.actor.name }}</span>
                  <span class="admin-table__subtext">{{ formatActorTypeLabel(log.actor.type) }} · {{ formatLogCategoryLabel(log.category) }} · {{ log.type }}</span>
                </div>
              </td>
              <td>
                <span class="admin-context-main">{{ logContextSummary(log) }}</span>
                <span v-if="logSubjectSummary(log)" class="admin-context-meta">{{ logSubjectSummary(log) }}</span>
                <span v-if="logReferenceSummary(log)" class="admin-context-meta admin-code">{{ logReferenceSummary(log) }}</span>
                <div class="admin-inline-links">
                  <RouterLink
                    v-if="resolveSubjectLink(log.primarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.primarySubject)!"
                  >
                    主体一
                  </RouterLink>
                  <RouterLink
                    v-if="resolveSubjectLink(log.secondarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.secondarySubject)!"
                  >
                    主体二
                  </RouterLink>
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
                <span class="admin-table__subtext">{{ log.detail }}</span>
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

.logs-actor-line {
  display: grid;
  gap: 4px;
  margin-top: 4px;
}

@media (max-width: 1024px) {
  .logs-filters {
    grid-template-columns: 1fr;
  }
}
</style>
