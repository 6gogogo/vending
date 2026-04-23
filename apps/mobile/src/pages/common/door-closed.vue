<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type { CabinetEventRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const eventId = ref("");
const event = ref<CabinetEventRecord>();
const statusText = ref("已确认闭门");
const hintText = ref("正在等待平台结算本次实际领取结果。");
const countdown = ref(5);
const readyToReturn = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let pollAttempts = 0;
let mismatchNotified = false;

const intendedSummary = computed(() =>
  event.value?.intentItems?.length
    ? event.value.intentItems.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "未记录"
);
const settledSummary = computed(() =>
  event.value?.goods?.length
    ? event.value.goods.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "等待平台结算"
);

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
};

const stopCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
};

const goHome = async () => {
  stopPolling();
  stopCountdown();
  await sessionStore.bootstrap();

  if (sessionStore.user) {
    syncRoleTabBar(sessionStore.user.role);
    uni.switchTab({
      url: resolveHomePath(sessionStore.user.role)
    });
    return;
  }

  uni.reLaunch({
    url: "/pages/common/login"
  });
};

const startCountdown = () => {
  stopCountdown();
  readyToReturn.value = true;
  countdown.value = 5;
  countdownTimer = setInterval(() => {
    countdown.value -= 1;

    if (countdown.value <= 0) {
      void goHome();
    }
  }, 1000);
};

const notifyMismatchIfNeeded = () => {
  if (!event.value?.settlementComparison || event.value.settlementComparison.matched || mismatchNotified) {
    return;
  }

  mismatchNotified = true;
  uni.showModal({
    title: "领取结果需要确认",
    content: `${event.value.settlementComparison.summary}，后台已收到异常记录。`,
    showCancel: false
  });
};

const applyEvent = (nextEvent: CabinetEventRecord) => {
  event.value = nextEvent;

  if (nextEvent.status === "settled" || nextEvent.status === "refunded") {
    statusText.value = "已确认闭门";
    hintText.value = nextEvent.settlementComparison?.matched
      ? "平台已完成结算，本次领取结果与所选商品一致。"
      : "平台已完成结算，但实际领取结果与所选商品存在差异。";
    stopPolling();
    notifyMismatchIfNeeded();
    startCountdown();
    return;
  }

  if (nextEvent.status === "failed" || nextEvent.status === "timeout_unopened") {
    stopPolling();
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("本次开柜未完成")}&detail=${encodeURIComponent("柜机流程异常，后台已记录，请稍后重试或联系工作人员。")}`
    });
    return;
  }

  if (pollAttempts >= 8) {
    stopPolling();
    statusText.value = "已确认闭门";
    hintText.value = "柜门已关闭，平台结算仍在处理中，稍后会自动返回首页。";
    startCountdown();
    return;
  }
};

const loadEvent = async () => {
  if (!eventId.value) {
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("缺少事件信息")}&detail=${encodeURIComponent("未识别到本次开柜事件，请重新发起。")}`
    });
    return;
  }

  try {
    const response = await mobileApi.getCabinetEvent(eventId.value);
    pollAttempts += 1;
    applyEvent(response);
  } catch (error) {
    stopPolling();
    stopCountdown();
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("结算状态获取失败")}&detail=${encodeURIComponent(getErrorMessage(error))}`
    });
  }
};

onLoad((query) => {
  eventId.value = typeof query.eventId === "string" ? query.eventId : "";
  void loadEvent();
  pollTimer = setInterval(() => {
    void loadEvent();
  }, 2000);
});

onUnload(() => {
  stopPolling();
  stopCountdown();
});
</script>

<template>
  <MobileShell eyebrow="闭门确认" :title="statusText" :subtitle="hintText">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="status-box">
          <text class="status-box__label">本次计划领取</text>
          <text class="status-box__value">{{ intendedSummary }}</text>
        </view>
        <view class="status-box">
          <text class="status-box__label">平台实际结算</text>
          <text class="status-box__value">{{ settledSummary }}</text>
        </view>
        <view v-if="event?.settlementComparison && !event.settlementComparison.matched" class="warning-box">
          <text class="warning-box__title">已发现差异</text>
          <text class="warning-box__body">{{ event.settlementComparison.summary }}</text>
        </view>
        <text class="vm-subtitle">
          {{ readyToReturn ? `页面将在 ${countdown} 秒后自动返回首页。` : "结算结果确认后会自动返回首页。" }}
        </text>
        <button class="vm-button" @tap="goHome">立即返回首页</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.status-box,
.warning-box {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.status-box__label,
.warning-box__title {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.status-box__value,
.warning-box__body {
  font-size: 28rpx;
  color: var(--vm-text);
  line-height: 1.5;
}

.warning-box {
  background: rgba(255, 245, 232, 0.88);
  border-color: rgba(207, 120, 43, 0.18);
}
</style>

