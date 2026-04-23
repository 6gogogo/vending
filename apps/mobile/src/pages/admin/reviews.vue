<script setup lang="ts">
import { reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { RegistrationApplication } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { getErrorMessage } from "../../utils/error-message";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const applications = ref<RegistrationApplication[]>([]);
const rejectReasons = reactive<Record<string, string>>({});

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
  <MobileShell eyebrow="审核工作台" title="注册审核" subtitle="请在这里处理普通用户、爱心商户和管理员的注册申请。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <text class="section-title">申请列表</text>
        <view v-if="applications.length" class="application-list">
          <view v-for="item in applications" :key="item.id" class="application-item">
            <view class="application-item__main">
              <text class="application-item__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</text>
              <text class="application-item__meta">
                {{ item.phone }} · {{ item.requestedRole === "special" ? "普通用户" : item.requestedRole === "merchant" ? "爱心商户" : "管理员" }}
              </text>
              <text class="application-item__meta">提交于 {{ item.updatedAt.slice(0, 16).replace('T', ' ') }}</text>
              <text v-if="item.profile.note" class="application-item__meta">备注：{{ item.profile.note }}</text>
              <text v-if="item.reviewReason" class="application-item__reason">驳回原因：{{ item.reviewReason }}</text>
            </view>
            <text class="vm-status" :class="item.status === 'pending' ? 'vm-status--warning' : item.status === 'approved' ? 'vm-status--success' : 'vm-status--muted'">
              {{ item.status === "pending" ? "待审核" : item.status === "approved" ? "已通过" : "已驳回" }}
            </text>
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

.application-list {
  display: grid;
  gap: 18rpx;
}

.application-item {
  display: grid;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.application-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.application-item__meta,
.application-item__reason {
  font-size: 22rpx;
  color: var(--vm-text-soft);
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
