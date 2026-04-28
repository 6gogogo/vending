<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type {
  AiOperationsReport,
  AlertTask,
  InventoryMovement,
  MerchantGoodsTemplate,
  RegistrationApplication
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";
import { syncRoleTabBar } from "../../utils/role-routing";
import { scanDeviceCode } from "../../utils/scan-device";

type AdminTaskFilter = "all" | "expiry" | "feedback" | "system";

const sessionStore = useSessionStore();
const loading = ref(false);
const records = ref<InventoryMovement[]>([]);
const templates = ref<MerchantGoodsTemplate[]>([]);
const pendingApplications = ref<RegistrationApplication[]>([]);
const alerts = ref<AlertTask[]>([]);
const rejectReasons = reactive<Record<string, string>>({});
const adminTaskFilter = ref<AdminTaskFilter>("all");
const adminAiLoading = ref(false);
const adminAiReport = ref<AiOperationsReport | null>(null);
const adminAiError = ref("");
const merchantSummary = ref({
  donatedUnits: 0,
  expiredUnits: 0,
  pendingAlerts: 0
});

const adminTaskLabelMap: Record<Exclude<AdminTaskFilter, "all">, string> = {
  expiry: "临期",
  feedback: "用户反馈",
  system: "系统提示"
};

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
const resolveAdminTaskFilter = (task: AlertTask): Exclude<AdminTaskFilter, "all"> => {
  if (task.type === "expiry") {
    return "expiry";
  }

  if (task.type === "user_feedback" || task.grade === "feedback") {
    return "feedback";
  }

  return "system";
};

const adminTaskBuckets = computed(() => {
  const counts: Record<Exclude<AdminTaskFilter, "all">, number> = {
    expiry: 0,
    feedback: 0,
    system: 0
  };

  for (const task of activeAlerts.value) {
    counts[resolveAdminTaskFilter(task)] += 1;
  }

  return [
    {
      key: "all" as const,
      label: "全部",
      count: activeAlerts.value.length
    },
    ...Object.entries(adminTaskLabelMap).map(([key, label]) => ({
      key: key as Exclude<AdminTaskFilter, "all">,
      label,
      count: counts[key as Exclude<AdminTaskFilter, "all">]
    }))
  ];
});

const filteredActiveAlerts = computed(() => {
  if (adminTaskFilter.value === "all") {
    return activeAlerts.value;
  }

  return activeAlerts.value.filter((item) => resolveAdminTaskFilter(item) === adminTaskFilter.value);
});

const adminTaskOverviewText = computed(() =>
  adminTaskBuckets.value
    .filter((item) => item.key !== "all")
    .map((item) => `${item.label}*${item.count}`)
    .join("，")
);

const pageSubtitle = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "先确认今日资格，再去最近柜机领取；如果遇到异常，也可以直接反馈。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "可在这里查看模板、登记补货和货物流向。";
  }

  return "可在这里按分类处理待办、审核申请和查看柜机。";
});

const specialReminderText = computed(() => {
  if (sessionStore.user?.role !== "special") {
    return "";
  }

  if (activeWindows.value.length) {
    return `今日可领取时段：${activeWindows.value.join("、")}`;
  }

  return "当前暂无开放时段，系统会按业务时间自动刷新资格。";
});

const heroSupport = computed(() => {
  if (sessionStore.user?.role === "special") {
    return {
      title: "领取提示",
      lines: [
        activeWindows.value.length ? `可领取时段：${activeWindows.value.join("、")}` : "当前暂无开放时段，请稍后再查看。",
        permissions.value.length ? "请先确认今天可领取的物资，再前往柜机。" : "当前没有可领取额度，无需重复提交。",
        activeAlerts.value.length ? `你有 ${activeAlerts.value.length} 条提醒待确认。` : "如遇识别异常或柜机问题，可直接提交反馈。"
      ]
    };
  }

  if (sessionStore.user?.role === "merchant") {
    return {
      title: "补货提示",
      lines: [
        `当前已维护模板 ${templates.value.length} 个，累计补货 ${merchantSummary.value.donatedUnits} 件。`,
        "可先维护商品属性，再登记补货和查看去向。"
      ]
    };
  }

  return {
    title: "处理提示",
    lines: [
      pendingApplications.value.length
        ? `当前有 ${pendingApplications.value.length} 条待审申请，请先处理。`
        : "当前没有待审申请。",
      adminTaskOverviewText.value
        ? `待办分类：${adminTaskOverviewText.value}。`
        : "当前没有新的待办事件。",
      adminAiReport.value
        ? "AI 助手已生成安排建议，可先按建议分配处理顺序。"
        : "如需继续核对柜机、人员或日志，可从下方入口进入。"
    ]
  };
});

const resolveFeedbackNoticeContent = (task: AlertTask) => {
  if (task.userNoticeContent) {
    return task.userNoticeContent;
  }

  const feedbackType =
    task.feedbackType ??
    task.detail.match(/反馈类型：([^。；]+)/)?.[1]?.trim();

  return feedbackType
    ? `管理员已接受你的${feedbackType}反馈，感谢你的反馈`
    : "管理员已接受你的反馈，感谢你的反馈";
};

const maybeNotifyResolvedFeedback = () => {
  if (!sessionStore.user) {
    return false;
  }

  const resolvedFeedback = alerts.value
    .filter(
      (item) =>
        item.status === "resolved" &&
        item.type === "user_feedback" &&
        item.targetUserId === sessionStore.user?.id &&
        (item.feedbackSource === "app" || item.feedbackSource === undefined)
    )
    .slice()
    .sort((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""))
    .find((item) => !uni.getStorageSync(`mobile:resolved-feedback:${item.id}`));

  if (!resolvedFeedback) {
    return false;
  }

  uni.setStorageSync(`mobile:resolved-feedback:${resolvedFeedback.id}`, "1");
  uni.showModal({
    title: resolvedFeedback.userNoticeTitle || "反馈已接受",
    content: resolveFeedbackNoticeContent(resolvedFeedback),
    showCancel: false
  });
  return true;
};

const maybeNotifyUserAlert = () => {
  if (sessionStore.user?.role !== "special") {
    return false;
  }

  const mismatchAlert = alerts.value.find(
    (item) =>
      item.status === "open" &&
      item.type === "callback" &&
      item.title.includes("不一致") &&
      item.targetUserId === sessionStore.user?.id
  );

  if (!mismatchAlert) {
    return false;
  }

  const storageKey = `mobile:user-alert:${mismatchAlert.id}`;

  if (uni.getStorageSync(storageKey)) {
    return false;
  }

  uni.setStorageSync(storageKey, "1");
  uni.showModal({
    title: "领取结果需要确认",
    content: mismatchAlert.previewDetail || mismatchAlert.detail,
    showCancel: false
  });
  return true;
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
      adminAiReport.value = null;
      adminAiError.value = "";
      adminAiLoading.value = false;
      const [quota, recordResponse, alertResponse] = await Promise.all([
        mobileApi.getQuotaSummary(sessionStore.user.phone),
        mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role),
        mobileApi.alerts(undefined, sessionStore.user.id)
      ]);
      sessionStore.setQuota(quota);
      records.value = recordResponse;
      alerts.value = alertResponse;
      if (!maybeNotifyResolvedFeedback()) {
        maybeNotifyUserAlert();
      }
      return;
    }

    if (sessionStore.user.role === "merchant") {
      adminAiReport.value = null;
      adminAiError.value = "";
      adminAiLoading.value = false;
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
      alerts.value = [];
      return;
    }

    adminAiLoading.value = true;
    const adminAiPromise = mobileApi
      .aiOperationsReport({
        reportType: "daily"
      })
      .then((report) => {
        adminAiReport.value = report;
        adminAiError.value = "";
      })
      .catch((error) => {
        adminAiReport.value = null;
        adminAiError.value = getErrorMessage(error);
      })
      .finally(() => {
        adminAiLoading.value = false;
      });

    const [applicationResponse, alertResponse] = await Promise.all([
      mobileApi.registrationApplications("pending"),
      mobileApi.alerts()
    ]);
    pendingApplications.value = applicationResponse;
    alerts.value = alertResponse;
    maybeNotifyResolvedFeedback();
    await adminAiPromise;
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

const taskCategoryLabel = (task: AlertTask) => adminTaskLabelMap[resolveAdminTaskFilter(task)];

const taskContextText = (task: AlertTask) =>
  [task.deviceName ?? task.deviceCode, task.goodsSummary ?? task.goodsName, task.targetUserName]
    .filter((item): item is string => Boolean(item))
    .join(" · ");

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
    :header-style="sessionStore.user?.role === 'special' ? 'panel' : 'compact'"
    :eyebrow="roleLabelMap[sessionStore.user?.role ?? 'special']"
    :title="sessionStore.user?.name ?? '公益智助柜'"
    :subtitle="pageSubtitle"
  >
    <template v-if="sessionStore.user?.role === 'special'" #hero-extra>
      <view class="compact-reminder">
        <text class="compact-reminder__label">提醒</text>
        <text class="compact-reminder__body">{{ specialReminderText }}</text>
      </view>
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
          <text class="vm-subtitle">请先确认可领取物资、开放时段和提醒事项。</text>
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

    <template v-else-if="sessionStore.user?.role === 'admin'">
      <GlassCard tone="accent">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">待办总览</text>
            <text class="vm-subtitle">先看分类数量，再按轻重缓急安排处理。</text>
          </view>
          <view class="metric-grid">
            <ServiceMetric label="待处理事件" :value="activeAlerts.length" hint="优先处理故障、反馈和预警" tone="warning" />
            <ServiceMetric label="注册审批" :value="pendingApplications.length" hint="等待管理员审核" />
          </view>
          <view class="task-filter-grid">
            <button
              v-for="item in adminTaskBuckets"
              :key="item.key"
              class="task-filter-chip"
              :class="{ 'task-filter-chip--active': adminTaskFilter === item.key }"
              @tap="adminTaskFilter = item.key"
            >
              {{ item.label }}*{{ item.count }}
            </button>
          </view>
        </view>
      </GlassCard>

      <GlassCard tone="quiet">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">AI 助手安排建议</text>
            <text class="vm-subtitle">帮助你快速判断今天先处理什么。</text>
          </view>
          <view v-if="adminAiReport" class="ai-summary-card">
            <text class="ai-summary-card__title">{{ adminAiReport.summary }}</text>
            <view class="ai-list">
              <text
                v-for="item in adminAiReport.recommendedActions.slice(0, 3)"
                :key="item"
                class="ai-list__item"
              >
                {{ item }}
              </text>
            </view>
          </view>
          <EmptyState
            v-else
            :title="adminAiLoading ? 'AI 正在整理安排建议' : 'AI 助手暂时不可用'"
            :description="adminAiLoading ? '请稍候，系统正在结合待办和风险生成建议。' : adminAiError || '后台模型配置完成后，这里会给出处理顺序建议。'"
          />
        </view>
      </GlassCard>

      <GlassCard tone="quiet">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">待处理事件</text>
            <text class="vm-subtitle">支持按分类筛选，处理前先核对柜机、商品和用户信息。</text>
          </view>
          <scroll-view v-if="filteredActiveAlerts.length" class="scroll-list" scroll-y>
            <view class="simple-list">
              <view v-for="task in filteredActiveAlerts" :key="task.id" class="simple-card">
                <view class="simple-card__header">
                  <text class="simple-card__title">{{ task.title }}</text>
                  <text class="vm-status vm-status--warning">{{ taskCategoryLabel(task) }}</text>
                </view>
                <text v-if="taskContextText(task)" class="simple-card__meta">{{ taskContextText(task) }}</text>
                <text class="simple-card__meta">{{ task.previewDetail || task.detail }}</text>
                <view class="inline-actions">
                  <button class="vm-inline-button" @tap="showTaskDetail(task)">详情</button>
                  <button class="vm-inline-button" @tap="resolveTask(task)">{{ taskButtonText(task) }}</button>
                </view>
              </view>
            </view>
          </scroll-view>
          <EmptyState
            v-else
            :title="loading ? '正在加载待办事件' : adminTaskFilter === 'all' ? '当前没有待处理事件' : `当前没有${adminTaskBuckets.find((item) => item.key === adminTaskFilter)?.label || ''}`"
            :description="adminTaskFilter === 'all' ? '新的故障、反馈和预警会出现在这里。' : '你可以切换其他分类继续查看。'"
          />
        </view>
      </GlassCard>

      <GlassCard tone="quiet">
        <view class="vm-stack">
          <view class="section-heading">
            <text class="section-heading__title">注册审批</text>
            <text class="vm-subtitle">可在这里直接通过或驳回申请。</text>
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

    <GlassCard tone="quiet">
      <view class="vm-stack hero-note">
        <text class="hero-note__title">{{ heroSupport.title }}</text>
        <text v-for="line in heroSupport.lines" :key="line" class="hero-note__body">{{ line }}</text>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
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

.metric-grid,
.action-grid,
.simple-list,
.info-list,
.hero-action-grid,
.task-filter-grid,
.ai-list {
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

.compact-reminder,
.hero-note {
  display: grid;
  gap: 10rpx;
}

.compact-reminder {
  padding: 18rpx 20rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--vm-info-line);
  background: var(--vm-surface-soft);
}

.compact-reminder__label {
  font-size: 20rpx;
  letter-spacing: 0.08em;
  color: var(--vm-accent-strong);
}

.compact-reminder__body,
.hero-note__body {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.hero-note__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.simple-list__row,
.info-item,
.simple-card {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
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

.simple-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
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

.task-filter-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.task-filter-chip {
  min-height: 82rpx;
  padding: 0 20rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
  font-size: 24rpx;
  color: var(--vm-text);
}

.task-filter-chip--active {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
  color: var(--vm-info);
}

.ai-summary-card {
  display: grid;
  gap: 16rpx;
  padding: 24rpx;
  border-radius: 26rpx;
  background: var(--vm-info-bg);
  border: 1rpx solid var(--vm-info-line);
}

.ai-summary-card__title,
.ai-list__item {
  font-size: 24rpx;
  line-height: 1.7;
  color: var(--vm-text);
}

.ai-summary-card__title {
  font-size: 26rpx;
  font-weight: 700;
}
</style>

