<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { resolveHomePath } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const status = ref<"success" | "warning" | "danger">("success");
const resultType = ref<
  "generic" |
  "pickup" |
  "feedback" |
  "payment" |
  "payment-unpaid" |
  "restock" |
  "register" |
  "open-pending" |
  "open-stopped"
>("generic");
const title = ref("操作结果");
const detail = ref("系统已处理本次请求。");
const actionText = ref("返回首页");
const backUrl = ref("");
const resultMeta = computed(() => {
  if (resultType.value === "feedback") {
    return {
      label: "反馈已进入待办",
      symbol: "✓",
      suggestion: "处理结果会在首页提醒中同步；需要补充信息时可再次提交。"
    };
  }

  if (resultType.value === "payment") {
    return {
      label: status.value === "success" ? "支付已完成" : "支付需要确认",
      symbol: status.value === "success" ? "✓" : "!",
      suggestion: status.value === "success"
        ? "系统会同步柜机结算状态，可回到记录页查看。"
        : "未支付不会扣款，也不会回写付款成功。"
    };
  }

  if (resultType.value === "payment-unpaid") {
    return {
      label: "支付未完成",
      symbol: "!",
      suggestion: "订单会保留为待支付；你可以返回支付面板继续处理。"
    };
  }

  if (resultType.value === "restock") {
    return {
      label: "补货登记成功",
      symbol: "✓",
      suggestion: "入柜批次已写入库存，可继续查看批次流转。"
    };
  }

  if (resultType.value === "register") {
    return {
      label: "资料已提交",
      symbol: "✓",
      suggestion: "审核通过后即可登录对应身份入口。"
    };
  }

  if (resultType.value === "open-pending") {
    return {
      label: "开门结果仍在确认",
      symbol: "!",
      suggestion: "请先查看现场柜门并等待状态更新，不要重复发起开柜。"
    };
  }

  if (resultType.value === "open-stopped") {
    return {
      label: "本次开门未完成",
      symbol: "!",
      suggestion: "请先确认柜门状态并返回首页，不要立即重复开柜。"
    };
  }

  if (status.value === "success") {
    return {
      label: resultType.value === "pickup" ? "领取成功" : "操作成功",
      symbol: "✓",
      suggestion: resultType.value === "pickup"
        ? "可继续查看领取记录和剩余额度。"
        : "请求已完成，可返回首页继续操作。"
    };
  }

  if (status.value === "warning") {
    return {
      label: "需要确认收费",
      symbol: "!",
      suggestion: "超出免费额度的部分可继续领取，系统会按商品价格结算。"
    };
  }

  return {
    label: "无法完成",
    symbol: "!",
    suggestion: "请按提示重新尝试；如果柜机不可用，请联系工作人员。"
  };
});
const feedbackActionText = computed(() => (resultType.value === "feedback" ? "补充反馈" : "提交反馈"));

const goHome = async () => {
  if (backUrl.value) {
    uni.reLaunch({
      url: backUrl.value
    });
    return;
  }

  await sessionStore.bootstrap();
  uni.reLaunch({
    url: sessionStore.user ? resolveHomePath(sessionStore.user.role) : "/pages/common/login"
  });
};

const goFeedback = () => {
  uni.navigateTo({
    url: "/pages/common/feedback"
  });
};

onLoad((query) => {
  status.value =
    query.status === "warning" || query.status === "danger" ? query.status : "success";
  resultType.value =
    query.resultType === "pickup" ||
    query.resultType === "feedback" ||
    query.resultType === "payment" ||
    query.resultType === "payment-unpaid" ||
    query.resultType === "restock" ||
    query.resultType === "register" ||
    query.resultType === "open-pending" ||
    query.resultType === "open-stopped"
      ? query.resultType
      : "generic";
  title.value = typeof query.title === "string" ? decodeURIComponent(query.title) : title.value;
  detail.value = typeof query.detail === "string" ? decodeURIComponent(query.detail) : detail.value;
  actionText.value =
    typeof query.actionText === "string" ? decodeURIComponent(query.actionText) : actionText.value;
  backUrl.value = typeof query.backUrl === "string" ? decodeURIComponent(query.backUrl) : "";
});
</script>

<template>
  <MobileShell eyebrow="处理结果" :title="title" :subtitle="detail">
    <GlassCard :tone="status === 'success' ? 'accent' : status === 'warning' ? 'warning' : 'quiet'">
      <view class="vm-stack">
        <view class="result-hero" :class="`result-hero--${status}`">
          <MenuIcon :name="status === 'success' ? 'success' : 'warning'" size="lg" :tone="status === 'success' ? 'accent' : 'warning'" />
          <view class="result-hero__copy">
            <text class="result-icon">{{ resultMeta.label }}</text>
            <text class="result-hint">{{ resultMeta.suggestion }}</text>
          </view>
        </view>
        <view class="result-detail">
          <text class="result-detail__label">原因 / 说明</text>
          <text class="result-detail__body">{{ detail }}</text>
        </view>
        <view class="result-actions">
          <button class="vm-button" @tap="goHome">{{ actionText }}</button>
          <button class="vm-button vm-button--ghost" @tap="goFeedback">{{ feedbackActionText }}</button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.result-icon {
  font-size: 38rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.result-hero,
.result-detail,
.result-actions {
  display: grid;
  gap: 12rpx;
}

.result-hero,
.result-detail {
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.result-hero {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  min-height: 156rpx;
}

.result-hero--success {
  border-color: var(--vm-success-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(237, 248, 233, 0.96));
}

.result-hero--warning {
  border-color: var(--vm-warning-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(255, 243, 226, 0.96));
}

.result-hero--danger {
  border-color: var(--vm-danger-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(255, 240, 238, 0.96));
}

.result-hero__copy {
  display: grid;
  gap: 8rpx;
}

.result-hint,
.result-detail__label,
.result-detail__body {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}

.result-detail__label {
  font-weight: 700;
  color: var(--vm-accent-strong);
}

.result-detail__body {
  color: var(--vm-text);
}

</style>
