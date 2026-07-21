<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import { appCopy } from "../../constants/copy";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { callSupportPhone } from "../../utils/contact-support";
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

const typeOptions = [
  {
    label: "柜机异常",
    value: "机器故障",
    hint: "柜门无法打开、设备破损、现场安全等问题"
  },
  {
    label: "服务问题",
    value: "服务问题",
    hint: "资格、额度、说明不清楚等问题"
  },
  {
    label: "其他",
    value: "其他",
    hint: "不属于柜机异常或服务问题的反馈"
  }
] as const;
const typeLabels = computed(() => typeOptions.map((item) => item.label));
const loggedIn = computed(() => Boolean(sessionStore.user));
const selectedTypeIndex = computed(() =>
  Math.max(typeOptions.findIndex((item) => item.value === form.feedbackType), 0)
);
const selectedType = computed(() => typeOptions[selectedTypeIndex.value] ?? typeOptions[0]);
const canCallSupport = computed(() => form.feedbackType === "机器故障");
const detailPlaceholder = computed(() =>
  canCallSupport.value
    ? "请填写具体情况，例如柜门无法打开、柜机破损、设备编号或现场位置"
    : "请填写具体情况，例如资格、额度、服务说明或页面提示哪里不清楚"
);
const pageSubtitle = computed(() =>
  loggedIn.value
    ? "提交后工作人员会按内容处理；柜机现场异常可选择柜机异常后联系处理。"
    : "登录前也可以提交反馈，但需要填写手机号，方便工作人员回访。"
);

const handleTypeChange = (index: number) => {
  form.feedbackType = typeOptions[index]?.value ?? typeOptions[0].value;
};

const submit = async () => {
  const detail = form.detail.trim();
  const phone = contactPhone.value.trim();

  if (detail.length < 5) {
    uni.showToast({
      title: "反馈内容至少填写 5 个字符",
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
      title: `${selectedType.value.label}反馈`
    });

    const resultDetail = loggedIn.value
      ? deviceCode.value
        ? `已提交并关联柜机 ${deviceCode.value}。工作人员处理后，结果会在首页提醒中同步；如问题仍存在，可补充反馈。`
        : "已提交到工作人员待办。处理后，结果会在首页提醒中同步；如问题仍存在，可补充反馈。"
      : deviceCode.value
        ? `已提交并关联柜机 ${deviceCode.value}。工作人员会按填写的手机号回访；未登录反馈不会在首页同步。`
        : "已提交到工作人员待办。工作人员会按填写的手机号回访；未登录反馈不会在首页同步。";

    uni.reLaunch({
      url: `/pages/common/result?status=success&resultType=feedback&title=${encodeURIComponent("反馈已提交")}&detail=${encodeURIComponent(resultDetail)}&actionText=${encodeURIComponent("返回首页")}`
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
        <view v-if="canCallSupport" class="support-card">
          <MenuIcon name="phone" size="sm" tone="accent" />
          <view class="support-card__copy">
            <text class="support-card__title">{{ appCopy.supportPhoneLabel }}</text>
            <text class="support-card__body">柜门无法打开、设备破损或现场安全问题可直接联系；使用流程问题请提交反馈，工作人员会按内容处理。</text>
          </view>
        </view>

        <view v-if="deviceCode" class="tip-line">
          <text class="tip-line__label">关联柜机</text>
          <text class="tip-line__value">{{ deviceCode }}</text>
        </view>

        <view v-if="!loggedIn" class="vm-field">
          <text class="vm-field__label">手机号</text>
          <input
            v-model="contactPhone"
            aria-label="反馈回访手机号"
            class="vm-field__input"
            type="number"
            maxlength="11"
            placeholder="登录前反馈需填写手机号"
          />
          <text class="vm-field__hint">工作人员会按这个手机号回访反馈结果。</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">反馈类型</text>
          <picker aria-label="选择反馈类型" :range="typeLabels" :value="selectedTypeIndex" @change="handleTypeChange(Number($event.detail.value))">
            <view class="picker-field">
              <text class="picker-field__value">{{ selectedType.label }}</text>
              <view class="picker-field__chevron" />
            </view>
          </picker>
          <text class="vm-field__hint">{{ selectedType.hint }}</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">反馈内容</text>
          <textarea
            v-model="form.detail"
            aria-label="反馈内容"
            class="vm-textarea"
            maxlength="200"
            :placeholder="detailPlaceholder"
          />
        </view>

        <button class="vm-button" :disabled="submitting" :loading="submitting" @tap="submit">提交反馈</button>
        <button v-if="canCallSupport" class="vm-button vm-button--soft" @tap="callSupportPhone">联系客服电话</button>
        <button class="vm-button vm-button--ghost" @tap="back">{{ loggedIn ? "返回我的" : "返回入口" }}</button>
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

.support-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 22rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-success-line);
  background: rgba(255, 255, 255, 0.88);
}

.support-card__copy {
  display: grid;
  gap: 6rpx;
}

.support-card__title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.support-card__body {
  font-size: 23rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
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

