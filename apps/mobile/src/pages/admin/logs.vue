<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { OperationLogCategory, OperationLogRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
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
  <MobileShell eyebrow="日志记录" title="移动端日志总览" subtitle="按时间查看全量日志，点击可进入详情并查看关联主体。">
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
          <button v-for="log in logs" :key="log.id" class="log-item" @tap="openDetail(log.id)">
            <text class="log-item__title">{{ log.description }}</text>
            <text class="log-item__meta">{{ log.occurredAt.slice(0, 16).replace('T', ' ') }} · {{ log.status }}</text>
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

.filter-chip {
  min-height: 80rpx;
  border-radius: 22rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  background: rgba(255, 252, 246, 0.88);
  font-size: 26rpx;
}

.filter-chip--active {
  border-color: rgba(47, 143, 102, 0.35);
  background: rgba(241, 251, 244, 0.98);
  color: var(--vm-accent-strong);
}

.log-item {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
  text-align: left;
}

.log-item__title {
  font-size: 28rpx;
  color: var(--vm-text);
}

.log-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>
