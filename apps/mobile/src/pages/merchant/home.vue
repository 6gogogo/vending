<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const loading = ref(false);
const summary = ref({
  donatedUnits: 0,
  expiredUnits: 0,
  pendingAlerts: 0
});
const templateCount = ref(0);
const recentLogs = ref<Array<{ id: string; description: string; occurredAt: string }>>([]);

const focusText = computed(() => {
  if (summary.value.pendingAlerts > 0) {
    return `当前有 ${summary.value.pendingAlerts} 条待处理反馈或预警，建议先核对异常，再安排补货。`;
  }

  return "当前异常压力较低，可以优先维护模板、登记补货并回看货物流向。";
});

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
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

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="爱心商户" :title="sessionStore.user?.name ?? '爱心商户'" :subtitle="appCopy.merchantWelcome">
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" @tap="navigate('/pages/merchant/restock')">立即登记补货</button>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/traces')">查看货物去向</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日运营概览</text>
          <text class="vm-subtitle">请先查看补货量、异常提醒和模板数量。</text>
        </view>

        <view class="metric-grid">
          <ServiceMetric label="累计补货件数" :value="summary.donatedUnits" hint="当前账号历史累计" />
          <ServiceMetric label="待处理反馈/预警" :value="summary.pendingAlerts" hint="优先处理异常与到期问题" tone="warning" />
          <ServiceMetric label="模板数量" :value="templateCount" hint="常用货品模板总数" />
        </view>

        <view class="ops-banner">
          <text class="ops-banner__title">{{ loading ? "正在刷新运营数据" : "请先查看异常提醒" }}</text>
          <text class="ops-banner__body">
            {{ loading ? "请稍候，系统正在同步补货概览和最近流向。" : focusText }}
          </text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">常用操作</text>
          <text class="vm-subtitle">可从这里维护模板、登记补货和查看货物去向。</text>
        </view>

        <view class="menu-grid">
          <button class="menu-card" @tap="navigate('/pages/merchant/templates')">
            <view class="menu-card__top">
              <MenuIcon name="template" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">准备</text>
                <text class="menu-card__title">货品模板</text>
              </view>
            </view>
            <text class="menu-card__desc">维护名称、分类、默认数量与保质天数</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/merchant/restock')">
            <view class="menu-card__top">
              <MenuIcon name="restock" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">执行</text>
                <text class="menu-card__title">按模板补货</text>
              </view>
            </view>
            <text class="menu-card__desc">选择柜机、数量、生产日期快速登记</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/merchant/traces')">
            <view class="menu-card__top">
              <MenuIcon name="trace" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">追踪</text>
                <text class="menu-card__title">货物去向</text>
              </view>
            </view>
            <text class="menu-card__desc">查看自己补货批次、剩余量和日志去向</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/common/feedback')">
            <view class="menu-card__top">
              <MenuIcon name="feedback" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">反馈</text>
                <text class="menu-card__title">提交反馈</text>
              </view>
            </view>
            <text class="menu-card__desc">反馈机器故障、服务问题或其他情况</text>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">最近货物流动</text>
          <text class="vm-subtitle">最近的补货与异常处理会同步写入日志，便于追踪去向和责任。</text>
        </view>

        <view v-if="recentLogs.length" class="log-list">
          <view v-for="entry in recentLogs" :key="entry.id" class="log-item">
            <text class="log-item__desc">{{ entry.description }}</text>
            <text class="log-item__time">{{ entry.occurredAt.slice(0, 16).replace("T", " ") }}</text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载日志' : '还没有补货日志'" description="完成首次补货后，这里会展示最近的货物流动记录。" />
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
.menu-card__title,
.ops-banner__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.menu-card__desc,
.ops-banner__body,
.menu-card__tag,
.log-item__time {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
  text-align: left;
}

.hero-action-grid,
.metric-grid,
.menu-grid,
.log-list {
  display: grid;
  gap: 18rpx;
}

.menu-card__top,
.menu-card__title-group {
  display: flex;
}

.menu-card__top {
  width: 100%;
  align-items: center;
  gap: 18rpx;
}

.menu-card__title-group {
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 6rpx;
}

.ops-banner,
.menu-card,
.log-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
  background: rgba(255, 255, 255, 0.62);
}

.menu-card {
  min-height: 132rpx;
}

.menu-card__tag {
  color: var(--vm-accent-strong);
}

.log-item__desc {
  font-size: 26rpx;
  color: var(--vm-text);
}
</style>
