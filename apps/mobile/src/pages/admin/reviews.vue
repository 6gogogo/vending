<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { RegistrationApplication } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { getErrorMessage } from "../../utils/error-message";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const applications = ref<RegistrationApplication[]>([]);
const rejectReasons = reactive<Record<string, string>>({});

const pendingCount = computed(() => applications.value.filter((item) => item.status === "pending").length);
const approvedCount = computed(() => applications.value.filter((item) => item.status === "approved").length);
const rejectedCount = computed(() => applications.value.filter((item) => item.status === "rejected").length);

const roleLabel = (role: RegistrationApplication["requestedRole"]) => {
  if (role === "special") {
    return "受助用户";
  }

  if (role === "merchant") {
    return "爱心商户";
  }

  return "管理员";
};

const roleIcon = (role: RegistrationApplication["requestedRole"]): "users" | "device" | "review" => {
  if (role === "merchant") {
    return "device";
  }

  if (role === "admin") {
    return "review";
  }

  return "users";
};

const formatDateTime = (value: string) => value.slice(0, 16).replace("T", " ");

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin") {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    applications.value = await mobileApi.registrationApplications();
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const review = async (applicationId: string, decision: "approved" | "rejected") => {
  try {
    await mobileApi.reviewRegistration(applicationId, {
      decision,
      reason: decision === "rejected" ? rejectReasons[applicationId] : undefined
    });
    await load();
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
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
            <text class="review-overview__hint">
              {{ pendingCount > 0 ? `有 ${pendingCount} 条申请需要处理` : "当前没有待处理申请" }}
            </text>
          </view>
        </view>
        <view class="review-metrics">
          <view class="review-metric review-metric--warning">
            <text class="review-metric__value vm-number">{{ pendingCount }}</text>
            <text class="review-metric__label">待审核</text>
          </view>
          <view class="review-metric">
            <text class="review-metric__value vm-number">{{ approvedCount }}</text>
            <text class="review-metric__label">已通过</text>
          </view>
          <view class="review-metric review-metric--muted">
            <text class="review-metric__value vm-number">{{ rejectedCount }}</text>
            <text class="review-metric__label">已驳回</text>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
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
                <text class="application-item__meta">提交于 {{ formatDateTime(item.updatedAt) }}</text>
              </view>
            </view>
            <text v-if="item.profile.note" class="application-item__note">备注：{{ item.profile.note }}</text>
            <text v-if="item.reviewReason" class="application-item__reason">驳回原因：{{ item.reviewReason }}</text>
            <view v-if="item.status === 'pending'" class="vm-stack">
              <input
                v-model="rejectReasons[item.id]"
                class="vm-field__input"
                placeholder="驳回时填写原因（选填）"
              />
              <view class="action-row">
                <button class="vm-button" @tap="review(item.id, 'approved')">通过</button>
                <button class="vm-button vm-button--ghost" @tap="review(item.id, 'rejected')">驳回</button>
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
</style>

