<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { DeviceRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";

const devices = ref<DeviceRecord[]>([]);
const loading = ref(false);
const lastUpdatedAt = ref("");

let timer: ReturnType<typeof setInterval> | undefined;

const sortedDevices = computed(() =>
  [...devices.value].sort((left, right) => {
    if (left.status === right.status) {
      return left.deviceCode.localeCompare(right.deviceCode);
    }

    if (left.status === "online") {
      return -1;
    }

    if (right.status === "online") {
      return 1;
    }

    return left.deviceCode.localeCompare(right.deviceCode);
  })
);

const totalStock = (device: DeviceRecord) =>
  device.doors.flatMap((door) => door.goods).reduce((sum, goods) => sum + goods.stock, 0);

const previewGoods = (device: DeviceRecord) => device.doors.flatMap((door) => door.goods).slice(0, 5);

const remainingGoodsCount = (device: DeviceRecord) =>
  Math.max(0, device.doors.flatMap((door) => door.goods).length - 5);

const formatStatus = (status: DeviceRecord["status"]) =>
  status === "online" ? "在线" : status === "maintenance" ? "维护中" : "离线";

const formatDoorState = (doorState?: "open" | "closed" | "unknown") => {
  if (doorState === "open") {
    return "门已开";
  }

  if (doorState === "closed") {
    return "门已关";
  }

  return "门状态未知";
};

const formatGoodsStock = (goods: DeviceRecord["doors"][number]["goods"][number]) => {
  const base =
    goods.thresholdEnabled && goods.lowStockThreshold !== undefined
      ? `${goods.stock}/${goods.lowStockThreshold}`
      : `${goods.stock}`;
  const tags: string[] = [];

  if (
    (goods.thresholdEnabled && goods.lowStockThreshold !== undefined && goods.stock <= goods.lowStockThreshold) ||
    goods.stock <= 0
  ) {
    tags.push("缺货");
  }

  if (goods.expiringSoon) {
    tags.push("临期");
  }

  return tags.length ? `${base}（${tags.join("，")}）` : base;
};

const hasDoorWarning = (device: DeviceRecord) =>
  device.runtime?.doorState === "closed" &&
  Boolean(device.runtime.lastCommandAt) &&
  device.runtime.openedAfterLastCommand === false;

const load = async () => {
  loading.value = true;
  try {
    devices.value = await adminApi.devices();
    lastUpdatedAt.value = new Date().toLocaleString("zh-CN", {
      hour12: false
    });
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await load();
  timer = setInterval(load, 8_000);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">柜机面板</p>
          <h3 class="admin-page__section-title">每列一个柜机，集中查看状态、门状态和货品数量</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">自动刷新 8 秒一次</span>
          <span class="admin-copy">最近刷新：{{ lastUpdatedAt || "尚未加载" }}</span>
          <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
            {{ loading ? "刷新中" : "立即刷新" }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="sortedDevices.length" class="operations-grid">
      <article v-for="device in sortedDevices" :key="device.deviceCode" class="admin-panel admin-panel-block operations-card">
        <div class="operations-card__head">
          <div>
            <h3 class="operations-card__title">{{ device.name }}</h3>
            <p class="admin-copy admin-code">{{ device.deviceCode }} · {{ device.location }}</p>
          </div>
          <div class="admin-inline-links">
            <span
              class="admin-pill"
              :class="device.status === 'online' ? 'admin-pill--success' : device.status === 'maintenance' ? 'admin-pill--warning' : 'admin-pill--danger'"
            >
              {{ formatStatus(device.status) }}
            </span>
            <span class="admin-pill" :class="device.runtime?.doorState === 'open' ? 'admin-pill--warning' : 'admin-pill--neutral'">
              {{ formatDoorState(device.runtime?.doorState) }}
            </span>
          </div>
        </div>

        <div class="operations-card__rows">
          <div class="operations-card__row">
            <span>总库存</span>
            <strong class="admin-code">{{ totalStock(device) }}</strong>
          </div>
          <div class="operations-card__row">
            <span>最近在线</span>
            <span class="admin-code">{{ device.lastSeenAt.slice(0, 16).replace("T", " ") }}</span>
          </div>
          <div class="operations-card__row">
            <span>最近开门</span>
            <span class="admin-code">{{ device.runtime?.lastOpenedAt ? device.runtime.lastOpenedAt.slice(0, 16).replace("T", " ") : "-" }}</span>
          </div>
          <div class="operations-card__row">
            <span>最近关门</span>
            <span class="admin-code">{{ device.runtime?.lastClosedAt ? device.runtime.lastClosedAt.slice(0, 16).replace("T", " ") : "-" }}</span>
          </div>
        </div>

        <div v-if="hasDoorWarning(device)" class="admin-note operations-card__warning">
          该柜机最近一次开门后未收到“门已打开”确认。
        </div>

        <table class="admin-table operations-card__table">
          <thead>
            <tr>
              <th>货品</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="goods in previewGoods(device)" :key="goods.goodsId">
              <td>
                <span class="admin-table__strong">{{ goods.name }}</span>
                <span class="admin-table__subtext">{{ goods.goodsId }}</span>
              </td>
              <td class="admin-code">{{ formatGoodsStock(goods) }}</td>
            </tr>
            <tr v-if="remainingGoodsCount(device)">
              <td colspan="2" class="admin-code">其余 {{ remainingGoodsCount(device) }} 个货品请进入详情页查看</td>
            </tr>
          </tbody>
        </table>

        <div class="operations-card__actions">
          <RouterLink class="admin-link" :to="`/operations/${device.deviceCode}`">详情</RouterLink>
          <RouterLink class="admin-link" :to="`/logs?subjectType=device&subjectId=${device.deviceCode}`">日志</RouterLink>
        </div>
      </article>
    </section>

    <div v-else class="admin-empty">
      <div class="admin-empty__title">{{ loading ? "正在加载柜机列表" : "当前没有柜机数据" }}</div>
      <div class="admin-empty__body">请确认设备种子数据或模拟设备是否已经写入。</div>
    </div>
  </section>
</template>

<style scoped>
.operations-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 8px;
}

.operations-card {
  display: grid;
  gap: 10px;
}

.operations-card__head,
.operations-card__row,
.operations-card__actions {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.operations-card__head {
  align-items: flex-start;
}

.operations-card__title {
  margin: 0 0 4px;
  font-size: 1rem;
}

.operations-card__rows {
  display: grid;
  gap: 0;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  overflow: hidden;
}

.operations-card__row {
  padding: 8px 10px;
  border-bottom: 1px solid var(--admin-line);
  background: var(--admin-panel-muted);
  color: var(--admin-muted);
}

.operations-card__row:last-child {
  border-bottom: 0;
}

.operations-card__table :deep(td:last-child),
.operations-card__table :deep(th:last-child) {
  width: 72px;
}

.operations-card__actions {
  align-items: center;
}

.operations-card__warning {
  background: #fff7e8;
  border-color: #efcf8d;
  color: #8e6414;
}
</style>
