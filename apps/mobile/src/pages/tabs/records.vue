<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { InventoryMovement, OperationLogRecord, UserRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure } from "../../utils/operation-feedback";
import { syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const loading = ref(false);
const records = ref<InventoryMovement[]>([]);
const merchantLogs = ref<OperationLogRecord[]>([]);
const merchantBatches = ref<Array<{
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
const merchantDailySummary = ref<Array<{
  dateKey: string;
  claimedUnits: number;
  helpedUsers: number;
  helpTimes: number;
  cumulativeHelpTimes: number;
}>>([]);
const merchantCumulativeHelpTimes = ref(0);
const adminUsers = ref<UserRecord[]>([]);
const adminLogs = ref<OperationLogRecord[]>([]);
const adminView = ref<"users" | "logs">("users");

const title = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "领取详情";
  }

  if (sessionStore.user?.role === "merchant") {
    return "货物流向";
  }

  return "人员日志";
});

const subtitle = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "查看本人在哪些柜机领取过什么货物。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "按日查看货物被领取的件数、帮助人数和累计帮助人次。";
  }

  return "可切换查看人员信息和处理记录。";
});

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
  loading.value = true;

  try {
    if (sessionStore.user.role === "special") {
      records.value = await mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role);
      return;
    }

    if (sessionStore.user.role === "merchant") {
      const traces = await mobileApi.merchantRestockTraces();
      merchantBatches.value = traces.batches;
      merchantLogs.value = traces.logs;
      merchantDailySummary.value = traces.dailySummary;
      merchantCumulativeHelpTimes.value = traces.cumulativeHelpTimes;
      return;
    }

    const [users, logs] = await Promise.all([mobileApi.users(), mobileApi.logs()]);
    adminUsers.value = users;
    adminLogs.value = logs;
  } catch (error) {
    showOperationFailure(error);
  } finally {
    loading.value = false;
  }
};

const openUser = (userId: string) => {
  uni.navigateTo({
    url: `/pages/admin/user-detail?userId=${userId}`
  });
};

const openLog = (id: string) => {
  uni.navigateTo({
    url: `/pages/admin/log-detail?id=${id}`
  });
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    :mode="sessionStore.user?.role === 'special' ? 'care' : sessionStore.user?.role ? 'ops' : 'care'"
    eyebrow="记录"
    :title="title"
    :subtitle="subtitle"
  >
    <GlassCard v-if="sessionStore.user?.role === 'admin'" tone="accent">
      <view class="segmented">
        <button class="segment" :class="{ 'segment--active': adminView === 'users' }" @tap="adminView = 'users'">人员</button>
        <button class="segment" :class="{ 'segment--active': adminView === 'logs' }" @tap="adminView = 'logs'">日志</button>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view v-if="sessionStore.user?.role === 'special'" class="vm-stack">
        <view v-if="records.length" class="simple-list">
          <view v-for="record in records" :key="record.id" class="simple-card">
            <text class="simple-card__title">{{ record.goodsName }}</text>
            <text class="simple-card__meta">{{ record.deviceCode }} · {{ record.happenedAt.slice(0, 16).replace("T", " ") }}</text>
            <text class="vm-status" :class="record.type === 'manual-deduction' ? 'vm-status--warning' : 'vm-status--success'">
              {{ record.type === "manual-deduction" ? `补扣 ${record.quantity} 件` : `领取 ${record.quantity} 件` }}
            </text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载记录' : '当前还没有领取记录'" description="完成首次领取后，这里会自动展示明细。" />
      </view>

      <view v-else-if="sessionStore.user?.role === 'merchant'" class="vm-stack">
        <view v-if="merchantDailySummary.length" class="summary-list">
          <view v-for="item in merchantDailySummary" :key="item.dateKey" class="summary-card">
            <text class="summary-card__title">{{ item.dateKey }}</text>
            <text class="summary-card__meta">当天被领取 {{ item.claimedUnits }} 件</text>
            <text class="summary-card__meta">帮助人数 {{ item.helpedUsers }} 人</text>
            <text class="summary-card__meta">帮助人次 {{ item.helpTimes }} 次</text>
            <text class="summary-card__meta">累计帮助人次 {{ item.cumulativeHelpTimes }} 次</text>
          </view>
        </view>
        <view v-else class="summary-card">
          <text class="summary-card__title">{{ loading ? "正在统计货物流向" : "当前暂无被领取数据" }}</text>
          <text class="summary-card__meta">累计帮助人次 {{ merchantCumulativeHelpTimes }} 次</text>
        </view>

        <view v-if="merchantBatches.length" class="simple-list">
          <view v-for="batch in merchantBatches" :key="batch.batchId" class="simple-card">
            <text class="simple-card__title">{{ batch.goodsName }}</text>
            <text class="simple-card__meta">{{ batch.deviceName }} · 当前剩余 {{ batch.remainingQuantity }}/{{ batch.quantity }} 件</text>
            <text class="simple-card__meta">{{ batch.expiresAt ? `到期 ${batch.expiresAt.slice(0, 10)}` : "未设置保质期" }}</text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载批次' : '当前没有补货批次'" description="完成首次补货后，这里会展示货物流向。" />

        <view v-if="merchantLogs.length" class="simple-list">
          <view v-for="log in merchantLogs.slice(0, 5)" :key="log.id" class="simple-card">
            <text class="simple-card__title">{{ log.description }}</text>
            <text class="simple-card__meta">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</text>
          </view>
        </view>
      </view>

      <view v-else class="vm-stack">
        <view v-if="adminView === 'users'">
          <view v-if="adminUsers.length" class="simple-list">
            <button v-for="user in adminUsers" :key="user.id" class="simple-card simple-card--button" @tap="openUser(user.id)">
              <text class="simple-card__title">{{ user.name }}</text>
              <text class="simple-card__meta">{{ user.phone }} · {{ roleLabelMap[user.role] }}</text>
              <text class="simple-card__meta">{{ user.neighborhood || user.tags.join("、") || "未补充资料" }}</text>
            </button>
          </view>
          <EmptyState v-else :title="loading ? '正在加载人员' : '当前没有人员数据'" description="可稍后刷新，或等待新资料同步后再查看。" />
        </view>

        <view v-else>
          <view v-if="adminLogs.length" class="simple-list">
            <button v-for="log in adminLogs" :key="log.id" class="simple-card simple-card--button" @tap="openLog(log.id)">
              <text class="simple-card__title">{{ log.description }}</text>
              <text class="simple-card__meta">{{ log.occurredAt.slice(0, 16).replace("T", " ") }} · {{ log.status }}</text>
            </button>
          </view>
          <EmptyState v-else :title="loading ? '正在加载日志' : '当前没有日志数据'" description="新的系统操作和处理动作会同步展示在这里。" />
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.segmented,
.simple-list,
.summary-list {
  display: grid;
  gap: 16rpx;
}

.segment {
  min-height: 80rpx;
  border-radius: 22rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  background: rgba(255, 252, 246, 0.88);
  font-size: 26rpx;
}

.segment--active {
  border-color: rgba(47, 143, 102, 0.35);
  background: rgba(241, 251, 244, 0.98);
  color: var(--vm-accent-strong);
}

.simple-card,
.summary-card {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.simple-card--button {
  text-align: left;
}

.simple-card__title,
.summary-card__title {
  font-size: 28rpx;
  color: var(--vm-text);
}

.simple-card__meta,
.summary-card__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>
