<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import type { CabinetEventRecord, DeviceRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";

interface CallbackLogRow {
  id: string;
  type: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

const devices = ref<DeviceRecord[]>([]);
const events = ref<CabinetEventRecord[]>([]);
const callbackLogs = ref<CallbackLogRow[]>([]);
const loading = ref(false);
const lastUpdatedAt = ref("");

let timer: ReturnType<typeof setInterval> | undefined;

const formatTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    hour12: false
  });

const summarizeCallback = (entry: CallbackLogRow) => {
  const payload = entry.payload;
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "-";
  const orderNo = typeof payload.orderNo === "string" ? payload.orderNo : "-";
  const deviceCode = typeof payload.deviceCode === "string" ? payload.deviceCode : "-";
  const status = typeof payload.status === "string" ? payload.status : "-";

  return `设备 ${deviceCode} / 事件 ${eventId} / 订单 ${orderNo} / 状态 ${status}`;
};

const load = async () => {
  loading.value = true;

  try {
    const [deviceResponse, eventResponse, callbackResponse] = await Promise.all([
      adminApi.devices(),
      adminApi.events(),
      adminApi.callbackLogs()
    ]);

    devices.value = deviceResponse;
    events.value = eventResponse.slice(0, 12);
    callbackLogs.value = callbackResponse;
    lastUpdatedAt.value = new Date().toLocaleString("zh-CN", {
      hour12: false
    });
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await load();
  timer = setInterval(load, 3_000);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});
</script>

<template>
  <section class="page">
    <header class="page__hero">
      <div>
        <span class="admin-pill">联调监控</span>
        <h1 class="admin-title">柜机状态、开柜事件和回调日志</h1>
      </div>
      <p class="admin-subtitle page__lead">
        这个页面每 3 秒自动刷新一次，适合在你用小程序点“开柜”时同步盯后台变化。
      </p>
    </header>

    <p class="admin-subtitle">最近刷新：{{ lastUpdatedAt || "尚未加载" }}{{ loading ? " · 刷新中" : "" }}</p>

    <div class="grid">
      <article class="admin-card panel">
        <div class="panel__header">
          <div>
            <span class="admin-pill">设备</span>
            <h2 class="panel__title">柜机库存与在线状态</h2>
          </div>
        </div>

        <div class="stack">
          <div v-for="device in devices" :key="device.deviceCode" class="row row--device">
            <div>
              <strong>{{ device.name }}</strong>
              <p class="admin-subtitle">{{ device.deviceCode }} · {{ device.location }}</p>
              <p class="admin-subtitle">
                最近心跳：{{ formatTime(device.lastSeenAt) }}
              </p>
            </div>
            <div class="meta">
              <span class="admin-pill">{{ device.status }}</span>
              <div class="goods-list">
                <span v-for="goods in device.doors[0]?.goods ?? []" :key="goods.goodsId" class="goods-pill">
                  {{ goods.name }}：{{ goods.stock }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </article>

      <article class="admin-card panel">
        <div class="panel__header">
          <div>
            <span class="admin-pill">事件</span>
            <h2 class="panel__title">最近开柜记录</h2>
          </div>
        </div>

        <div class="stack">
          <div v-for="event in events" :key="event.eventId" class="row">
            <div>
              <strong>{{ event.orderNo }}</strong>
              <p class="admin-subtitle">{{ event.eventId }}</p>
              <p class="admin-subtitle">
                {{ event.deviceCode }} / {{ event.role }} / {{ formatTime(event.updatedAt) }}
              </p>
            </div>
            <span class="admin-pill">{{ event.status }}</span>
          </div>
        </div>
      </article>

      <article class="admin-card panel">
        <div class="panel__header">
          <div>
            <span class="admin-pill">回调</span>
            <h2 class="panel__title">柜机回调日志</h2>
          </div>
        </div>

        <div class="stack">
          <div v-for="entry in callbackLogs" :key="entry.id" class="row">
            <div>
              <strong>{{ entry.type }}</strong>
              <p class="admin-subtitle">{{ summarizeCallback(entry) }}</p>
              <p class="admin-subtitle">{{ formatTime(entry.receivedAt) }}</p>
            </div>
            <span class="admin-pill">{{ entry.type }}</span>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 20px;
}

.page__hero {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 20px;
}

.page__lead {
  max-width: 38ch;
}

.grid {
  display: grid;
  gap: 20px;
}

.panel {
  padding: 22px;
}

.panel__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.panel__title {
  margin: 0.8rem 0 0;
  font-size: 1.5rem;
}

.stack {
  display: grid;
  gap: 14px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--admin-line);
}

.row--device {
  align-items: start;
}

.meta {
  display: grid;
  justify-items: end;
  gap: 12px;
}

.goods-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: end;
  gap: 8px;
}

.goods-pill {
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(13, 148, 136, 0.08);
  color: var(--admin-muted);
  font-size: 0.85rem;
}

@media (max-width: 1100px) {
  .page__hero,
  .row,
  .row--device {
    display: grid;
  }

  .meta,
  .goods-list {
    justify-items: start;
    justify-content: start;
  }
}
</style>
