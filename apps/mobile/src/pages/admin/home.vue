<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const loading = ref(false);
const metrics = ref({
  pendingApplications: 0,
  users: 0,
  devices: 0,
  logs: 0
});

const priorityText = computed(() => {
  if (metrics.value.pendingApplications > 0) {
    return `当前有 ${metrics.value.pendingApplications} 条待审申请，建议先处理审核，再回看柜机和日志。`;
  }

  return "当前待审压力较低，可优先检查柜机状态和近期待办日志。";
});

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin") {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    const [applications, users, devices, logs] = await Promise.all([
      mobileApi.registrationApplications("pending"),
      mobileApi.users(),
      mobileApi.listDevices(),
      mobileApi.logs()
    ]);

    metrics.value = {
      pendingApplications: applications.length,
      users: users.length,
      devices: devices.length,
      logs: logs.length
    };
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
  <MobileShell eyebrow="管理员端" :title="sessionStore.user?.name ?? '管理员'" subtitle="移动端适合处理审核、巡检与异常确认，复杂批量操作继续交给 PC 端。">
    <template #hero-side>
      <GlassCard tone="quiet" compact>
        <view class="hero-support">
          <text class="hero-support__title">当前优先事项</text>
          <text class="hero-support__body">{{ priorityText }}</text>
          <text class="hero-support__body">移动端更适合边走边看设备、边处理待办，避免漏掉现场问题。</text>
        </view>
      </GlassCard>
    </template>

    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" @tap="navigate('/pages/admin/reviews')">先处理待审</button>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/admin/devices')">查看柜机状态</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日管理概览</text>
          <text class="vm-subtitle">把最常看的审核、人员、设备和日志放在同一屏，适合快速扫读。</text>
        </view>

        <view class="metric-grid">
          <ServiceMetric label="待审申请" :value="metrics.pendingApplications" hint="新注册用户等待处理" tone="warning" />
          <ServiceMetric label="人员总数" :value="metrics.users" hint="包含普通用户、商户和管理员" />
          <ServiceMetric label="柜机数" :value="metrics.devices" hint="当前已接入的柜机数量" />
          <ServiceMetric label="日志量" :value="metrics.logs" hint="用于快速回看近期操作" />
        </view>

        <view class="ops-banner">
          <text class="ops-banner__title">{{ loading ? "正在刷新数据" : "移动端建议先看待审与柜机" }}</text>
          <text class="ops-banner__body">
            {{ loading ? "请稍候，系统正在同步最新审核、设备和日志数据。" : priorityText }}
          </text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">管理入口</text>
          <text class="vm-subtitle">菜单按典型工作顺序排列，先审资料，再看人员、柜机和日志。</text>
        </view>

        <view class="menu-grid">
          <button class="menu-card" @tap="navigate('/pages/admin/reviews')">
            <view class="menu-card__top">
              <MenuIcon name="review" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">优先</text>
                <text class="menu-card__title">审核工作台</text>
              </view>
            </view>
            <text class="menu-card__desc">处理待审、驳回和已通过的移动端申请</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/admin/users')">
            <view class="menu-card__top">
              <MenuIcon name="users" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">人员</text>
                <text class="menu-card__title">人员管理</text>
              </view>
            </view>
            <text class="menu-card__desc">查看用户详情、修改基础信息和批量设置</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/admin/devices')">
            <view class="menu-card__top">
              <MenuIcon name="device" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">巡检</text>
                <text class="menu-card__title">柜机列表</text>
              </view>
            </view>
            <text class="menu-card__desc">查看状态、日志、今日服务和远程操作</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/admin/logs')">
            <view class="menu-card__top">
              <MenuIcon name="logs" size="lg" />
              <view class="menu-card__title-group">
                <text class="menu-card__tag">追踪</text>
                <text class="menu-card__title">日志记录</text>
              </view>
            </view>
            <text class="menu-card__desc">查看全量日志、详情以及可撤销操作</text>
          </button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.hero-support,
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.hero-support__title,
.section-heading__title,
.menu-card__title,
.ops-banner__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.hero-support__body,
.menu-card__desc,
.ops-banner__body,
.menu-card__tag {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
  text-align: left;
}

.hero-action-grid,
.metric-grid,
.menu-grid {
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
.menu-card {
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
</style>
