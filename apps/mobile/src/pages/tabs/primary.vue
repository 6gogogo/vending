<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { AlertTask, InventoryMovement, MerchantGoodsTemplate, RegistrationApplication } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";
import { syncRoleTabBar } from "../../utils/role-routing";
import { scanDeviceCode } from "../../utils/scan-device";

const sessionStore = useSessionStore();
const loading = ref(false);
const records = ref<InventoryMovement[]>([]);
const templates = ref<MerchantGoodsTemplate[]>([]);
const pendingApplications = ref<RegistrationApplication[]>([]);
const alerts = ref<AlertTask[]>([]);
const rejectReasons = reactive<Record<string, string>>({});
const merchantSummary = ref({
  donatedUnits: 0,
  expiredUnits: 0,
  pendingAlerts: 0
});

const permissions = computed(() =>
  Object.entries(sessionStore.quota?.remainingByGoods ?? {}).map(([goodsId, quantity]) => ({
    goodsId,
    quantity,
    goodsName:
      records.value.find((item) => item.goodsId === goodsId)?.goodsName ?? goodsId
  }))
);

const activeWindows = computed(() =>
  (sessionStore.quota?.activeWindows ?? []).map(
    (item) =>
      `${String(item.startHour).padStart(2, "0")}:00-${String(item.endHour).padStart(2, "0")}:00`
  )
);

const taskButtonText = (task: AlertTask) => (task.grade === "fault" ? "标记已知晓" : "手动完成");
const activeAlerts = computed(() => alerts.value.filter((item) => item.status !== "resolved"));
const pageSubtitle = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "先确认今日资格，再去最近柜机领取；如果遇到异常，也可以直接反馈。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "把模板、补货和异常处理放在同一入口里，方便边走边完成操作。";
  }

  return "把待办、审批和柜机入口集中在首页，适合移动端快速处理关键事项。";
});

const heroSupport = computed(() => {
  if (sessionStore.user?.role === "special") {
    return {
      title: "服务提醒",
      lines: [
        activeWindows.value.length ? `可领取时段：${activeWindows.value.join("、")}` : "当前暂无开放时段，系统会按业务时间自动刷新资格。",
        permissions.value.length ? "建议先确认今天还能领什么，再去最近柜机，能少走冤枉路。" : "当前没有可领取额度时，不需要重复提交，等待时段刷新即可。",
        activeAlerts.value.length ? `你有 ${activeAlerts.value.length} 条待确认提醒，可在下方查看。` : "如果识别结果异常或柜机有问题，可以直接联系工作人员。"
      ]
    };
  }

  if (sessionStore.user?.role === "merchant") {
    return {
      title: "今日重点",
      lines: [
        `当前维护模板 ${templates.value.length} 个，补货总量 ${merchantSummary.value.donatedUnits} 件。`,
        merchantSummary.value.pendingAlerts
          ? `有 ${merchantSummary.value.pendingAlerts} 条待处理异常，建议先核对。`
          : "当前异常压力较低，可以直接安排补货与模板维护。",
        "遵循“模板 -> 补货 -> 去向”的顺序，操作会更稳。"
      ]
    };
  }

  return {
    title: "处理重点",
    lines: [
      pendingApplications.value.length
        ? `当前有 ${pendingApplications.value.length} 条待审申请，建议优先处理。`
        : "当前没有待审申请，可优先巡检柜机和日志。",
      activeAlerts.value.length
        ? `待处理事件 ${activeAlerts.value.length} 条，移动端适合快速查看和确认。`
        : "当前没有新的待办事件，可继续查看柜机与人员日志。",
      "移动端优先解决现场决策，复杂批量操作可继续交给 PC 端。"
    ]
  };
});

const maybeNotifyUserAlert = () => {
  if (sessionStore.user?.role !== "special") {
    return;
  }

  const mismatchAlert = alerts.value.find(
    (item) =>
      item.status === "open" &&
      item.type === "callback" &&
      item.title.includes("不一致") &&
      item.targetUserId === sessionStore.user?.id
  );

  if (!mismatchAlert) {
    return;
  }

  const storageKey = `mobile:user-alert:${mismatchAlert.id}`;

  if (uni.getStorageSync(storageKey)) {
    return;
  }

  uni.setStorageSync(storageKey, "1");
  uni.showModal({
    title: "领取结果需要确认",
    content: mismatchAlert.previewDetail || mismatchAlert.detail,
    showCancel: false
  });
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
  loading.value = true;

  try {
    if (sessionStore.user.role === "special") {
      const [quota, recordResponse, alertResponse] = await Promise.all([
        mobileApi.getQuotaSummary(sessionStore.user.phone),
        mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role),
        mobileApi.alerts("open", sessionStore.user.id)
      ]);
      sessionStore.setQuota(quota);
      records.value = recordResponse;
      alerts.value = alertResponse;
      maybeNotifyUserAlert();
      return;
    }

    if (sessionStore.user.role === "merchant") {
      const [templateResponse, summaryResponse, traceResponse] = await Promise.all([
        mobileApi.merchantTemplates(),
        mobileApi.merchantSummary(sessionStore.user.id),
        mobileApi.merchantRestockTraces()
      ]);
      templates.value = templateResponse;
      merchantSummary.value = {
        donatedUnits: summaryResponse.donatedUnits,
        expiredUnits: summaryResponse.expiredUnits,
        pendingAlerts: summaryResponse.pendingAlerts
      };
      records.value = traceResponse.records;
      return;
    }

    const [applicationResponse, alertResponse] = await Promise.all([
      mobileApi.registrationApplications("pending"),
      mobileApi.alerts()
    ]);
    pendingApplications.value = applicationResponse;
    alerts.value = alertResponse;
  } catch (error) {
    showOperationFailure(error);
  } finally {
    loading.value = false;
  }
};

const goNearby = () => {
  uni.switchTab({
    url: "/pages/tabs/nearby"
  });
};

const goRecords = () => {
  uni.switchTab({
    url: "/pages/tabs/records"
  });
};

const goScanPickup = async () => {
  try {
    const deviceCode = await scanDeviceCode();

    if (!deviceCode) {
      uni.showToast({
        title: "未识别到柜机编号",
        icon: "none"
      });
      return;
    }

    await mobileApi.getDevice(deviceCode);
    uni.navigateTo({
      url: `/pages/special/device-detail?deviceCode=${encodeURIComponent(deviceCode)}&scan=1`
    });
  } catch (error) {
    showOperationFailure(error);
  }
};

const navigate = (url: string) => {
  uni.navigateTo({ url });
};

const showTaskDetail = (task: AlertTask) => {
  uni.showModal({
    title: task.title,
    content: task.detail,
    showCancel: false
  });
};

const resolveTask = (task: AlertTask) => {
  uni.showModal({
    title: "确认处理",
    content: task.grade === "fault" ? "确认标记为已知晓？" : "确认手动完成这条待办？",
    success: async ({ confirm }) => {
      if (!confirm) {
        return;
      }

      try {
        await mobileApi.resolveAlert(
          task.id,
          task.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
        );
        showOperationSuccess();
        await load();
      } catch (error) {
        showOperationFailure(error);
      }
    }
  });
};

const reviewApplication = async (applicationId: string, decision: "approved" | "rejected") => {
  try {
    await mobileApi.reviewRegistration(applicationId, {
      decision,
      reason: decision === "rejected" ? rejectReasons[applicationId] : undefined
    });
    showOperationSuccess();
    await load();
  } catch (error) {
    showOperationFailure(error);
  }
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    :mode="sessionStore.user?.role === 'special' ? 'care' : sessionStore.user?.role ? 'ops' : 'care'"
    :eyebrow="roleLabelMap[sessionStore.user?.role ?? 'special']"
    :title="sessionStore.user?.name ?? '公益智助柜'"
    :subtitle="pageSubtitle"
  >
    <template #hero-side>
      <GlassCard tone="quiet" compact>
        <view class="hero-support">
          <text class="hero-support__title">{{ heroSupport.title }}</text>
          <text v-for="line in heroSupport.lines" :key="line" class="hero-support__body">{{ line }}</text>
        </view>
      </GlassCard>
    </template>

    <template #hero-actions>
      <view class="hero-action-grid">
        <template v-if="sessionStore.user?.role === 'special'">
          <button class="vm-button action-button" @tap="goNearby">
            <view class="action-button__content">
              <MenuIcon name="nearby" size="sm" tone="contrast" />
              <text>就近找柜机</text>
            </view>
          </button>
          <button class="vm-button vm-button--ghost action-button" @tap="goScanPickup">
            <view class="action-button__content">
              <MenuIcon name="scan" size="sm" tone="neutral" />
              <text>扫码开门</text>
            </view>
          </button>
        </template>
        <template v-else-if="sessionStore.user?.role === 'merchant'">
          <button class="vm-button action-button" @tap="navigate('/pages/merchant/restock')">
            <view class="action-button__content">
              <MenuIcon name="restock" size="sm" tone="contrast" />
              <text>立即登记补货</text>
            </view>
          </button>
          <button class="vm-button vm-button--ghost action-button" @tap="navigate('/pages/merchant/templates')">
            <view class="action-button__content">
              <MenuIcon name="template" size="sm" tone="neutral" />
              <text>管理商品属性</text>
            </view>
          </button>
        </template>
        <template v-else>
          <button class="vm-button action-button" @tap="navigate('/pages/admin/reviews')">
            <view class="action-button__content">
              <MenuIcon name="review" size="sm" tone="contrast" />
              <text>处理待审申请</text>
            </view>
          </button>
          <button class="vm-button vm-button--ghost action-button" @tap="navigate('/pages/admin/devices')">
            <view class="action-button__content">
              <MenuIcon name="device" size="sm" tone="neutral" />
              <text>查看柜机状态</text>
            </view>
          </button>
        </template>
      </view>
    </template>

    <GlassCard tone="accent" v-if="sessionStore.user?.role === 'special'">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日资格与提醒</text>
          <text class="vm-subtitle">把最关心的可领信息、开放时段和异常兜底放在前面，判断会更轻松。</text>
        </view>
        <view class="metric-grid">
          <ServiceMetric label="可领物资" :value="permissions.length" hint="当前时段内允许领取的种类" tone="accent" />
          <ServiceMetric label="开放时段" :value="activeWindows.length" hint="仅在开放时段内可领取" />
          <ServiceMetric label="提醒事项" :value="activeAlerts.length" hint="识别差异或核对提醒会在这里显示" tone="warning" />
        </view>
        <view class="info-list">
          <view class="info-item">
            <text class="info-item__label">当前时段</text>
            <text class="info-item__value">{{ activeWindows.length ? activeWindows.join("、") : "当前暂无可领取时段" }}</text>
          </view>
        </view>
        <view v-if="permissions.length" class="simple-list">
          <view v-for="item in permissions" :key="item.goodsId" class="simple-list__row">
            <text>{{ item.goodsName }}</text>
            <text class="vm-status vm-status--success">剩余 {{ item.quantity }} 件</text>
          </view>
        </view>
        <EmptyState v-else title="当前没有可领取额度" description="请等待时段开始或联系工作人员核对资格。" />
        <view class="action-grid">
          <button class="vm-button vm-button--ghost" @tap="goScanPickup">扫码开门</button>
          <button class="vm-button" @tap="goNearby">去附近柜机领取</button>
          <button class="vm-button vm-button--ghost" @tap="goRecords">查看领取详情</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="accent" v-else-if="sessionStore.user?.role === 'merchant'">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">商品属性与补货</text>
          <text class="vm-subtitle">先维护商品属性，再按属性登记补货；货物流向可在底部第三栏查看。</text>
        </view>
        <view class="metric-grid">
          <ServiceMetric label="属性数量" :value="templates.length" hint="当前账号已维护商品属性" />
          <ServiceMetric label="累计补货件数" :value="merchantSummary.donatedUnits" hint="当前账号历史累计" />
          <ServiceMetric label="待处理问题" :value="merchantSummary.pendingAlerts" hint="优先处理反馈与异常" tone="warning" />
        </view>
        <view class="action-grid">
          <button class="vm-button" @tap="navigate('/pages/merchant/templates')">管理商品属性</button>
          <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/restock')">立即登记补货</button>
        </view>
      </view>
    </GlassCard>

    <template v-else>
      <GlassCard tone="accent">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">待办事件</text>
            <text class="vm-subtitle">未完成事件始终排在最前面，处理前需要再次确认。</text>
          </view>
          <view class="metric-grid">
            <ServiceMetric label="待处理事件" :value="activeAlerts.length" hint="优先处理故障、反馈和预警" tone="warning" />
            <ServiceMetric label="注册审批" :value="pendingApplications.length" hint="等待管理员审核" />
          </view>
        </view>
      </GlassCard>

      <GlassCard tone="quiet">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">待处理事件</text>
            <text class="vm-subtitle">点击详情可查看完整备注，点击按钮前会再次确认。</text>
          </view>
          <scroll-view v-if="activeAlerts.length" class="scroll-list" scroll-y>
            <view class="simple-list">
              <view v-for="task in activeAlerts" :key="task.id" class="simple-card">
                <text class="simple-card__title">{{ task.title }}</text>
                <text class="simple-card__meta">{{ task.previewDetail || task.detail }}</text>
                <view class="inline-actions">
                  <button class="vm-inline-button" @tap="showTaskDetail(task)">详情</button>
                  <button class="vm-inline-button" @tap="resolveTask(task)">{{ taskButtonText(task) }}</button>
                </view>
              </view>
            </view>
          </scroll-view>
          <EmptyState v-else :title="loading ? '正在加载待办事件' : '当前没有待处理事件'" description="新的故障、反馈和预警会出现在这里。" />
        </view>
      </GlassCard>

      <GlassCard tone="quiet">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">注册审批</text>
            <text class="vm-subtitle">可在这里直接通过或驳回，也可进入更完整的审核页继续处理。</text>
          </view>
          <scroll-view v-if="pendingApplications.length" class="scroll-list" scroll-y>
            <view class="simple-list">
              <view v-for="item in pendingApplications" :key="item.id" class="simple-card">
                <text class="simple-card__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</text>
                <text class="simple-card__meta">{{ item.phone }} · {{ item.requestedRole === "special" ? "普通用户" : item.requestedRole === "merchant" ? "爱心商户" : "管理员" }}</text>
                <input v-model="rejectReasons[item.id]" class="vm-field__input" placeholder="驳回时填写原因（选填）" />
                <view class="action-grid">
                  <button class="vm-button" @tap="reviewApplication(item.id, 'approved')">通过</button>
                  <button class="vm-button vm-button--ghost" @tap="reviewApplication(item.id, 'rejected')">驳回</button>
                </view>
              </view>
            </view>
          </scroll-view>
          <EmptyState v-else :title="loading ? '正在加载注册审批' : '当前没有待审核申请'" description="新的注册申请进入系统后，这里会同步显示。" />
        </view>
      </GlassCard>
    </template>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">{{ sessionStore.user?.role === "special" ? "最近领取记录" : sessionStore.user?.role === "merchant" ? "最近货物流动" : "常用入口" }}</text>
          <text class="vm-subtitle">
            {{
              sessionStore.user?.role === "special"
                ? "最近三次领取会展示在这里。"
                : sessionStore.user?.role === "merchant"
                  ? "补货和去向记录会同步到这里。"
                  : "可继续进入柜机列表、人员日志和设置页。"
            }}
          </text>
        </view>

        <view v-if="sessionStore.user?.role !== 'admin' && records.length" class="simple-list">
          <view v-for="record in records.slice(0, 3)" :key="record.id" class="simple-list__row">
            <view class="simple-list__main">
              <text>{{ record.goodsName }}</text>
              <text class="simple-list__meta">
                {{ record.deviceCode }} · {{ record.happenedAt.slice(0, 16).replace("T", " ") }}
              </text>
            </view>
            <text class="vm-status vm-status--success">
              {{ record.type === "pickup" ? "领取" : "流转" }} {{ record.quantity }} 件
            </text>
          </view>
        </view>

        <view v-else-if="sessionStore.user?.role === 'admin'" class="action-grid">
          <button class="vm-button" @tap="navigate('/pages/admin/devices')">进入柜机列表</button>
          <button class="vm-button vm-button--ghost" @tap="goRecords">查看人员日志</button>
        </view>

        <EmptyState
          v-else
          :title="loading ? '正在加载数据' : '当前还没有记录'"
          :description="loading ? '请稍候，系统正在同步当前账号数据。' : '完成首次业务操作后，这里会展示最近变更。'"
        />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.hero-support,
.section-heading,
.info-item,
.simple-list__main {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.section-heading__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.hero-support__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.hero-support__body {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.metric-grid,
.action-grid,
.simple-list,
.info-list,
.hero-action-grid {
  display: grid;
  gap: 16rpx;
}

.action-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 14rpx;
  width: 100%;
}

.simple-list__row,
.info-item,
.simple-card {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.simple-list__row,
.info-item {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.simple-list__meta,
.info-item__label,
.simple-card__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.info-item__value,
.simple-card__title {
  font-size: 26rpx;
  color: var(--vm-text);
}

.inline-actions {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.scroll-list {
  max-height: 620rpx;
}

.vm-inline-button {
  border: 0;
  background: transparent;
  color: var(--vm-accent-strong);
  font-size: 24rpx;
  padding: 0;
}
</style>
