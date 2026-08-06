<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { DeviceRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";

const route = useRoute();
const sessionStore = useAdminSessionStore();
const device = ref<DeviceRecord>();
const loading = ref(false);
const loadError = ref("");

const roleLabel = computed(() =>
  sessionStore.user?.backofficeRole === "restocker" ? "补货员" : "商户"
);
const deviceStatusLabel = computed(() => {
  if (!device.value) return "状态待确认";
  if (device.value.readiness?.blocker === "offline" || device.value.status === "offline") return "离线";
  if (device.value.readiness?.blocker === "maintenance" || device.value.status === "maintenance") return "维护中";
  if (device.value.readiness?.blocker === "stale") return "状态已过期";
  return "平台已识别";
});
const deviceStatusClass = computed(() => {
  if (!device.value || device.value.status === "offline") return "admin-pill--danger";
  if (device.value.readiness?.blocker === "maintenance" || device.value.readiness?.blocker === "stale") {
    return "admin-pill--warning";
  }
  return "admin-pill--success";
});
const doorStateLabel = (doorState?: "open" | "closed" | "unknown") => {
  if (doorState === "open") return "门已开";
  if (doorState === "closed") return "门已关";
  return "门状态未知";
};
const load = async () => {
  loading.value = true;
  loadError.value = "";
  try {
    device.value = await adminApi.assignedDeviceDetail(String(route.params.deviceCode));
  } catch (error) {
    device.value = undefined;
    loadError.value = readErrorMessage(error, "无法读取该柜机。请确认它仍分配给当前账号后重试。");
  } finally {
    loading.value = false;
  }
};

watch(
  () => route.params.deviceCode,
  () => void load()
);

onMounted(() => void load());
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">{{ roleLabel }}已分配柜机</p>
          <h3 class="admin-page__section-title">柜机状态与库存</h3>
          <p class="admin-copy">只显示当前账号已分配的柜机；设备变更、远程操作和完整审计由实例管理员处理。</p>
        </div>
        <div class="admin-toolbar">
          <RouterLink class="admin-button admin-button--ghost" to="/operations">返回柜机列表</RouterLink>
          <button class="admin-button" type="button" :disabled="loading" @click="load">
            {{ loading ? "刷新中" : "重新读取" }}
          </button>
        </div>
      </div>

      <div v-if="loadError" class="admin-alert admin-alert--danger" role="alert" aria-live="assertive" aria-atomic="true">
        <div>
          <strong>柜机详情未加载</strong>
          <p>{{ loadError }}</p>
        </div>
        <button class="admin-button" type="button" :disabled="loading" @click="load">重新读取</button>
      </div>

      <div v-else-if="loading && !device" class="admin-empty" role="status" aria-live="polite">正在读取已分配柜机…</div>

      <template v-else-if="device">
        <div class="assigned-device-summary">
          <section class="admin-panel admin-panel-block">
            <p class="admin-kicker">柜机</p>
            <h4 class="assigned-device-summary__title">{{ device.name }}</h4>
            <p class="admin-copy admin-code">{{ device.deviceCode }}</p>
            <p class="admin-copy">{{ device.location }}{{ device.address ? ` · ${device.address}` : "" }}</p>
          </section>
          <section class="admin-panel admin-panel-block">
            <p class="admin-kicker">运行状态</p>
            <p><span class="admin-pill" :class="deviceStatusClass">{{ deviceStatusLabel }}</span></p>
            <p class="admin-copy">{{ doorStateLabel(device.runtime?.doorState) }}</p>
            <p class="admin-copy">最近平台确认：{{ formatDateTime(device.lastSeenAt) }}</p>
          </section>
          <section class="admin-panel admin-panel-block">
            <p class="admin-kicker">最近记录</p>
            <p class="admin-copy">最近开门：{{ formatDateTime(device.runtime?.lastOpenedAt) }}</p>
            <p class="admin-copy">最近关门：{{ formatDateTime(device.runtime?.lastClosedAt) }}</p>
            <p class="admin-copy">最近刷新：{{ formatDateTime(device.runtime?.lastRefreshAt) }}</p>
          </section>
        </div>

        <section class="admin-panel admin-panel-block assigned-device-stock">
          <div class="admin-page__section-head">
            <div>
              <p class="admin-kicker">货门与库存</p>
              <h4 class="admin-page__section-title">当前已分配柜机的可见库存</h4>
            </div>
          </div>
          <div v-if="!device.doors.length" class="admin-empty">该柜机暂未配置货门或货品。</div>
          <div v-else class="assigned-device-doors">
            <section v-for="door in device.doors" :key="door.doorNum" class="assigned-device-door">
              <div class="assigned-device-door__head">
                <strong>{{ door.label || `门 ${door.doorNum}` }}</strong>
                <span class="admin-code">{{ door.doorNum }} 号门</span>
              </div>
              <table v-if="door.goods.length" class="admin-table">
                <thead>
                  <tr>
                    <th>货品</th>
                    <th>库存</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="goods in door.goods" :key="goods.goodsId">
                    <td>
                      <strong>{{ goods.name }}</strong>
                      <span class="admin-table__subtext">{{ goods.goodsId }}</span>
                    </td>
                    <td class="admin-code">{{ goods.stock }}</td>
                    <td>{{ goods.expiringSoon ? "临期" : goods.stock <= 0 ? "缺货" : "可用" }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="admin-copy">当前货门没有可显示的货品。</p>
            </section>
          </div>
        </section>
      </template>
    </section>
  </section>
</template>

<style scoped>
.assigned-device-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.assigned-device-summary__title {
  margin: 0;
  font-size: 1.1rem;
}

.assigned-device-stock {
  margin-top: 14px;
}

.assigned-device-doors {
  display: grid;
  gap: 12px;
}

.assigned-device-door {
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel-muted);
}

.assigned-device-door__head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

@media (max-width: 860px) {
  .assigned-device-summary {
    grid-template-columns: 1fr;
  }
}
</style>
