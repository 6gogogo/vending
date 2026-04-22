<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type { CabinetEventRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { getErrorMessage } from "../../utils/error-message";

const eventId = ref("");
const deviceCode = ref("");
const event = ref<CabinetEventRecord>();
const busy = ref(false);
const statusText = ref("正在提交开门请求");
const hintText = ref("请保持在柜机旁，系统会根据门状态自动推进流程。");

let pollTimer: ReturnType<typeof setInterval> | undefined;

const selectedSummary = computed(() =>
  event.value?.intentItems?.length
    ? event.value.intentItems.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "暂未记录意向商品"
);

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
};

const goClosed = () => {
  stopPolling();
  uni.redirectTo({
    url: `/pages/common/door-closed?eventId=${encodeURIComponent(eventId.value)}`
  });
};

const goFailure = (title: string, detail: string) => {
  stopPolling();
  uni.reLaunch({
    url: `/pages/common/result?status=danger&title=${encodeURIComponent(title)}&detail=${encodeURIComponent(detail)}&actionText=${encodeURIComponent("返回首页")}`
  });
};

const applyEventState = (nextEvent: CabinetEventRecord) => {
  event.value = nextEvent;

  if (nextEvent.status === "created") {
    statusText.value = "已提交开门请求";
    hintText.value = "正在等待柜机返回门状态，请勿重复操作。";
    return;
  }

  if (nextEvent.status === "opening") {
    statusText.value = "柜门正在打开";
    hintText.value = "请等待柜门完全打开后再取货。";
    return;
  }

  if (nextEvent.status === "opened") {
    statusText.value = "柜门已打开";
    hintText.value = "取货后请及时关闭柜门，系统会在闭门后继续核对结算结果。";
    return;
  }

  if (nextEvent.status === "closed" || nextEvent.status === "settled" || nextEvent.status === "refunded") {
    goClosed();
    return;
  }

  if (nextEvent.status === "timeout_unopened") {
    goFailure("开门超时", "柜机在规定时间内没有成功打开，已记录到后台，请稍后重试。");
    return;
  }

  if (nextEvent.status === "failed") {
    goFailure("开门失败", "柜机返回了开门失败结果，请稍后重试或联系工作人员。");
    return;
  }

  if (nextEvent.status === "stuck_open") {
    goFailure("柜门状态异常", "柜门长时间未关闭，后台已收到异常记录，请联系工作人员处理。");
  }
};

const loadEvent = async () => {
  if (!eventId.value) {
    goFailure("缺少事件信息", "未识别到本次开柜事件，请重新发起。");
    return;
  }

  busy.value = true;
  try {
    const response = await mobileApi.getCabinetEvent(eventId.value);
    applyEventState(response);
  } catch (error) {
    goFailure("开门状态获取失败", getErrorMessage(error));
  } finally {
    busy.value = false;
  }
};

const startPolling = () => {
  stopPolling();
  pollTimer = setInterval(() => {
    void loadEvent();
  }, 2000);
};

onLoad((query) => {
  eventId.value = typeof query.eventId === "string" ? query.eventId : "";
  deviceCode.value = typeof query.deviceCode === "string" ? query.deviceCode : "";
  void loadEvent();
  startPolling();
});

onUnload(() => {
  stopPolling();
});
</script>

<template>
  <MobileShell eyebrow="开门中" :title="statusText" :subtitle="hintText">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="status-box">
          <text class="status-box__label">柜机编号</text>
          <text class="status-box__value">{{ deviceCode || event?.deviceCode || "-" }}</text>
        </view>
        <view class="status-box">
          <text class="status-box__label">本次计划领取</text>
          <text class="status-box__value">{{ selectedSummary }}</text>
        </view>
        <view class="status-box">
          <text class="status-box__label">事件编号</text>
          <text class="status-box__value vm-number">{{ eventId }}</text>
        </view>
        <text class="vm-subtitle">{{ busy ? "正在同步最新柜门状态..." : "页面会自动刷新，无需重复点击开柜。" }}</text>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.status-box {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.status-box__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.status-box__value {
  font-size: 28rpx;
  color: var(--vm-text);
  line-height: 1.5;
}
</style>
