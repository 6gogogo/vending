<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { RegistrationApplication } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { formatBeijingDateTime } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { syncNativeInputAccessibility } from "../../utils/native-input-accessibility";
import { showOperationSuccess } from "../../utils/operation-feedback";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const loadError = ref("");
const applications = ref<RegistrationApplication[]>([]);
const rejectReasons = reactive<Record<string, string>>({});
const reviewingApplicationId = ref("");

const pendingCount = computed(() => applications.value.filter((item) => item.status === "pending").length);
const approvedCount = computed(() => applications.value.filter((item) => item.status === "approved").length);
const rejectedCount = computed(() => applications.value.filter((item) => item.status === "rejected").length);
const overviewUnavailable = computed(() => Boolean(loadError.value));
const overviewHint = computed(() => {
  if (overviewUnavailable.value) {
    return "审核数据暂不可用，请重新加载";
  }

  if (loading.value && !applications.value.length) {
    return "正在加载审核数据";
  }

  return pendingCount.value > 0
    ? `有 ${pendingCount.value} 条申请需要处理`
    : "当前没有待处理申请";
});
const overviewValue = (value: number) => overviewUnavailable.value ? "—" : value;
const rejectReasonRootId = (applicationId: string) => `admin-review-reason-${applicationId}`;
const rejectReasonLabelId = (applicationId: string) => `${rejectReasonRootId(applicationId)}-label`;

const syncRejectReasonAccessibility = async () => {
  await nextTick();
  for (const application of applications.value) {
    if (application.status !== "pending") {
      continue;
    }

    syncNativeInputAccessibility(rejectReasonRootId(application.id), {
      labelId: rejectReasonLabelId(application.id),
      name: `reject-reason-${application.id}`
    });
  }
};

const roleLabel = (role: RegistrationApplication["requestedRole"]) => {
  if (role === "special") {
    return "用户";
  }

  if (role === "merchant") {
    return "商家";
  }

  if (role === "restocker") {
    return "补货员";
  }

  return "管理员";
};

const roleIcon = (role: RegistrationApplication["requestedRole"]): "users" | "device" | "review" => {
  if (role === "merchant" || role === "restocker") {
    return "device";
  }

  if (role === "admin") {
    return "review";
  }

  return "users";
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin") {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  loadError.value = "";
  try {
    applications.value = await mobileApi.registrationApplications();
    await syncRejectReasonAccessibility();
  } catch (error) {
    loadError.value = getErrorMessage(error);
  } finally {
    loading.value = false;
  }
};

const review = async (applicationId: string, decision: "approved" | "rejected") => {
  if (reviewingApplicationId.value) {
    return;
  }

  const application = applications.value.find((item) => item.id === applicationId);
  const applicantName = application?.profile.merchantName || application?.profile.name || application?.phone || applicationId;
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: decision === "approved" ? "确认通过申请" : "确认驳回申请",
      content: [
        `申请人：${applicantName}`,
        `申请角色：${application ? roleLabel(application.requestedRole) : "未知角色"}`,
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
    const reviewed = await mobileApi.reviewRegistration(applicationId, {
      decision,
      reason: decision === "rejected" ? rejectReasons[applicationId] : undefined
    });
    applications.value = applications.value.map((item) => item.id === reviewed.id ? reviewed : item);
    delete rejectReasons[applicationId];
    await load();
    showOperationSuccess(decision === "approved" ? "已通过申请" : "已驳回申请");
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    reviewingApplicationId.value = "";
  }
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="审核工作台" title="注册审核" subtitle="先处理待审，再回看通过与驳回记录。">
    <GlassCard tone="accent">
      <view class="review-overview">
        <view class="review-overview__lead">
          <MenuIcon name="review" size="lg" />
          <view>
            <text class="section-title">今日审核</text>
            <text class="review-overview__hint">{{ overviewHint }}</text>
          </view>
        </view>
        <view class="review-metrics">
          <view class="review-metric review-metric--warning">
            <text class="review-metric__value vm-number">{{ overviewValue(pendingCount) }}</text>
            <text class="review-metric__label">待审核</text>
          </view>
          <view class="review-metric">
            <text class="review-metric__value vm-number">{{ overviewValue(approvedCount) }}</text>
            <text class="review-metric__label">已通过</text>
          </view>
          <view class="review-metric review-metric--muted">
            <text class="review-metric__value vm-number">{{ overviewValue(rejectedCount) }}</text>
            <text class="review-metric__label">已驳回</text>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-if="loadError" tone="warning">
      <view class="vm-stack">
        <EmptyState title="审核数据加载失败" :description="loadError" />
        <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">
          重新加载
        </button>
      </view>
    </GlassCard>

    <GlassCard v-else tone="quiet">
      <view class="vm-stack">
        <text class="section-title">申请列表</text>
        <view v-if="applications.length" class="application-list">
          <view v-for="item in applications" :key="item.id" class="application-item" :class="{ 'application-item--pending': item.status === 'pending' }">
            <view class="application-item__header">
              <MenuIcon :name="roleIcon(item.requestedRole)" size="md" :tone="item.status === 'pending' ? 'warning' : 'accent'" />
              <view class="application-item__main">
                <view class="application-item__title-row">
                  <text class="application-item__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</text>
                  <text class="vm-status" :class="item.status === 'pending' ? 'vm-status--warning' : item.status === 'approved' ? 'vm-status--success' : 'vm-status--muted'">
                    {{ item.status === "pending" ? "待审核" : item.status === "approved" ? "已通过" : "已驳回" }}
                  </text>
                </view>
                <text class="application-item__meta">{{ item.phone }} · {{ roleLabel(item.requestedRole) }}</text>
                <text class="application-item__meta">提交于 {{ formatBeijingDateTime(item.updatedAt) }}</text>
              </view>
            </view>
            <text v-if="item.profile.note" class="application-item__note">备注：{{ item.profile.note }}</text>
            <text v-if="item.reviewReason" class="application-item__reason">驳回原因：{{ item.reviewReason }}</text>
            <view v-if="item.status === 'pending'" class="vm-stack">
              <text :id="rejectReasonLabelId(item.id)" class="vm-field__label">驳回原因（选填）</text>
              <input
                :id="rejectReasonRootId(item.id)"
                v-model="rejectReasons[item.id]"
                :aria-labelledby="rejectReasonLabelId(item.id)"
                class="vm-field__input"
                placeholder="驳回时填写原因（选填）"
              />
              <view class="action-row">
                <button
                  class="vm-button"
                  :disabled="Boolean(reviewingApplicationId)"
                  :loading="reviewingApplicationId === item.id"
                  @tap="review(item.id, 'approved')"
                >
                  通过
                </button>
                <button
                  class="vm-button vm-button--ghost"
                  :disabled="Boolean(reviewingApplicationId)"
                  :loading="reviewingApplicationId === item.id"
                  @tap="review(item.id, 'rejected')"
                >
                  驳回
                </button>
              </view>
            </view>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载申请' : '当前没有审核申请'" description="有新申请时，这里会自动展示待处理列表。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-title,
.application-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.review-overview,
.review-overview__lead,
.review-metrics,
.application-list {
  display: grid;
  gap: 18rpx;
}

.review-overview__lead {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.review-overview__hint {
  display: block;
  margin-top: 8rpx;
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.review-metrics {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12rpx;
}

.review-metric {
  display: grid;
  gap: 8rpx;
  justify-items: center;
  min-height: 118rpx;
  padding: 18rpx 10rpx;
  border-radius: 22rpx;
  background: rgba(255, 255, 255, 0.86);
  border: 1rpx solid var(--vm-success-line);
}

.review-metric--warning {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.review-metric--muted {
  border-color: var(--vm-line);
  background: var(--vm-surface-soft);
}

.review-metric__value {
  font-size: 42rpx;
  line-height: 1;
  font-weight: 900;
  color: var(--vm-accent-strong);
}

.review-metric--warning .review-metric__value {
  color: var(--vm-warning);
}

.review-metric__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.application-item {
  display: grid;
  gap: 14rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.9);
  border: 1rpx solid var(--vm-line);
}

.application-item--pending {
  border-color: var(--vm-warning-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(255, 243, 226, 0.78));
}

.application-item__header,
.application-item__title-row {
  display: flex;
  align-items: flex-start;
  gap: 16rpx;
}

.application-item__title-row {
  align-items: center;
  justify-content: space-between;
}

.application-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  min-width: 0;
}

.application-item__meta,
.application-item__note,
.application-item__reason {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.application-item__note {
  padding: 14rpx 16rpx;
  border-radius: 18rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.application-item__reason {
  color: var(--vm-warning);
}

.action-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}

.action-row .vm-button {
  min-height: 78rpx;
}

.application-item .vm-field__input {
  min-height: 78rpx;
  font-size: 26rpx;
}
</style>

