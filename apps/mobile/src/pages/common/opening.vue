<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type { CabinetEventRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";

const eventId = ref("");
const deviceCode = ref("");
const event = ref<CabinetEventRecord>();
const busy = ref(false);
const statusText = ref("正在提交开门请求");
const hintText = ref("请保持在柜机旁，系统会根据门状态自动推进流程。");

let pollTimer: ReturnType<typeof setInterval> | undefined;

const isOperationalEvent = computed(
  () => event.value?.role === "merchant" || event.value?.role === "admin"
);
const operationLabel = computed(() => {
  if (event.value?.hasInboundGoods === true) {
    return "有商品入柜";
  }

  if (event.value?.hasInboundGoods === false) {
    return `无商品入柜 · ${event.value.openReason ?? "未填写理由"}`;
  }

  return "本次计划领取";
});
const selectedSummary = computed(() =>
  isOperationalEvent.value
    ? operationLabel.value
    : event.value?.intentItems?.length
      ? event.value.intentItems.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
      : "暂未记录意向商品"
);
const flowSteps = computed(() => {
  const status = event.value?.status;
  const hasOpened = status === "opened" || status === "closed" || status === "settled" || status === "refunded";

  return [
    {
      label: isOperationalEvent.value ? "权限校验" : "资格校验",
      description: "已确认账号和柜机信息",
      state: "done" as const
    },
    {
      label: "开柜",
      description: status === "opened" ? "柜门已打开" : "正在等待柜门响应",
      state: hasOpened ? ("done" as const) : ("current" as const)
    },
    {
      label: isOperationalEvent.value ? "操作后关门" : "取货关门",
      description: hasOpened ? "完成后请及时关闭柜门" : "柜门打开后进行",
      state: status === "opened" ? ("current" as const) : status === "closed" || status === "settled" || status === "refunded" ? ("done" as const) : ("todo" as const)
    },
    {
      label: "完成结算",
      description: "关门后自动核对结果",
      state: "todo" as const
    }
  ];
});

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

const goStopped = (title: string, detail: string) => {
  stopPolling();
  uni.reLaunch({
    url: `/pages/common/result?status=warning&resultType=open-stopped&title=${encodeURIComponent(title)}&detail=${encodeURIComponent(detail)}&actionText=${encodeURIComponent("返回首页")}`
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
    hintText.value = nextEvent.hasInboundGoods === true
      ? "请等待柜门完全打开后再放入商品。"
      : nextEvent.hasInboundGoods === false
        ? "请等待柜门完全打开后完成维修、退货或下架操作。"
        : "请等待柜门完全打开后再取货。";
    return;
  }

  if (nextEvent.status === "opened") {
    statusText.value = "柜门已打开";
    hintText.value = nextEvent.hasInboundGoods === true
      ? "商品入柜后请及时关闭柜门，闭门后需要提交入柜商品登记。"
      : nextEvent.hasInboundGoods === false
        ? "操作完成后请及时关闭柜门，系统会按平台结果自动扣减库存。"
        : "取货后请及时关闭柜门，系统会在闭门后继续核对结算结果。";
    return;
  }

  if (nextEvent.status === "closed" || nextEvent.status === "settled" || nextEvent.status === "refunded") {
    goClosed();
    return;
  }

  if (nextEvent.status === "timeout_unopened") {
    goStopped(
      "本次未能确认开门",
      "规定时间内未收到可信开门结果。请先确认现场柜门保持关闭，不要立即重复操作；后台已保留记录，必要时请联系工作人员。"
    );
    return;
  }

  if (nextEvent.status === "failed") {
    goStopped(
      "本次开门未完成",
      "柜机返回了未完成结果。请先核对柜门状态并返回首页，不要立即重复开柜；如仍需领取，请稍后重新进入或联系工作人员。"
    );
    return;
  }

  if (nextEvent.status === "stuck_open") {
    goStopped("柜门状态异常", "柜门长时间未关闭，后台已收到异常记录。请保持现场安全并联系工作人员处理。");
    return;
  }

  statusText.value = "开门结果仍在确认";
  hintText.value = "暂未识别到可信的最终门状态，请勿重复开柜；页面会继续自动查询。";
};

const loadEvent = async () => {
  if (busy.value) {
    return;
  }

  if (!eventId.value) {
    goStopped("缺少事件信息", "未识别到本次开柜事件。请先返回首页核对记录，不要立即重复开柜。");
    return;
  }

  busy.value = true;
  try {
    const response = await mobileApi.getCabinetEvent(eventId.value);
    applyEventState(response);
  } catch {
    statusText.value = "暂时无法同步柜门状态";
    hintText.value = "请勿重复开柜；页面会继续自动查询。请观察现场柜门，必要时联系工作人员。";
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
        <view class="opening-panel">
          <MenuIcon :name="event?.status === 'opened' ? 'door' : 'scan'" size="lg" tone="accent" />
          <view class="opening-panel__copy">
            <text class="opening-panel__title">{{ statusText }}</text>
            <text class="opening-panel__body">{{ hintText }}</text>
          </view>
        </view>

        <FlowSteps :steps="flowSteps" />

        <view class="status-box">
          <text class="status-box__label">柜机编号</text>
          <text class="status-box__value">{{ deviceCode || event?.deviceCode || "-" }}</text>
        </view>
        <view class="status-box">
          <text class="status-box__label">{{ isOperationalEvent ? "本次开门类型" : "本次计划领取" }}</text>
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
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.opening-panel {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-success-line);
  background: rgba(255, 255, 255, 0.92);
}

.opening-panel__copy {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.opening-panel__title {
  font-size: 32rpx;
  font-weight: 900;
  color: var(--vm-text);
}

.opening-panel__body {
  font-size: 22rpx;
  line-height: 1.55;
  color: var(--vm-text-soft);
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

