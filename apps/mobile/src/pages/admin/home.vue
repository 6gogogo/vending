<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
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
  <MobileShell eyebrow="管理员端" :title="sessionStore.user?.name ?? '管理员'" subtitle="移动端提供审核、人员、柜机和日志等核心管理能力。">
    <GlassCard tone="accent">
      <view class="metric-grid">
        <ServiceMetric label="待审申请" :value="metrics.pendingApplications" hint="新注册用户等待处理" tone="warning" />
        <ServiceMetric label="人员总数" :value="metrics.users" hint="包含普通用户、商户和管理员" />
        <ServiceMetric label="柜机数" :value="metrics.devices" hint="当前已接入的柜机数量" />
        <ServiceMetric label="日志量" :value="metrics.logs" hint="用于快速回看近期操作" />
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">管理入口</text>
        <view class="menu-grid">
          <button class="menu-card" @tap="navigate('/pages/admin/reviews')">
            <text class="menu-card__title">审核工作台</text>
            <text class="menu-card__desc">处理待审、驳回和已通过的移动端申请</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/admin/users')">
            <text class="menu-card__title">人员管理</text>
            <text class="menu-card__desc">查看用户详情、修改基础信息和批量设置</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/admin/devices')">
            <text class="menu-card__title">柜机列表</text>
            <text class="menu-card__desc">查看状态、日志、今日服务和远程操作</text>
          </button>
          <button class="menu-card" @tap="navigate('/pages/admin/logs')">
            <text class="menu-card__title">日志记录</text>
            <text class="menu-card__desc">查看全量日志、详情以及可撤销操作</text>
          </button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.metric-grid,
.menu-grid {
  display: grid;
  gap: 18rpx;
}

.section-title,
.menu-card__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.menu-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10rpx;
  min-height: 116rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.14);
  background: rgba(255, 255, 255, 0.62);
}

.menu-card__desc {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  text-align: left;
}
</style>
