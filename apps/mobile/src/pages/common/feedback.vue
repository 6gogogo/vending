<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure } from "../../utils/operation-feedback";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const submitting = ref(false);
const deviceCode = ref("");
const contactPhone = ref("");
const form = reactive({
  feedbackType: "机器故障" as "机器故障" | "服务问题" | "其他",
  detail: ""
});

const typeOptions = ["机器故障", "服务问题", "其他"] as const;
const loggedIn = computed(() => Boolean(sessionStore.user));

const submit = async () => {
  submitting.value = true;
  try {
    const detailSegments = [form.detail.trim()];

    if (!loggedIn.value && contactPhone.value.trim()) {
      detailSegments.push(`联系方式：${contactPhone.value.trim()}`);
    }

    await mobileApi.createFeedback({
      deviceCode: deviceCode.value || undefined,
      feedbackType: form.feedbackType,
      detail: detailSegments.filter(Boolean).join("；"),
      title: `${form.feedbackType}反馈`
    });

    uni.reLaunch({
      url: `/pages/common/result?status=success&title=${encodeURIComponent("操作成功")}&detail=${encodeURIComponent("反馈已提交，工作人员会尽快处理。")}`
    });
  } catch (error) {
    showOperationFailure(error);
  } finally {
    submitting.value = false;
  }
};

const back = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
  uni.switchTab({
    url: resolveHomePath(sessionStore.user.role)
  });
};

onLoad((query) => {
  if (typeof query.deviceCode === "string") {
    deviceCode.value = query.deviceCode;
  }

  if (typeof query.phone === "string" && query.phone) {
    contactPhone.value = query.phone;
  }
});
</script>

<template>
  <MobileShell eyebrow="反馈通道" title="提交反馈" subtitle="注册、登录前后都可以使用反馈通道，反馈会直接进入后台待处理池。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view v-if="deviceCode" class="tip-line">
          <text class="tip-line__label">关联柜机</text>
          <text class="tip-line__value">{{ deviceCode }}</text>
        </view>

        <view v-if="!loggedIn" class="vm-field">
          <text class="vm-field__label">联系方式（选填）</text>
          <input v-model="contactPhone" class="vm-field__input" placeholder="可填写手机号，方便工作人员联系" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">反馈类型</text>
          <view class="type-grid">
            <button
              v-for="item in typeOptions"
              :key="item"
              class="type-chip"
              :class="{ 'type-chip--active': form.feedbackType === item }"
              @tap="form.feedbackType = item"
            >
              {{ item }}
            </button>
          </view>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">反馈内容</text>
          <textarea
            v-model="form.detail"
            class="vm-textarea"
            maxlength="200"
            placeholder="请填写具体情况，例如柜门无法打开、服务说明不清楚等"
          />
        </view>

        <button class="vm-button" :loading="submitting" @tap="submit">提交反馈</button>
        <button class="vm-button vm-button--ghost" @tap="back">{{ loggedIn ? "返回设置" : "返回入口" }}</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.tip-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
}

.tip-line__label {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.tip-line__value {
  font-size: 26rpx;
  font-weight: 700;
}

.type-grid {
  display: grid;
  gap: 16rpx;
}

.type-chip {
  min-height: 88rpx;
  border-radius: 22rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.2);
  background: rgba(255, 252, 246, 0.88);
  font-size: 28rpx;
  color: var(--vm-text);
}

.type-chip--active {
  border-color: rgba(47, 143, 102, 0.35);
  background: rgba(241, 251, 244, 0.98);
  color: var(--vm-accent-strong);
}

.vm-textarea {
  width: 100%;
  min-height: 220rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: rgba(255, 252, 246, 0.92);
  font-size: 28rpx;
  color: var(--vm-text);
}
</style>
