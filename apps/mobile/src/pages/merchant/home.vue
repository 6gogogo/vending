<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { formatBeijingDateTime } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { isStockOperatorRole } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const loading = ref(false);
const summary = ref({
  donatedUnits: 0,
  expiredUnits: 0,
  pendingAlerts: 0
});
const templateCount = ref(0);
const recentLogs = ref<Array<{ id: string; description: string; occurredAt: string }>>([]);
const canManageTemplates = computed(
  () => sessionStore.user?.role === "merchant"
);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || !isStockOperatorRole(sessionStore.user.role)) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    const [summaryResponse, templateResponse, traceResponse] = await Promise.all([
      mobileApi.merchantSummary(sessionStore.user.id),
      mobileApi.merchantTemplates(),
      mobileApi.merchantRestockTraces()
    ]);

    summary.value = {
      donatedUnits: summaryResponse.donatedUnits,
      expiredUnits: summaryResponse.expiredUnits,
      pendingAlerts: summaryResponse.pendingAlerts
    };
    templateCount.value = templateResponse.length;
    recentLogs.value = traceResponse.logs.slice(0, 4).map((entry) => ({
      id: entry.id,
      description: entry.description,
      occurredAt: entry.occurredAt
    }));
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const navigate = (url: string) => {
  uni.navigateTo({ url });
};

const goNearby = () => {
  uni.switchTab({ url: "/pages/tabs/nearby" });
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    :eyebrow="sessionStore.user?.role === 'restocker' ? '补货员' : '商家'"
    :title="sessionStore.user?.name ?? (sessionStore.user?.role === 'restocker' ? '补货员工作台' : '商家工作台')"
    :subtitle="appCopy.merchantWelcome"
  >
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" @tap="goNearby">
          <view class="action-button__content">
            <MenuIcon name="restock" size="sm" tone="contrast" />
            <text>选择柜机补货</text>
          </view>
        </button>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/traces')">查看补货记录</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="merchant-overview">
          <view class="merchant-overview__top">
            <view>
              <text class="merchant-overview__eyebrow">今日概览</text>
              <text class="merchant-overview__title">江阴校区3号柜机</text>
              <text class="merchant-overview__subtitle">柜门状态：已关闭 · 可安排补货</text>
            </view>
            <view class="merchant-machine" aria-hidden="true">
              <view class="merchant-machine__body" />
            </view>
          </view>

          <view class="merchant-overview__numbers">
            <view class="merchant-overview__metric">
              <text class="merchant-overview__value vm-number">{{ summary.donatedUnits }}</text>
              <text class="merchant-overview__label">累计补货</text>
            </view>
            <view class="merchant-overview__metric">
              <text class="merchant-overview__value vm-number">{{ templateCount }}</text>
              <text class="merchant-overview__label">常用商品</text>
            </view>
            <view class="merchant-overview__metric">
              <text class="merchant-overview__value vm-number">{{ summary.pendingAlerts }}</text>
              <text class="merchant-overview__label">待处理</text>
            </view>
          </view>

          <button class="merchant-overview__cta" @tap="goNearby">
            <MenuIcon name="device" size="sm" tone="contrast" />
            <text>选择柜机补货</text>
          </button>
        </view>

        <view class="merchant-warning-card">
          <view>
            <text class="merchant-warning-card__title">{{ summary.pendingAlerts > 0 ? "库存提醒" : "库存状态良好" }}</text>
            <text class="merchant-warning-card__body">
              {{ summary.pendingAlerts > 0 ? `当前有 ${summary.pendingAlerts} 条低库存或异常提醒，请优先处理。` : "当前暂无待处理库存提醒，可继续查看补货记录。" }}
            </text>
          </view>
          <text class="vm-status" :class="summary.pendingAlerts > 0 ? 'vm-status--warning' : 'vm-status--success'">
            {{ summary.pendingAlerts > 0 ? "需处理" : "正常" }}
          </text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">常用操作</text>
          <text class="vm-subtitle">可从这里维护常用商品、登记补货和查看货品去向。</text>
        </view>

        <view class="menu-grid menu-grid--tiles">
          <button
            v-if="canManageTemplates"
            class="menu-card"
            @tap="navigate('/pages/merchant/templates')"
          >
            <MenuIcon name="template" size="lg" />
            <text class="menu-card__title">常用商品</text>
            <text class="menu-card__desc">维护属性</text>
          </button>
          <button class="menu-card" @tap="goNearby">
            <MenuIcon name="device" size="lg" />
            <text class="menu-card__title">柜机开门</text>
            <text class="menu-card__desc">选择点位</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/merchant/traces')">
            <MenuIcon name="trace" size="lg" />
            <text class="menu-card__title">货品去向</text>
            <text class="menu-card__desc">批次追踪</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/common/feedback')">
            <MenuIcon name="feedback" size="lg" tone="warning" />
            <text class="menu-card__title">异常上报</text>
            <text class="menu-card__desc">故障反馈</text>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">最近货品流转</text>
          <text class="vm-subtitle">最近的补货与异常处理会同步写入日志，便于追踪去向和处理过程。</text>
        </view>

        <view v-if="recentLogs.length" class="log-list">
          <view v-for="entry in recentLogs" :key="entry.id" class="log-item">
            <text class="log-item__desc">{{ entry.description }}</text>
            <text class="log-item__time">{{ formatBeijingDateTime(entry.occurredAt) }}</text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载日志' : '还没有补货日志'" description="完成首次补货后，这里会展示最近的货品流转记录。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title,
.menu-card__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.menu-card__desc,
.menu-card__tag,
.log-item__time {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
  text-align: center;
}

.log-item__time {
  text-align: left;
}

.hero-action-grid,
.metric-grid,
.menu-grid,
.log-list,
.merchant-overview {
  display: grid;
  gap: 18rpx;
}

.action-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 14rpx;
  width: 100%;
}

.merchant-overview {
  position: relative;
  padding: 26rpx;
  border-radius: 30rpx;
  border: 1rpx solid rgba(46, 125, 70, 0.24);
  background:
    radial-gradient(circle at 88% 12%, rgba(255, 255, 255, 0.24), transparent 30%),
    linear-gradient(135deg, #2e7d46, #75b86b);
  box-shadow: 0 20rpx 48rpx rgba(46, 125, 70, 0.18);
  overflow: hidden;
}

.merchant-overview__top,
.merchant-overview__numbers,
.merchant-overview__cta,
.merchant-warning-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18rpx;
}

.merchant-overview__eyebrow {
  display: block;
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.86);
}

.merchant-overview__title {
  display: block;
  margin-top: 8rpx;
  font-size: 34rpx;
  font-weight: 900;
  color: #ffffff;
}

.merchant-overview__subtitle {
  display: block;
  margin-top: 8rpx;
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.84);
}

.merchant-machine {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 118rpx;
  height: 118rpx;
  border-radius: 28rpx;
  background: rgba(255, 255, 255, 0.18);
}

.merchant-machine__body {
  position: relative;
  width: 64rpx;
  height: 92rpx;
  border-radius: 12rpx;
  background: #2e7d46;
  box-shadow: inset 0 0 0 5rpx rgba(255, 255, 255, 0.26);
}

.merchant-machine__body::before {
  content: "";
  position: absolute;
  left: 10rpx;
  top: 14rpx;
  width: 36rpx;
  height: 56rpx;
  border-radius: 7rpx;
  background:
    linear-gradient(#ff9a33 0 0) 6rpx 10rpx / 9rpx 9rpx no-repeat,
    linear-gradient(#8fcf7f 0 0) 21rpx 10rpx / 9rpx 9rpx no-repeat,
    linear-gradient(#fff0c9 0 0) 6rpx 30rpx / 9rpx 9rpx no-repeat,
    linear-gradient(#ff9a33 0 0) 21rpx 30rpx / 9rpx 9rpx no-repeat,
    #eef8e8;
}

.merchant-overview__numbers {
  padding: 20rpx 18rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.94);
}

.merchant-overview__metric {
  flex: 1;
  display: grid;
  gap: 8rpx;
  text-align: center;
}

.merchant-overview__value {
  font-size: 44rpx;
  line-height: 1;
  font-weight: 900;
  color: var(--vm-accent-strong);
}

.merchant-overview__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.merchant-overview__cta {
  min-height: 100rpx;
  justify-content: center;
  border-radius: 24rpx;
  background: #ffffff;
  font-size: 30rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
  box-shadow: 0 16rpx 32rpx rgba(31, 106, 58, 0.12);
}

.merchant-warning-card {
  align-items: flex-start;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.merchant-warning-card__title {
  display: block;
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.merchant-warning-card__body {
  display: block;
  margin-top: 8rpx;
  font-size: 22rpx;
  line-height: 1.55;
  color: var(--vm-text-soft);
}

.menu-grid--tiles {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 1fr;
}

.menu-card,
.log-item {
  display: grid;
  align-items: start;
  gap: 10rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.menu-card {
  box-sizing: border-box;
  width: 100%;
  height: 220rpx;
  min-height: 220rpx;
  margin: 0;
  align-content: center;
  justify-items: center;
  text-align: center;
  line-height: 1.25;
}

.menu-card__tag {
  color: var(--vm-accent-strong);
}

.log-item__desc {
  font-size: 26rpx;
  color: var(--vm-text);
}
</style>

