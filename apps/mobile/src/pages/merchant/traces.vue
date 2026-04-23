<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const loading = ref(false);
const batches = ref<Array<{
  batchId: string;
  goodsId: string;
  goodsName: string;
  deviceCode: string;
  deviceName: string;
  quantity: number;
  remainingQuantity: number;
  expiresAt?: string;
  createdAt: string;
}>>([]);
const logs = ref<Array<{ id: string; description: string; occurredAt: string }>>([]);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    const response = await mobileApi.merchantRestockTraces();
    batches.value = response.batches;
    logs.value = response.logs.slice(0, 20).map((entry) => ({
      id: entry.id,
      description: entry.description,
      occurredAt: entry.occurredAt
    }));
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="货物去向" title="我的补货与去向" subtitle="可查看自己补货批次、当前剩余量以及相关操作日志。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">补货批次</text>
          <text class="vm-subtitle">优先关注剩余量和临近到期的批次。</text>
        </view>

        <view v-if="batches.length" class="trace-list">
          <view v-for="item in batches" :key="item.batchId" class="trace-item">
            <view class="trace-item__main">
              <text class="trace-item__title">{{ item.goodsName }}</text>
              <text class="trace-item__meta">
                {{ item.deviceName }} · 入柜 {{ item.quantity }} 件 · 剩余 {{ item.remainingQuantity }} 件
              </text>
              <text class="trace-item__meta">
                {{ item.expiresAt ? `到期 ${item.expiresAt.slice(0, 10)}` : "未设置保质期" }} · {{ item.createdAt.slice(0, 16).replace('T', ' ') }}
              </text>
            </view>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载批次' : '还没有补货批次'" description="完成首次补货登记后，这里会展示你的批次去向和剩余量。" />
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">相关日志</text>
          <text class="vm-subtitle">系统会同步记录补货、异常和处理过程。</text>
        </view>

        <view v-if="logs.length" class="trace-list">
          <view v-for="log in logs" :key="log.id" class="trace-item">
            <text class="trace-item__title">{{ log.description }}</text>
            <text class="trace-item__meta">{{ log.occurredAt.slice(0, 16).replace('T', ' ') }}</text>
          </view>
        </view>
        <EmptyState v-else title="暂无相关日志" description="系统有新记录时，这里会自动更新。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.trace-item__main {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title,
.trace-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.trace-list {
  display: grid;
  gap: 16rpx;
}

.trace-item {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.trace-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>

