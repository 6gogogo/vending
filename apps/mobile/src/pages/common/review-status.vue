<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { RegistrationPhoneLookup } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
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
  <MobileShell eyebrow="审核状态" title="注册资料状态" subtitle="待审核与已驳回账号都可以在这里查看当前状态。">
    <GlassCard :tone="lookup?.state === 'rejected' ? 'warning' : 'accent'">
      <view class="vm-stack">
        <text class="status-title">{{ statusTitle }}</text>
        <text class="vm-subtitle">{{ statusDetail }}</text>

        <view v-if="lookup" class="status-box">
          <text class="status-box__item">手机号：{{ lookup.phone }}</text>
          <text class="status-box__item">
            账号类型：
            {{ lookup.fixedRole === "special" ? "普通用户" : lookup.fixedRole === "merchant" ? "爱心商户" : lookup.fixedRole === "admin" ? "管理员" : "待选择" }}
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

.status-box {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.status-box__item {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}
</style>
