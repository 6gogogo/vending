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
const phonePattern = /^1\d{10}$/;
const form = reactive({
  feedbackType: "机器故障" as "机器故障" | "服务问题" | "其他",
  detail: ""
});

const typeOptions = ["机器故障", "服务问题", "其他"] as const;
const loggedIn = computed(() => Boolean(sessionStore.user));
const selectedTypeIndex = computed(() =>
  Math.max(typeOptions.findIndex((item) => item === form.feedbackType), 0)
);
const pageSubtitle = computed(() =>
  loggedIn.value
    ? "注册、登录后都可以直接提交反馈，问题会进入后台待处理池。"
    : "登录前也可以提交反馈，但需要填写手机号，方便工作人员回访。"
);

const handleTypeChange = (index: number) => {
  form.feedbackType = typeOptions[index] ?? typeOptions[0];
};

const submit = async () => {
  const detail = form.detail.trim();
  const phone = contactPhone.value.trim();

  if (!detail) {
    uni.showToast({
      title: "请填写反馈内容",
      icon: "none"
    });
    return;
  }

  if (!loggedIn.value && !phonePattern.test(phone)) {
    uni.showToast({
      title: "请填写 11 位手机号",
      icon: "none"
    });
    return;
  }

  submitting.value = true;
  try {
    const detailSegments = [detail];

    if (!loggedIn.value) {
      detailSegments.push(`联系方式：${phone}`);
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
  <MobileShell eyebrow="反馈通道" title="提交反馈" :subtitle="pageSubtitle">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view v-if="deviceCode" class="tip-line">
          <text class="tip-line__label">关联柜机</text>
          <text class="tip-line__value">{{ deviceCode }}</text>
        </view>

        <view v-if="!loggedIn" class="vm-field">
          <text class="vm-field__label">手机号</text>
          <input
            v-model="contactPhone"
            class="vm-field__input"
            type="number"
            maxlength="11"
            placeholder="登录前反馈需填写手机号"
          />
          <text class="vm-field__hint">工作人员会按这个手机号回访反馈结果。</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">反馈类型</text>
          <picker :range="typeOptions" :value="selectedTypeIndex" @change="handleTypeChange(Number($event.detail.value))">
            <view class="picker-field">
              <text class="picker-field__value">{{ form.feedbackType }}</text>
              <view class="picker-field__chevron" />
            </view>
          </picker>
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
  background: var(--vm-surface-soft);
}

.tip-line__label {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.tip-line__value {
  font-size: 26rpx;
  font-weight: 700;
}

.vm-field__hint {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.picker-field {
  min-height: 96rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
  padding: 0 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
}

.picker-field__value {
  font-size: 28rpx;
  color: var(--vm-text);
}

.picker-field__chevron {
  width: 18rpx;
  height: 18rpx;
  border-right: 3rpx solid var(--vm-text-soft);
  border-bottom: 3rpx solid var(--vm-text-soft);
  transform: rotate(45deg);
}

.vm-textarea {
  width: 100%;
  min-height: 220rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
  font-size: 28rpx;
  color: var(--vm-text);
}
</style>

