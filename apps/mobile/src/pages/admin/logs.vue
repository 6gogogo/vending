<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { OperationLogCategory, OperationLogRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { operationLogStatusLabelMap } from "../../constants/labels";
import { formatBeijingDateTime } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const logs = ref<OperationLogRecord[]>([]);
const loading = ref(false);
const selectedCategory = ref<OperationLogCategory | "all">("all");

const categories: Array<{ value: OperationLogCategory | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pickup", label: "领取" },
  { value: "restock", label: "补货" },
  { value: "device", label: "柜机" },
  { value: "alert", label: "任务" },
  { value: "inventory", label: "库存" },
  { value: "user", label: "人员" },
  { value: "goods", label: "货品" }
];

const statusToneClassMap: Record<OperationLogRecord["status"], string> = {
  success: "vm-status--success",
  pending: "vm-status--pending",
  warning: "vm-status--warning",
  failed: "vm-status--danger"
};

const logCardToneClassMap: Record<OperationLogRecord["status"], string> = {
  success: "log-item--success",
  pending: "log-item--pending",
  warning: "log-item--warning",
  failed: "log-item--failed"
};

const formatLogTime = (occurredAt: string) => {
  const minutePrecision = formatBeijingDateTime(occurredAt);
  const timestamp = Date.parse(occurredAt);

  if (minutePrecision === "-" || !Number.isFinite(timestamp)) {
    return minutePrecision;
  }

  const seconds = String(new Date(timestamp).getUTCSeconds()).padStart(2, "0");
  return `${minutePrecision}:${seconds}`;
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin") {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    logs.value = await mobileApi.logs(
      selectedCategory.value === "all" ? undefined : { category: selectedCategory.value }
    );
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const openDetail = (id: string) => {
  uni.navigateTo({
    url: `/pages/admin/log-detail?id=${id}`
  });
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="日志记录" title="日志总览" subtitle="可按日志类型筛选，并进入详情页查看关联信息。">
    <GlassCard tone="accent">
      <view class="filter-grid">
        <button
          v-for="item in categories"
          :key="item.value"
          class="filter-chip"
          :class="{ 'filter-chip--active': selectedCategory === item.value }"
          @tap="selectedCategory = item.value; load()"
        >
          {{ item.label }}
        </button>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view v-if="logs.length" class="log-list">
          <button
            v-for="log in logs"
            :key="log.id"
            class="log-item"
            :class="logCardToneClassMap[log.status]"
            @tap="openDetail(log.id)"
          >
            <view class="log-item__header">
              <text class="log-item__title">{{ log.description }}</text>
              <text class="vm-status log-item__status" :class="statusToneClassMap[log.status]">
                {{ operationLogStatusLabelMap[log.status] }}
              </text>
            </view>
            <text class="log-item__meta">{{ formatLogTime(log.occurredAt) }}</text>
          </button>
        </view>
        <EmptyState v-else :title="loading ? '正在加载日志' : '暂无匹配日志'" description="可切换分类筛选，或等待新的日志写入后再查看。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.filter-grid,
.log-list {
  display: grid;
  gap: 16rpx;
}

.filter-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12rpx;
}

.filter-chip {
  min-height: 72rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
  font-size: 26rpx;
}

.filter-chip--active {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
  color: var(--vm-info);
}

.log-item {
  display: grid;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
  text-align: left;
}

.log-item--success {
  border-color: var(--vm-success-line);
  background: var(--vm-success-bg);
}

.log-item--pending,
.log-item--warning {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.log-item--failed {
  border-color: var(--vm-danger-line);
  background: var(--vm-danger-bg);
}

.log-item__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
}

.log-item__title {
  flex: 1;
  min-width: 0;
  font-size: 28rpx;
  color: var(--vm-text);
}

.log-item__status {
  flex: 0 0 auto;
}

.log-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>

