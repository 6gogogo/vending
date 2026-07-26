<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { InventoryMovement, OperationLogRecord, RegistrationApplication, UserRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { operationLogStatusLabelMap, roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { formatBeijingDate, formatBeijingDateTime } from "../../utils/datetime";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";
import {
  isStockOperatorRole,
  syncRoleTabBar
} from "../../utils/role-routing";

const sessionStore = useSessionStore();
const loading = ref(false);
const loadError = ref("");
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
const isStockOperator = computed(() =>
  isStockOperatorRole(sessionStore.user?.role)
);
const adminUsers = ref<UserRecord[]>([]);
const pendingApplications = ref<RegistrationApplication[]>([]);
const adminLogs = ref<OperationLogRecord[]>([]);
const rejectReasons = reactive<Record<string, string>>({});
const adminView = ref<"users" | "reviews" | "logs">("users");
const adminLoadErrors = reactive<Record<"users" | "reviews" | "logs", string>>({
  users: "",
  reviews: "",
  logs: ""
});
const reviewingApplicationId = ref("");
const readLoadError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const visibleLoadError = computed(() =>
  sessionStore.user?.role === "admin" ? adminLoadErrors[adminView.value] : loadError.value
);
const visibleLoadErrorTitle = computed(() => {
  if (sessionStore.user?.role !== "admin") {
    return "记录数据加载失败";
  }

  return adminView.value === "users"
    ? "人员数据加载失败"
    : adminView.value === "reviews"
      ? "审批数据加载失败"
      : "日志数据加载失败";
});

const title = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "领取记录";
  }

  if (isStockOperator.value) {
    return "补货记录";
  }

  return "人员日志";
});

const subtitle = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "查看本人在哪些柜机领取过什么物资。";
  }

  if (isStockOperator.value) {
    return "按日查看物资被领取的件数、服务人数和累计服务人次。";
  }

  return "可切换查看人员信息、审批申请和处理记录。";
});

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
  loading.value = true;
  loadError.value = "";

  try {
    if (sessionStore.user.role === "special") {
      records.value = await mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role);
      return;
    }

    if (isStockOperatorRole(sessionStore.user.role)) {
      const traces = await mobileApi.merchantRestockTraces();
      merchantBatches.value = traces.batches;
      merchantLogs.value = traces.logs;
      merchantDailySummary.value = traces.dailySummary;
      merchantCumulativeHelpTimes.value = traces.cumulativeHelpTimes;
      return;
    }

    const [usersResult, applicationsResult, logsResult] = await Promise.allSettled([
      mobileApi.users(),
      mobileApi.registrationApplications("pending"),
      mobileApi.logs()
    ]);

    if (usersResult.status === "fulfilled") {
      adminUsers.value = usersResult.value;
      adminLoadErrors.users = "";
    } else {
      adminLoadErrors.users = readLoadError(usersResult.reason, "人员数据加载失败，请稍后重试");
    }

    if (applicationsResult.status === "fulfilled") {
      pendingApplications.value = applicationsResult.value;
      adminLoadErrors.reviews = "";
    } else {
      adminLoadErrors.reviews = readLoadError(applicationsResult.reason, "审批数据加载失败，请稍后重试");
    }

    if (logsResult.status === "fulfilled") {
      adminLogs.value = logsResult.value;
      adminLoadErrors.logs = "";
    } else {
      adminLoadErrors.logs = readLoadError(logsResult.reason, "日志数据加载失败，请稍后重试");
    }
  } catch (error) {
    loadError.value = readLoadError(error, "记录数据加载失败，请稍后重试");
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

const reviewApplication = async (applicationId: string, decision: "approved" | "rejected") => {
  if (reviewingApplicationId.value) {
    return;
  }

  const application = pendingApplications.value.find((item) => item.id === applicationId);
  const applicantName = application?.profile.merchantName || application?.profile.name || application?.phone || applicationId;
  const roleName = application?.requestedRole ? roleLabelMap[application.requestedRole] : "未知角色";
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: decision === "approved" ? "确认通过申请" : "确认驳回申请",
      content: [
        `申请人：${applicantName}`,
        `申请角色：${roleName}`,
        decision === "rejected" ? `驳回原因：${rejectReasons[applicationId]?.trim() || "未填写"}` : "通过后将立即生效。"
      ].join("\n"),
      confirmText: decision === "approved" ? "确认通过" : "确认驳回",
      cancelText: "取消",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  reviewingApplicationId.value = applicationId;
  try {
    await mobileApi.reviewRegistration(applicationId, {
      decision,
      reason: decision === "rejected" ? rejectReasons[applicationId] : undefined
    });
    pendingApplications.value = pendingApplications.value.filter((item) => item.id !== applicationId);
    delete rejectReasons[applicationId];
    showOperationSuccess(decision === "approved" ? "已通过申请" : "已驳回申请");
    await load();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    reviewingApplicationId.value = "";
  }
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
        <button class="segment" :class="{ 'segment--active': adminView === 'reviews' }" @tap="adminView = 'reviews'">审批</button>
        <button class="segment" :class="{ 'segment--active': adminView === 'logs' }" @tap="adminView = 'logs'">日志</button>
      </view>
    </GlassCard>

    <GlassCard v-if="visibleLoadError" tone="warning">
      <view class="vm-stack">
        <EmptyState :title="visibleLoadErrorTitle" :description="visibleLoadError" />
        <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">
          重新加载
        </button>
      </view>
    </GlassCard>

    <GlassCard v-else tone="quiet">
      <view v-if="sessionStore.user?.role === 'special'" class="vm-stack">
        <view v-if="records.length" class="simple-list">
          <view v-for="record in records" :key="record.id" class="simple-card simple-card--timeline">
            <MenuIcon :name="record.type === 'manual-deduction' ? 'warning' : 'success'" size="md" :tone="record.type === 'manual-deduction' ? 'warning' : 'accent'" />
            <view class="simple-card__main">
              <text class="simple-card__title">{{ record.goodsName }}</text>
              <text class="simple-card__meta">{{ record.deviceCode }} · {{ formatBeijingDateTime(record.happenedAt) }}</text>
            </view>
            <text class="vm-status" :class="record.type === 'manual-deduction' ? 'vm-status--warning' : 'vm-status--success'">
              {{ record.type === "manual-deduction" ? `补扣 ${record.quantity} 件` : `领取 ${record.quantity} 件` }}
            </text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载记录' : '当前还没有领取记录'" description="完成首次领取后，这里会自动展示明细。" />
      </view>

      <view v-else-if="isStockOperator" class="vm-stack">
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
          <text class="summary-card__title">{{ loading ? "正在统计补货记录" : "当前暂无被领取数据" }}</text>
          <text class="summary-card__meta">累计帮助人次 {{ merchantCumulativeHelpTimes }} 次</text>
        </view>

        <view v-if="merchantBatches.length" class="simple-list">
          <view v-for="batch in merchantBatches" :key="batch.batchId" class="simple-card simple-card--timeline">
            <MenuIcon name="box" size="md" tone="accent" />
            <view class="simple-card__main">
              <text class="simple-card__title">{{ batch.goodsName }}</text>
              <text class="simple-card__meta">{{ batch.deviceName }} · 当前剩余 {{ batch.remainingQuantity }}/{{ batch.quantity }} 件</text>
              <text class="simple-card__meta">{{ batch.expiresAt ? `到期 ${formatBeijingDate(batch.expiresAt)}` : "未设置保质期" }}</text>
            </view>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载批次' : '当前没有补货批次'" description="完成首次补货后，这里会展示补货记录。" />

        <view v-if="merchantLogs.length" class="simple-list">
          <view v-for="log in merchantLogs.slice(0, 5)" :key="log.id" class="simple-card">
            <text class="simple-card__title">{{ log.description }}</text>
            <text class="simple-card__meta">{{ formatBeijingDateTime(log.occurredAt) }}</text>
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

        <view v-else-if="adminView === 'reviews'">
          <view v-if="pendingApplications.length" class="simple-list">
            <view v-for="item in pendingApplications" :key="item.id" class="simple-card">
              <text class="simple-card__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</text>
              <text class="simple-card__meta">{{ item.phone }} · {{ roleLabelMap[item.requestedRole] }}</text>
              <input v-model="rejectReasons[item.id]" :aria-label="`${item.profile.name || item.phone} 的驳回原因`" class="vm-field__input" placeholder="驳回时填写原因（选填）" />
              <view class="action-row">
                <button class="vm-button" :disabled="Boolean(reviewingApplicationId)" :loading="reviewingApplicationId === item.id" @tap="reviewApplication(item.id, 'approved')">通过</button>
                <button class="vm-button vm-button--ghost" :disabled="Boolean(reviewingApplicationId)" :loading="reviewingApplicationId === item.id" @tap="reviewApplication(item.id, 'rejected')">驳回</button>
              </view>
            </view>
          </view>
          <EmptyState v-else :title="loading ? '正在加载审批申请' : '当前没有待审核申请'" description="新的注册申请进入系统后，这里会同步显示。" />
        </view>

        <view v-else>
          <view v-if="adminLogs.length" class="simple-list">
            <button v-for="log in adminLogs" :key="log.id" class="simple-card simple-card--button" @tap="openLog(log.id)">
              <text class="simple-card__title">{{ log.description }}</text>
              <text class="simple-card__meta">{{ formatBeijingDateTime(log.occurredAt) }} · {{ operationLogStatusLabelMap[log.status] }}</text>
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

.segmented {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8rpx;
  padding: 8rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
  background: rgba(255, 255, 255, 0.72);
}

.segment {
  min-height: 64rpx;
  border-radius: 18rpx;
  border: 1rpx solid transparent;
  background: transparent;
  font-size: 26rpx;
  color: var(--vm-text-soft);
}

.segment--active {
  border-color: var(--vm-success-line);
  background: #ffffff;
  color: var(--vm-accent-strong);
  font-weight: 800;
  box-shadow: 0 8rpx 18rpx rgba(88, 61, 30, 0.08);
}

.action-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}

.simple-card,
.summary-card {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.9);
  border: 1rpx solid var(--vm-line);
}

.simple-card--timeline {
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
}

.simple-card__main {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.simple-card--button {
  text-align: left;
}

.simple-card__title,
.summary-card__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.simple-card__meta,
.summary-card__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>

