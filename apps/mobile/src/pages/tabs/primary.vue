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
import { formatBeijingDateTime } from "../../utils/datetime";
import { appendErrorContext, getErrorMessage } from "../../utils/error-message";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";
import { syncRoleTabBar } from "../../utils/role-routing";
import { scanDeviceCode } from "../../utils/scan-device";

type AdminTaskFilter = "all" | "expiry" | "feedback" | "system";

const sessionStore = useSessionStore();
const loading = ref(false);
const loadError = ref("");
const specialHasLoadedData = ref(false);
const records = ref<InventoryMovement[]>([]);
const templates = ref<MerchantGoodsTemplate[]>([]);
const pendingApplications = ref<RegistrationApplication[]>([]);
const alerts = ref<AlertTask[]>([]);
const rejectReasons = reactive<Record<string, string>>({});
const adminTaskFilter = ref<AdminTaskFilter>("all");
const adminApplicationsError = ref("");
const adminAlertsError = ref("");
const resolvingTaskIds = ref<string[]>([]);
const reviewingApplicationId = ref("");
const adminAiLoading = ref(false);
const adminAiReport = ref<AiOperationsReport | null>(null);
const adminAiError = ref("");
let latestLoadRequestId = 0;
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

const quotaGoodsNameMap = computed(() => {
  const map = new Map<string, string>();

  for (const policyWindow of sessionStore.quota?.activeWindows ?? []) {
    for (const item of policyWindow.goodsLimits) {
      map.set(item.goodsId, item.goodsName);
    }
  }

  return map;
});

const permissions = computed(() =>
  Object.entries(sessionStore.quota?.remainingByGoods ?? {}).map(([goodsId, quantity]) => ({
    goodsId,
    quantity,
    goodsName:
      quotaGoodsNameMap.value.get(goodsId) ??
      records.value.find((item) => item.goodsId === goodsId)?.goodsName ??
      goodsId
  }))
);

const activeWindows = computed(() =>
  (sessionStore.quota?.activeWindows ?? []).map(
    (item) =>
      `${String(item.startHour).padStart(2, "0")}:00-${String(item.endHour).padStart(2, "0")}:00`
  )
);
const remainingTotal = computed(() => {
  const visibleGoodsTotal = permissions.value.reduce((sum, item) => sum + item.quantity, 0);
  return (
    sessionStore.quota?.remainingFreeTotal ??
    Math.min(sessionStore.quota?.remainingDaily ?? visibleGoodsTotal, visibleGoodsTotal)
  );
});
const usedCount = computed(() => sessionStore.quota?.usedCount ?? 0);
const loadErrorTitle = computed(() =>
  sessionStore.user?.role === "special" ? "资格与领取数据未更新" : "数据同步失败"
);
const loadErrorBody = computed(() => {
  if (sessionStore.user?.role !== "special") {
    return loadError.value;
  }

  const guidance = specialHasLoadedData.value
    ? "下方保留最近一次成功数据供参考，但扫码开柜和柜机选择已暂停。"
    : "这不是“无额度”，恢复前不会把未确认数据当作空结果。";
  return appendErrorContext(loadError.value, guidance);
});
const todayStatus = computed(() => {
  if (loadError.value) {
    return "待重新确认";
  }

  if (!activeWindows.value.length) {
    return "暂未开放";
  }

  return remainingTotal.value > 0 ? "今日可领取" : "免费额度已用完";
});
const todayStatusClass = computed(() =>
  !loadError.value && activeWindows.value.length && remainingTotal.value > 0
    ? "vm-status--available"
    : "vm-status--warning"
);
const todaySuggestion = computed(() => {
  if (loadError.value) {
    return "资格、领取记录和提醒尚未重新确认，请先同步；恢复前不要发起开柜。";
  }

  if (!activeWindows.value.length) {
    return "开放时段开始后可前往柜机，必要时可联系工作人员确认资格。";
  }

  if (remainingTotal.value <= 0) {
    return "今天免费额度已用完，仍可选择柜机，超出部分会按商品价格结算。";
  }

  return "可先查看附近柜机，也可以到柜机前扫码开门。";
});

const taskButtonText = (task: AlertTask) => (task.grade === "fault" ? "标记已知晓" : "手动完成");
const activeAlerts = computed(() => alerts.value.filter((item) => item.status !== "resolved"));
const showInitialLoading = computed(
  () =>
    loading.value &&
    !records.value.length &&
    !templates.value.length &&
    !alerts.value.length &&
    !pendingApplications.value.length
);
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
    return "可以先看今日资格，再选择附近柜机；首次使用时按页面提示一步步操作即可。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "先选柜机，再登记商品、数量、保质期和批次。";
  }

  return "可在这里按分类处理待办、审核申请和查看柜机。";
});

const specialReminderText = computed(() => {
  if (sessionStore.user?.role !== "special") {
    return "";
  }

  if (loadError.value) {
    return "资格数据待重新确认，恢复前扫码开柜和柜机选择均已暂停。";
  }

  if (activeWindows.value.length) {
    return `今日可领取时段：${activeWindows.value.join("、")}`;
  }

  return "当前暂无开放时段，系统会按业务时间自动刷新资格。";
});

const heroSupport = computed(() => {
  if (sessionStore.user?.role === "special") {
    if (loadError.value) {
      return {
        title: "同步提示",
        lines: [
          "资格与领取数据同步失败，当前状态不能用于开柜判断。",
          specialHasLoadedData.value ? "页面只保留最近一次成功数据供参考。" : "这不是无额度，也不是资格被取消。",
          "请先点击重新同步；恢复前扫码开柜和柜机选择均已暂停。"
        ]
      };
    }

    return {
      title: "领取提示",
      lines: [
        activeWindows.value.length ? `开放时段：${activeWindows.value.join("、")}` : "当前暂无开放时段，请稍后再查看。",
        todaySuggestion.value,
        activeAlerts.value.length
          ? `你有 ${activeAlerts.value.length} 条提醒待确认。`
          : "如遇识别异常或柜机问题，请先提交反馈；柜机现场异常可在反馈页查看联系电话。"
      ]
    };
  }

  if (sessionStore.user?.role === "merchant") {
    return {
      title: "补货提示",
      lines: [
        `当前已维护常用商品 ${templates.value.length} 个，累计补货 ${merchantSummary.value.donatedUnits} 件。`,
        "补货前先确认柜机在线，再登记商品、数量、生产日期和批次；柜机现场异常请从异常上报进入。"
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
    ? `工作人员已处理你的${feedbackType}反馈。若问题仍存在，可继续补充反馈。`
    : "工作人员已处理你的反馈。若问题仍存在，可继续补充反馈。";
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
    title: resolvedFeedback.userNoticeTitle || "反馈处理结果",
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
  const requestId = ++latestLoadRequestId;
  await sessionStore.bootstrap();

  if (requestId !== latestLoadRequestId) {
    return;
  }

  const user = sessionStore.user;
  const sessionToken = sessionStore.token;

  if (!user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  const ownsLatestLoad = () =>
    requestId === latestLoadRequestId &&
    sessionStore.user?.id === user.id &&
    sessionStore.token === sessionToken;

  syncRoleTabBar(user.role);
  loading.value = true;

  try {
    if (user.role === "special") {
      adminAiReport.value = null;
      adminAiError.value = "";
      adminAiLoading.value = false;
      const [quota, recordResponse, alertResponse] = await Promise.all([
        mobileApi.getQuotaSummary(user.phone),
        mobileApi.listRecords(user.id, user.role),
        mobileApi.alerts(undefined, user.id)
      ]);

      if (!ownsLatestLoad()) {
        return;
      }

      sessionStore.setQuota(quota);
      records.value = recordResponse;
      alerts.value = alertResponse;
      specialHasLoadedData.value = true;
      if (!maybeNotifyResolvedFeedback()) {
        maybeNotifyUserAlert();
      }
      loadError.value = "";
      return;
    }

    if (user.role === "merchant") {
      adminAiReport.value = null;
      adminAiError.value = "";
      adminAiLoading.value = false;
      const [templateResponse, summaryResponse, traceResponse] = await Promise.all([
        mobileApi.merchantTemplates(),
        mobileApi.merchantSummary(user.id),
        mobileApi.merchantRestockTraces()
      ]);

      if (!ownsLatestLoad()) {
        return;
      }

      templates.value = templateResponse;
      merchantSummary.value = {
        donatedUnits: summaryResponse.donatedUnits,
        expiredUnits: summaryResponse.expiredUnits,
        pendingAlerts: summaryResponse.pendingAlerts
      };
      records.value = traceResponse.records;
      alerts.value = [];
      loadError.value = "";
      return;
    }

    adminAiLoading.value = true;
    const [applicationResult, alertResult, aiResult] = await Promise.allSettled([
      mobileApi.registrationApplications("pending"),
      mobileApi.alerts(),
      mobileApi.aiOperationsReport({ reportType: "daily" })
    ]);

    if (!ownsLatestLoad()) {
      return;
    }

    if (applicationResult.status === "fulfilled") {
      pendingApplications.value = applicationResult.value;
      adminApplicationsError.value = "";
    } else {
      adminApplicationsError.value = getErrorMessage(applicationResult.reason);
    }

    if (alertResult.status === "fulfilled") {
      alerts.value = alertResult.value;
      adminAlertsError.value = "";
      maybeNotifyResolvedFeedback();
    } else {
      adminAlertsError.value = getErrorMessage(alertResult.reason);
    }

    if (aiResult.status === "fulfilled") {
      adminAiReport.value = aiResult.value;
      adminAiError.value = "";
    } else {
      adminAiReport.value = null;
      adminAiError.value = getErrorMessage(aiResult.reason);
    }
    adminAiLoading.value = false;
    loadError.value = "";
  } catch (error) {
    if (!ownsLatestLoad()) {
      return;
    }

    loadError.value = getErrorMessage(error);
  } finally {
    if (ownsLatestLoad()) {
      loading.value = false;
    }
  }
};

const goNearby = () => {
  if (sessionStore.user?.role === "special" && loadError.value) {
    uni.showModal({
      title: "资格与领取数据尚未确认",
      content: "请先重新同步，确认资格和领取状态后再选择柜机。",
      showCancel: false
    });
    return;
  }

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
  if (loadError.value) {
    uni.showModal({
      title: "资格与领取数据尚未确认",
      content: "请先重新同步，确认资格和领取状态后再扫码开柜。",
      showCancel: false
    });
    return;
  }

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
  if (resolvingTaskIds.value.includes(task.id)) {
    return;
  }

  uni.showModal({
    title: "确认处理",
    content: task.grade === "fault" ? "确认标记为已知晓？该任务仍会保留为需继续跟进的故障状态。" : "确认手动完成这条待办？完成后会移入已处理记录。",
    success: async ({ confirm }) => {
      if (!confirm) {
        return;
      }

      resolvingTaskIds.value = [...resolvingTaskIds.value, task.id];
      try {
        await mobileApi.resolveAlert(
          task.id,
          task.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
        );
        showOperationSuccess(task.grade === "fault" ? "已标记为知晓" : "待办已完成");
        await load();
      } catch (error) {
        showOperationFailure(error);
      } finally {
        resolvingTaskIds.value = resolvingTaskIds.value.filter((taskId) => taskId !== task.id);
      }
    }
  });
};

const reviewApplication = async (applicationId: string, decision: "approved" | "rejected") => {
  if (reviewingApplicationId.value) {
    return;
  }

  const application = pendingApplications.value.find((item) => item.id === applicationId);
  const applicantName = application?.profile.merchantName || application?.profile.name || application?.phone || applicationId;
  const roleName = application?.requestedRole ? roleLabelMap[application.requestedRole] : "未知角色";
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: decision === "approved" ? "确认通过申请" : "确认驳回申请",
      content: [
        `申请人：${applicantName}`,
        `申请角色：${roleName}`,
        decision === "rejected" ? `驳回原因：${rejectReasons[applicationId]?.trim() || "未填写"}` : "通过后将立即生效。"
      ].join("\n"),
      confirmText: decision === "approved" ? "确认通过" : "确认驳回",
      cancelText: "取消",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  reviewingApplicationId.value = applicationId;
  try {
    await mobileApi.reviewRegistration(applicationId, {
      decision,
      reason: decision === "rejected" ? rejectReasons[applicationId] : undefined
    });
    pendingApplications.value = pendingApplications.value.filter((item) => item.id !== applicationId);
    delete rejectReasons[applicationId];
    showOperationSuccess(decision === "approved" ? "已通过申请" : "已驳回申请");
    await load();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    reviewingApplicationId.value = "";
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

    <template v-if="sessionStore.user?.role === 'special'" #hero-side>
      <view class="hero-status-panel">
        <text class="hero-status-panel__label">今日状态</text>
        <text class="vm-status" :class="todayStatusClass">{{ todayStatus }}</text>
        <view class="hero-status-panel__metrics">
          <view>
            <text class="hero-status-panel__value vm-number">{{ loadError ? "—" : remainingTotal }}</text>
            <text class="hero-status-panel__meta">剩余次数</text>
          </view>
          <view>
            <text class="hero-status-panel__value vm-number">{{ loadError ? "—" : usedCount }}</text>
            <text class="hero-status-panel__meta">已用免费额度</text>
          </view>
        </view>
      </view>
    </template>

    <template #hero-actions>
      <view class="hero-action-grid">
        <template v-if="sessionStore.user?.role === 'special'">
          <button class="vm-button vm-button--warning action-button" :disabled="Boolean(loadError)" @tap="goScanPickup">
            <view class="action-button__content">
              <MenuIcon name="scan" size="sm" tone="contrast" />
              <text>{{ loadError ? "扫码开柜（待同步）" : "扫码开柜" }}</text>
            </view>
          </button>
          <button class="vm-button vm-button--ghost action-button" :disabled="Boolean(loadError)" @tap="goNearby">
            <view class="action-button__content">
              <MenuIcon name="nearby" size="sm" tone="neutral" />
              <text>{{ loadError ? "选择柜机（待同步）" : "就近找柜机" }}</text>
            </view>
          </button>
        </template>
        <template v-else-if="sessionStore.user?.role === 'merchant'">
          <button class="vm-button action-button" @tap="goNearby">
            <view class="action-button__content">
              <MenuIcon name="device" size="sm" tone="contrast" />
              <text>选择柜机补货</text>
            </view>
          </button>
          <button class="vm-button vm-button--ghost action-button" @tap="navigate('/pages/merchant/templates')">
            <view class="action-button__content">
              <MenuIcon name="template" size="sm" tone="neutral" />
              <text>常用商品</text>
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

    <GlassCard v-if="loadError" tone="warning" compact>
      <view class="state-banner" role="alert" aria-live="assertive" aria-atomic="true">
        <view class="state-banner__copy">
          <text class="state-banner__title">{{ loadErrorTitle }}</text>
          <text class="state-banner__body">{{ loadErrorBody }}</text>
        </view>
        <button class="vm-button vm-button--ghost state-banner__button" :disabled="loading" @tap="load">
          {{ loading ? "同步中" : "重新同步" }}
        </button>
      </view>
    </GlassCard>

    <GlassCard v-if="showInitialLoading" tone="quiet" compact>
      <view class="loading-panel">
        <text class="loading-panel__title">正在同步当前账号数据</text>
        <view class="loading-panel__bar loading-panel__bar--wide" />
        <view class="loading-panel__bar loading-panel__bar--mid" />
      </view>
    </GlassCard>

    <GlassCard tone="accent" v-if="sessionStore.user?.role === 'special'">
      <view class="vm-stack">
        <view class="section-heading">
          <view class="section-heading__row">
            <text class="section-heading__title">今日是否可领取</text>
            <text class="vm-status" :class="todayStatusClass">{{ todayStatus }}</text>
          </view>
          <text class="vm-subtitle">{{ todaySuggestion }}</text>
        </view>
        <template v-if="!loadError || specialHasLoadedData">
        <view class="metric-grid">
          <ServiceMetric label="可领取次数" :value="remainingTotal" hint="今日剩余额度" tone="accent" />
          <ServiceMetric label="已用免费额度" :value="usedCount" hint="今日实际占用的免费额度" />
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
        <EmptyState v-else title="当前没有免费额度" description="仍可选择柜机，超出免费额度的部分会按商品价格结算。" />
        </template>
        <EmptyState
          v-else
          title="资格数据等待重新确认"
          description="同步失败不代表没有额度；重新同步成功后才会恢复开柜入口。"
        />
        <view class="action-grid">
          <button class="vm-button vm-button--warning" :disabled="Boolean(loadError)" @tap="goScanPickup">
            {{ loadError ? "扫码开柜（待同步）" : "扫码开柜" }}
          </button>
          <button class="vm-button vm-button--ghost" :disabled="Boolean(loadError)" @tap="goNearby">
            {{ loadError ? "附近柜机（待同步）" : "附近柜机" }}
          </button>
          <button class="vm-button vm-button--ghost action-grid__wide" @tap="goRecords">查看领取记录</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="accent" v-else-if="sessionStore.user?.role === 'merchant'">
      <view class="vm-stack">
        <view class="section-heading">
          <view class="section-heading__row">
            <text class="section-heading__title">商家工作台</text>
            <text class="vm-status vm-status--certified">已认证</text>
          </view>
          <text class="vm-subtitle">先选择柜机，再完成补货登记。</text>
        </view>

        <view class="metric-grid">
          <ServiceMetric label="总库存" :value="merchantSummary.donatedUnits" hint="累计补货件数" tone="accent" />
          <ServiceMetric label="需补货" :value="merchantSummary.pendingAlerts" hint="低库存或异常提醒" tone="warning" />
          <ServiceMetric label="常用商品" :value="templates.length" hint="补货登记可直接选用" />
        </view>

        <view class="merchant-action-grid">
          <button class="merchant-action-card merchant-action-card--recommended" @tap="goNearby">
            <MenuIcon name="restock" size="lg" tone="accent" />
            <view class="merchant-action-card__copy">
              <text class="merchant-action-card__title">选择柜机</text>
              <text class="merchant-action-card__body">先选点位再补货</text>
            </view>
          </button>
          <button class="merchant-action-card" @tap="navigate('/pages/merchant/restock')">
            <MenuIcon name="template" size="lg" tone="accent" />
            <view class="merchant-action-card__copy">
              <text class="merchant-action-card__title">补货登记</text>
              <text class="merchant-action-card__body">记录数量和批次</text>
            </view>
          </button>
          <button class="merchant-action-card" @tap="goRecords">
            <MenuIcon name="trace" size="lg" tone="accent" />
            <view class="merchant-action-card__copy">
              <text class="merchant-action-card__title">流转明细</text>
              <text class="merchant-action-card__body">查看批次和去向</text>
            </view>
          </button>
          <button class="merchant-action-card" @tap="navigate('/pages/common/feedback')">
            <MenuIcon name="feedback" size="lg" tone="warning" />
            <view class="merchant-action-card__copy">
              <text class="merchant-action-card__title">异常上报</text>
              <text class="merchant-action-card__body">上报库存或柜机问题</text>
            </view>
          </button>
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
              {{ item.label }} {{ item.count }}
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
          <view v-if="adminAlertsError" class="vm-stack">
            <EmptyState title="待办数据加载失败" :description="adminAlertsError" />
            <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">重新加载</button>
          </view>
          <scroll-view v-else-if="filteredActiveAlerts.length" class="scroll-list" scroll-y>
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
                  <button
                    class="vm-inline-button"
                    :disabled="resolvingTaskIds.includes(task.id)"
                    :loading="resolvingTaskIds.includes(task.id)"
                    @tap="resolveTask(task)"
                  >
                    {{ resolvingTaskIds.includes(task.id) ? "处理中" : taskButtonText(task) }}
                  </button>
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
          <view v-if="adminApplicationsError" class="vm-stack">
            <EmptyState title="审批数据加载失败" :description="adminApplicationsError" />
            <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">重新加载</button>
          </view>
          <scroll-view v-else-if="pendingApplications.length" class="scroll-list" scroll-y>
            <view class="simple-list">
              <view v-for="item in pendingApplications" :key="item.id" class="simple-card">
                <text class="simple-card__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</text>
                <text class="simple-card__meta">{{ item.phone }} · {{ item.requestedRole === "special" ? "用户" : item.requestedRole === "merchant" ? "商家" : "管理员" }}</text>
                <input v-model="rejectReasons[item.id]" :aria-label="`${item.profile.name || item.phone} 的驳回原因`" class="vm-field__input" placeholder="驳回时填写原因（选填）" />
                <view class="action-grid">
                  <button
                    class="vm-button"
                    :disabled="Boolean(reviewingApplicationId)"
                    :loading="reviewingApplicationId === item.id"
                    @tap="reviewApplication(item.id, 'approved')"
                  >
                    通过
                  </button>
                  <button
                    class="vm-button vm-button--ghost"
                    :disabled="Boolean(reviewingApplicationId)"
                    :loading="reviewingApplicationId === item.id"
                    @tap="reviewApplication(item.id, 'rejected')"
                  >
                    驳回
                  </button>
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
          <text class="section-heading__title">{{ sessionStore.user?.role === "special" ? "最近领取记录" : sessionStore.user?.role === "merchant" ? "最近货品流转" : "常用入口" }}</text>
          <text class="vm-subtitle">
            {{
              sessionStore.user?.role === "special"
                ? "最近三次领取会展示在这里。"
                : sessionStore.user?.role === "merchant"
                  ? "补货、调拨和去向记录会同步到这里。"
                  : "可继续进入柜机列表、人员日志和设置页。"
            }}
          </text>
        </view>

        <view v-if="sessionStore.user?.role !== 'admin' && records.length" class="simple-list">
          <view v-for="record in records.slice(0, 3)" :key="record.id" class="simple-list__row">
            <view class="simple-list__main">
              <text>{{ record.goodsName }}</text>
              <text class="simple-list__meta">
                {{ record.deviceCode }} · {{ formatBeijingDateTime(record.happenedAt) }}
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

.section-heading__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
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
.ai-list,
.merchant-action-grid {
  display: grid;
  gap: 16rpx;
}

.metric-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.hero-action-grid,
.action-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.action-grid__wide {
  grid-column: 1 / -1;
}

.action-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 14rpx;
  width: 100%;
}

.action-button {
  min-height: 104rpx;
}

.compact-reminder,
.hero-note,
.hero-status-panel,
.state-banner,
.loading-panel {
  display: grid;
  gap: 10rpx;
}

.compact-reminder {
  padding: 4rpx 0 4rpx 18rpx;
  border-left: 4rpx solid rgba(255, 255, 255, 0.54);
}

.compact-reminder__label {
  font-size: 20rpx;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.82);
}

.compact-reminder__body,
.hero-note__body {
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.9);
  line-height: 1.6;
}

.hero-status-panel {
  align-content: center;
  min-height: 100%;
  padding: 22rpx;
  border-radius: 24rpx;
  border: 1rpx solid rgba(255, 255, 255, 0.48);
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 12rpx 28rpx rgba(31, 106, 58, 0.12);
}

.hero-status-panel__label,
.state-banner__title,
.loading-panel__title {
  font-size: 24rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.hero-status-panel__metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}

.hero-status-panel__value {
  display: block;
  font-size: 44rpx;
  line-height: 1;
  color: var(--vm-accent-strong);
}

.hero-status-panel__meta,
.state-banner__body {
  display: block;
  margin-top: 8rpx;
  font-size: 22rpx;
  line-height: 1.5;
  color: var(--vm-text-soft);
}

.state-banner {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.state-banner__copy {
  min-width: 0;
}

.state-banner__button {
  min-height: 76rpx;
  padding: 0 24rpx;
  font-size: 26rpx;
}

.loading-panel__bar {
  height: 18rpx;
  border-radius: 999rpx;
  background: linear-gradient(90deg, #edf2f6 0%, #ffffff 52%, #edf2f6 100%);
  background-size: 220% 100%;
  animation: primary-loading 1200ms ease-in-out infinite;
}

.loading-panel__bar--wide {
  width: 84%;
}

.loading-panel__bar--mid {
  width: 58%;
}

.hero-note__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.simple-list,
.info-list {
  gap: 0;
  border-top: 1rpx solid var(--vm-line);
}

.simple-list__row,
.info-item,
.simple-card {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 0;
  border-bottom: 1rpx solid var(--vm-line);
  background: transparent;
}

.simple-list__row,
.info-item {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.simple-list__row > text:first-child {
  font-size: 26rpx;
  line-height: 1.35;
  color: var(--vm-text);
}

.simple-list__row:last-child,
.info-item:last-child,
.simple-card:last-child {
  border-bottom: 0;
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

.merchant-action-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 1fr;
}

.merchant-action-card {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12rpx;
  align-content: start;
  align-items: start;
  box-sizing: border-box;
  width: 100%;
  height: 208rpx;
  min-height: 208rpx;
  margin: 0;
  padding: 22rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-card-bg);
  box-shadow: var(--vm-shadow-soft);
  text-align: left;
  line-height: 1.25;
}

.merchant-action-card--recommended {
  border-color: var(--vm-accent-line);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(234, 246, 228, 0.88)),
    var(--vm-card-bg);
  box-shadow: 0 14rpx 30rpx rgba(46, 125, 70, 0.12);
}

.merchant-action-card__copy {
  display: grid;
  gap: 6rpx;
  min-width: 0;
}

.merchant-action-card__title {
  display: block;
  overflow: hidden;
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.merchant-action-card--recommended .merchant-action-card__title {
  color: var(--vm-accent-strong);
}

.merchant-action-card__body {
  display: -webkit-box;
  overflow: hidden;
  font-size: 22rpx;
  line-height: 1.5;
  color: var(--vm-text-soft);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.task-filter-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 82rpx;
  padding: 0 20rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
  font-size: 24rpx;
  line-height: 1.25;
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
  padding: 4rpx 0 4rpx 20rpx;
  background: var(--vm-info-bg);
  border-left: 4rpx solid var(--vm-info);
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

@keyframes primary-loading {
  from {
    background-position: 100% 50%;
  }

  to {
    background-position: 0 50%;
  }
}

:global(.vm-page--accessible) .hero-action-grid,
:global(.vm-page--accessible) .action-grid,
:global(.vm-page--accessible) .metric-grid,
:global(.vm-page--accessible) .task-filter-grid,
:global(.vm-page--accessible) .merchant-action-grid,
:global(.vm-page--accessible) .state-banner {
  grid-template-columns: 1fr;
}

:global(.vm-page--accessible) .hero-status-panel {
  padding: 22rpx;
  border: 4rpx solid var(--vm-line-strong);
  background: #ffffff;
}

:global(.vm-page--accessible) .hero-status-panel__value {
  font-size: 58rpx;
}

:global(.vm-page--accessible) .hero-status-panel__meta,
:global(.vm-page--accessible) .state-banner__body {
  font-size: 28rpx;
  color: var(--vm-text);
}

:global(.vm-page--accessible) .merchant-action-card {
  height: auto;
  min-height: 244rpx;
}

:global(.vm-page--accessible) .loading-panel__bar {
  animation: none;
}

@media screen and (min-width: 720px) {
  .metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  :global(.vm-page--accessible) .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>

