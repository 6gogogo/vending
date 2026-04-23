<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import { appCopy } from "../../constants/copy";
import { categoryLabelMap } from "../../constants/labels";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure } from "../../utils/operation-feedback";

const sessionStore = useSessionStore();
const records = ref<InventoryMovement[]>([]);
const loading = ref(false);

const groupedRecords = computed(() => {
  const groups = new Map<string, InventoryMovement[]>();

  for (const record of records.value) {
    const key = record.happenedAt.slice(0, 10);
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }

  return Array.from(groups.entries()).map(([date, items]) => ({
    date,
    items
  }));
});

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    records.value = await mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role);
  } catch (error) {
    showOperationFailure(error);
  } finally {
    loading.value = false;
  }
};

const formatDateTime = (value: string) => value.slice(11, 16);

onShow(load);
</script>

<template>
  <MobileShell eyebrow="服务记录" title="我的服务记录" :subtitle="appCopy.historyIntro">
    <GlassCard tone="quiet">
      <view class="history-tip">
        <text class="history-tip__title">记录说明</text>
        <text class="history-tip__body">按日期分组展示时间、柜机和数量，便于现场核对与回访留痕。</text>
      </view>
    </GlassCard>

    <view v-if="groupedRecords.length" class="history-groups">
      <GlassCard v-for="group in groupedRecords" :key="group.date">
        <view class="vm-stack">
          <view class="group-head">
            <text class="group-head__date">{{ group.date }}</text>
            <text class="group-head__count">共 {{ group.items.length }} 条</text>
          </view>

          <view class="timeline">
            <view v-for="record in group.items" :key="record.id" class="timeline__item">
              <view class="timeline__dot" />
              <view class="timeline__body">
                <view class="timeline__head">
                  <text class="timeline__title">{{ record.goodsName }}</text>
                  <text class="timeline__time">{{ formatDateTime(record.happenedAt) }}</text>
                </view>
                <text class="timeline__meta">
                  {{ categoryLabelMap[record.category] }} · {{ record.deviceCode }} ·
                  {{ record.type === "manual-deduction" ? `补扣 ${record.quantity} 件` : `领取 ${record.quantity} 件` }}
                </text>
              </view>
            </view>
          </view>
        </view>
      </GlassCard>
    </view>

    <GlassCard v-else tone="quiet">
      <EmptyState
        :title="loading ? '正在加载服务记录' : '还没有服务记录'"
        :description="loading ? '请稍候，系统正在同步记录。' : '完成首次领取后，服务记录会自动显示在这里。'"
      />
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.history-tip {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.history-tip__title,
.group-head__date,
.timeline__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.history-tip__body,
.group-head__count,
.timeline__meta,
.timeline__time {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.history-groups {
  display: grid;
  gap: 18rpx;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
}

.timeline {
  display: grid;
  gap: 18rpx;
}

.timeline__item {
  display: grid;
  grid-template-columns: 26rpx minmax(0, 1fr);
  gap: 18rpx;
  align-items: start;
}

.timeline__dot {
  width: 18rpx;
  height: 18rpx;
  margin-top: 10rpx;
  border-radius: 999rpx;
  background: var(--vm-accent);
  box-shadow: 0 0 0 10rpx var(--vm-focus-ring);
}

.timeline__body {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
  padding-bottom: 22rpx;
  border-bottom: 1rpx solid var(--vm-line);
}

.timeline__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
}
</style>
