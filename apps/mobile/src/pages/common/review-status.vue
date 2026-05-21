<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { RegistrationPhoneLookup } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import CabinetHeroArt from "../../components/ui/CabinetHeroArt.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { getErrorMessage } from "../../utils/error-message";

const phone = ref("");
const lookup = ref<RegistrationPhoneLookup>();
const loading = ref(false);

const statusTitle = computed(() => {
  if (lookup.value?.state === "rejected") {
    return "审核未通过";
  }

  return "审核进行中";
});

const statusDetail = computed(() => {
  if (lookup.value?.state === "rejected") {
    return lookup.value.message || "请根据驳回原因修改资料后重新提交。";
  }

  return lookup.value?.message || "资料已提交，请耐心等待审核。";
});
const accountRoleLabel = computed(() => {
  const role = lookup.value?.fixedRole ?? lookup.value?.application?.requestedRole;

  if (role === "special") {
    return "受助用户";
  }

  if (role === "merchant") {
    return "爱心商户";
  }

  if (role === "admin") {
    return "管理员";
  }

  return "待选择";
});

const load = async () => {
  if (!phone.value) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    const response = await mobileApi.registrationLookup(phone.value);

    if (response.state === "approved") {
      uni.redirectTo({
        url: `/pages/common/app-login?phone=${encodeURIComponent(phone.value)}`
      });
      return;
    }

    if (response.state === "new" || response.state === "existing_user") {
      uni.redirectTo({
        url: `/pages/common/register?phone=${encodeURIComponent(phone.value)}`
      });
      return;
    }

    lookup.value = response;
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const editAgain = () => {
  uni.redirectTo({
    url: `/pages/common/register?phone=${encodeURIComponent(phone.value)}`
  });
};

const goLogin = () => {
  uni.redirectTo({
    url: `/pages/common/app-login?phone=${encodeURIComponent(phone.value)}`
  });
};

onLoad((query) => {
  if (typeof query.phone === "string" && query.phone) {
    phone.value = query.phone;
  }
});

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="审核状态" title="申请记录" subtitle="申请提交后会进入人工审核，请留意短信通知。">
    <GlassCard tone="neutral" class="review-hero-card">
      <view class="review-hero">
        <CabinetHeroArt />
        <view class="review-hero__status">
          <MenuIcon :name="lookup?.state === 'rejected' ? 'warning' : 'review'" size="lg" :tone="lookup?.state === 'rejected' ? 'warning' : 'accent'" />
          <text class="review-hero__title">{{ statusTitle }}</text>
          <text class="review-hero__body">{{ statusDetail }}</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard :tone="lookup?.state === 'rejected' ? 'warning' : 'accent'">
      <view class="vm-stack">
        <view class="vm-alert" :class="lookup?.state === 'rejected' ? 'vm-alert--warning' : 'vm-alert--success'">
          <MenuIcon :name="lookup?.state === 'rejected' ? 'warning' : 'review'" size="md" :tone="lookup?.state === 'rejected' ? 'warning' : 'accent'" />
          <view>
            <text class="vm-alert__title">{{ lookup?.state === "rejected" ? "需要修改资料" : "审核中" }}</text>
            <text class="vm-alert__body">{{ lookup?.state === "rejected" ? "根据驳回原因补充后可重新提交。" : "审核通过后可直接登录使用。" }}</text>
          </view>
        </view>

        <view v-if="lookup" class="status-box">
          <text class="status-box__item">手机号：{{ lookup.phone }}</text>
          <text class="status-box__item">
            账号类型：
            {{ accountRoleLabel }}
          </text>
          <text v-if="lookup.application?.updatedAt" class="status-box__item">
            更新时间：{{ lookup.application.updatedAt.slice(0, 16).replace("T", " ") }}
          </text>
          <text v-if="lookup.application?.reviewReason" class="status-box__item">
            驳回原因：{{ lookup.application.reviewReason }}
          </text>
        </view>

        <button v-if="lookup?.state === 'rejected'" class="vm-button" @tap="editAgain">修改资料并重新提交</button>
        <button v-else class="vm-button vm-button--ghost" @tap="goLogin">返回登录页</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.status-title {
  font-size: 36rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.review-hero-card {
  padding: 18rpx;
}

.review-hero {
  position: relative;
  display: grid;
  overflow: hidden;
  border-radius: 26rpx;
}

.review-hero :deep(.cabinet-art) {
  min-height: 260rpx;
}

.review-hero__status {
  position: absolute;
  left: 26rpx;
  right: 26rpx;
  bottom: 24rpx;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12rpx 16rpx;
  padding: 18rpx 20rpx;
  border-radius: 22rpx;
  background: rgba(255, 255, 255, 0.9);
  border: 1rpx solid rgba(46, 125, 70, 0.14);
  box-shadow: var(--vm-shadow-soft);
}

.review-hero__title {
  font-size: 30rpx;
  font-weight: 900;
  color: var(--vm-text);
}

.review-hero__body {
  grid-column: 2;
  font-size: 22rpx;
  line-height: 1.5;
  color: var(--vm-text-soft);
}

.status-box {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.status-box__item {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}
</style>

