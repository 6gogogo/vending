<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { DeviceRecord, SpecialAccessPolicy, UserAccessPolicy, UserManagementDetail } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { resolveActorLink } from "../utils/entity-links";
import { formatDateTime } from "../utils/datetime";

const route = useRoute();
const weekdayOptions = [
  { label: "周一", value: 1 },
  { label: "周二", value: 2 },
  { label: "周三", value: 3 },
  { label: "周四", value: 4 },
  { label: "周五", value: 5 },
  { label: "周六", value: 6 },
  { label: "周日", value: 0 }
];
const calendarWeekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const hourOptions = Array.from({ length: 24 }, (_, index) => index);
const hourEndOptions = Array.from({ length: 24 }, (_, index) => index + 1);

interface PersonalPolicyRow {
  policyId: string;
  goodsId: string;
  goodsName: string;
  quantity: number;
  weekdays: number[];
  startHour: number;
  endHour: number;
  status: UserAccessPolicy["status"];
  sourcePolicyId?: string;
  sourceLabel: string;
  effectiveLabel: string;
  effectiveFromDateKey?: string;
}

const detail = ref<UserManagementDetail>();
const devices = ref<DeviceRecord[]>([]);
const goodsCatalog = ref<Array<{ goodsId: string; name: string; category: "food" | "drink" | "daily" }>>([]);
const policyTemplates = ref<SpecialAccessPolicy[]>([]);
const loading = ref(false);
const saving = ref(false);
const applyingNowPolicyId = ref("");
const calendarMonth = ref("");
const selectedDateKey = ref("");
const editingAccessPolicyId = ref("");

const form = ref({
  deviceCode: "",
  goodsId: "",
  quantity: 1,
  direction: "deduct" as "restock" | "deduct",
  note: ""
});

const accessPolicyForm = ref({
  weekdays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 12,
  status: "active" as UserAccessPolicy["status"],
  goodsLimits: [{ goodsId: "", quantity: 1 }]
});

const templateApplyForm = ref({
  mode: "bind" as "bind" | "replace",
  policyIds: [] as string[]
});

const goodsCatalogMap = computed(() => new Map(goodsCatalog.value.map((item) => [item.goodsId, item])));
const policyTemplateMap = computed(() => new Map(policyTemplates.value.map((item) => [item.id, item])));
const currentBusinessDateKey = computed(() => detail.value?.businessDaySummary?.businessDateKey ?? new Date().toISOString().slice(0, 10));
const currentMonthTitle = computed(() => {
  const source = detail.value?.policyCalendar?.monthKey || calendarMonth.value;
  if (!source) return "";
  const [year, month] = source.split("-");
  return `${year}年 ${month}月`;
});
const selectedDateSummary = computed(() => detail.value?.policyCalendar?.selectedDateSummary);
const selectedDeviceGoods = computed(() => devices.value.find((entry) => entry.deviceCode === form.value.deviceCode)?.doors.flatMap((door) => door.goods) ?? []);
const selectedGoods = computed(() => selectedDeviceGoods.value.find((entry) => entry.goodsId === form.value.goodsId));
const resolveLogActorRoute = (actor: UserManagementDetail["recentLogs"][number]["actor"]) => resolveActorLink(actor);
const formatRole = (role: UserManagementDetail["user"]["role"]) => role === "special" ? "普通用户" : role === "merchant" ? "爱心商户" : "管理员";
const formatLogStatus = (status: UserManagementDetail["recentLogs"][number]["status"]) => status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";
const formatRecordType = (type: UserManagementDetail["recentRecords"][number]["type"]) =>
  type === "pickup"
    ? "取货"
    : type === "donation"
      ? "补货"
      : type === "manual-restock"
        ? "手工补货"
        : type === "adjustment"
          ? "平台补扣"
          : type === "manual-deduction"
            ? "手工补扣"
            : type === "refund"
              ? "退款"
              : type;
const formatCalendarState = (status?: "complete" | "partial" | "unserved" | "not_applicable") => status === "complete" ? "calendar-day--complete" : status === "partial" ? "calendar-day--partial" : "";
const formatBusinessStatus = (status?: "complete" | "partial" | "unserved" | "not_applicable") => status === "complete" ? "全部领取" : status === "partial" ? "部分领取" : status === "unserved" ? "物资未领取" : "未配置";
const formatWeekdays = (weekdays: number[]) => weekdayOptions.filter((item) => weekdays.includes(item.value)).map((item) => item.label).join("、");
const buildPolicyName = (goodsId: string, startHour: number, endHour: number, weekdays: number[]) => `${goodsCatalogMap.value.get(goodsId)?.name || goodsId} ${formatWeekdays(weekdays)} ${String(startHour).padStart(2, "0")}:00-${String(endHour).padStart(2, "0")}:00`;
const isLocalOnlyRecord = (record: UserManagementDetail["recentRecords"][number]) =>
  record.type === "manual-restock" || record.type === "manual-deduction";
const isPlatformRefundRecord = (record: UserManagementDetail["recentRecords"][number]) =>
  record.type === "refund" || Boolean(record.refundNo);

const directPersonalPolicies = computed(() =>
  (detail.value?.user.accessPolicies ?? [])
    .filter((policy) => policy.status === "active" && (policy.effectiveToDateKey ?? "9999-12-31") >= currentBusinessDateKey.value)
    .sort((left, right) => (right.effectiveFromDateKey ?? "").localeCompare(left.effectiveFromDateKey ?? ""))
);

const personalPolicyRows = computed<PersonalPolicyRow[]>(() =>
  directPersonalPolicies.value.flatMap((policy) =>
    policy.goodsLimits.map((limit) => ({
      policyId: policy.id,
      goodsId: limit.goodsId,
      goodsName: limit.goodsName || goodsCatalogMap.value.get(limit.goodsId)?.name || limit.goodsId,
      quantity: limit.quantity,
      weekdays: [...policy.weekdays],
      startHour: policy.startHour,
      endHour: policy.endHour,
      status: policy.status,
      sourcePolicyId: policy.sourcePolicyId,
      sourceLabel: policy.sourcePolicyId ? policyTemplateMap.value.get(policy.sourcePolicyId)?.name || "模板" : "自定义",
      effectiveLabel: (policy.effectiveFromDateKey ?? currentBusinessDateKey.value) > currentBusinessDateKey.value ? "次日生效" : "当前生效",
      effectiveFromDateKey: policy.effectiveFromDateKey
    }))
  )
);

const groupedPersonalPolicies = computed(() => {
  const groups = new Map<string, { goodsId: string; goodsName: string; rows: PersonalPolicyRow[] }>();
  personalPolicyRows.value.forEach((row) => {
    if (!groups.has(row.goodsId)) groups.set(row.goodsId, { goodsId: row.goodsId, goodsName: row.goodsName, rows: [] });
    groups.get(row.goodsId)?.rows.push(row);
  });
  return Array.from(groups.values()).sort((left, right) => left.goodsName.localeCompare(right.goodsName, "zh-Hans-CN"));
});

const inheritedTemplatePolicies = computed(() => {
  const directIds = new Set((detail.value?.user.accessPolicies ?? []).map((item) => item.id));
  return (detail.value?.accessPolicies ?? []).filter((policy) => !directIds.has(policy.id));
});

const resetAccessPolicyForm = () => {
  editingAccessPolicyId.value = "";
  accessPolicyForm.value = { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 12, status: "active", goodsLimits: [{ goodsId: goodsCatalog.value[0]?.goodsId ?? "", quantity: 1 }] };
};

const fillAccessPolicyForm = (row: PersonalPolicyRow) => {
  editingAccessPolicyId.value = row.policyId;
  accessPolicyForm.value = { weekdays: [...row.weekdays], startHour: row.startHour, endHour: row.endHour, status: row.status, goodsLimits: [{ goodsId: row.goodsId, quantity: row.quantity }] };
};

const ensureCalendarState = () => {
  const currentMonth = detail.value?.policyCalendar?.monthKey ?? new Date().toISOString().slice(0, 7);
  const currentDate = detail.value?.policyCalendar?.selectedDateKey ?? `${currentMonth}-01`;
  if (!calendarMonth.value) calendarMonth.value = currentMonth;
  if (!selectedDateKey.value) selectedDateKey.value = currentDate;
};

const load = async () => {
  loading.value = true;
  try {
    const month = calendarMonth.value || new Date().toISOString().slice(0, 7);
    const date = selectedDateKey.value || `${month}-01`;
    const [detailResponse, devicesResponse, goodsCatalogResponse, templateResponse] = await Promise.all([
      adminApi.userDetail(String(route.params.userId), { month, date }),
      adminApi.devices(),
      adminApi.goodsCatalog(),
      adminApi.policies()
    ]);
    detail.value = detailResponse;
    devices.value = devicesResponse;
    policyTemplates.value = templateResponse;
    goodsCatalog.value = goodsCatalogResponse.map((item) => ({ goodsId: item.goodsId, name: item.name, category: item.category }));
    calendarMonth.value = detailResponse.policyCalendar?.monthKey ?? month;
    selectedDateKey.value = detailResponse.policyCalendar?.selectedDateKey ?? date;
    if (!form.value.deviceCode) form.value.deviceCode = devicesResponse[0]?.deviceCode ?? "";
    if (!form.value.goodsId) form.value.goodsId = devicesResponse[0]?.doors.flatMap((door) => door.goods)[0]?.goodsId ?? "";
    if (!accessPolicyForm.value.goodsLimits[0]?.goodsId && goodsCatalogResponse[0]) accessPolicyForm.value.goodsLimits[0].goodsId = goodsCatalogResponse[0].goodsId;
  } finally {
    loading.value = false;
  }
};

const submitAdjustment = async () => {
  if (!detail.value || !selectedGoods.value) return;
  const actionLabel = form.value.direction === "restock" ? "补货" : "补扣";
  const confirmed = window.confirm(
    form.value.direction === "restock"
      ? `确认给 ${detail.value.user.name} 在 ${form.value.deviceCode} ${actionLabel} ${selectedGoods.value.name} x${form.value.quantity}？提交后会生成新批次。`
      : `确认给 ${detail.value.user.name} ${actionLabel} ${selectedGoods.value.name} x${form.value.quantity}？未指定批次时会默认扣除保质期最短的批次。`
  );

  if (!confirmed) return;

  saving.value = true;
  try {
    await adminApi.manualAdjustUser(detail.value.user.id, {
      deviceCode: form.value.deviceCode,
      goodsId: selectedGoods.value.goodsId,
      goodsName: selectedGoods.value.name,
      category: selectedGoods.value.category,
      quantity: form.value.quantity,
      direction: form.value.direction,
      note: form.value.note,
      confirmed: true
    });
    form.value.quantity = 1;
    form.value.note = "";
    await load();
  } finally {
    saving.value = false;
  }
};

const addPolicyGoodsLimit = () => accessPolicyForm.value.goodsLimits.push({ goodsId: goodsCatalog.value[0]?.goodsId ?? "", quantity: 1 });
const removePolicyGoodsLimit = (index: number) => {
  accessPolicyForm.value.goodsLimits.splice(index, 1);
  if (!accessPolicyForm.value.goodsLimits.length) addPolicyGoodsLimit();
};

const submitAccessPolicy = async () => {
  if (!detail.value || detail.value.user.role !== "special") return;
  const weekdays = Array.from(new Set(accessPolicyForm.value.weekdays)).sort((left, right) => left - right);
  const goodsLimits = accessPolicyForm.value.goodsLimits.filter((item) => item.goodsId && item.quantity > 0).map((item) => ({ goodsId: item.goodsId, quantity: item.quantity }));
  if (!weekdays.length || !goodsLimits.length || accessPolicyForm.value.endHour <= accessPolicyForm.value.startHour) return;
  saving.value = true;
  try {
    if (editingAccessPolicyId.value) {
      const target = goodsLimits[0];
      await adminApi.saveUserAccessPolicy(detail.value.user.id, { id: editingAccessPolicyId.value, name: buildPolicyName(target.goodsId, accessPolicyForm.value.startHour, accessPolicyForm.value.endHour, weekdays), weekdays, startHour: accessPolicyForm.value.startHour, endHour: accessPolicyForm.value.endHour, status: accessPolicyForm.value.status, goodsLimits: [target] });
    } else {
      for (const limit of goodsLimits) {
        await adminApi.saveUserAccessPolicy(detail.value.user.id, { name: buildPolicyName(limit.goodsId, accessPolicyForm.value.startHour, accessPolicyForm.value.endHour, weekdays), weekdays, startHour: accessPolicyForm.value.startHour, endHour: accessPolicyForm.value.endHour, status: accessPolicyForm.value.status, goodsLimits: [limit] });
      }
    }
    resetAccessPolicyForm();
    await load();
  } finally {
    saving.value = false;
  }
};

const deleteAccessPolicy = async (row: PersonalPolicyRow) => {
  if (!detail.value || !window.confirm(`确认删除 ${row.goodsName} 的这条个人取货设定吗？`)) return;
  saving.value = true;
  try {
    await adminApi.deleteUserAccessPolicy(detail.value.user.id, row.policyId);
    if (editingAccessPolicyId.value === row.policyId) resetAccessPolicyForm();
    await load();
  } finally {
    saving.value = false;
  }
};

const applyAccessPolicyNow = async (row: PersonalPolicyRow) => {
  if (!detail.value) return;
  applyingNowPolicyId.value = row.policyId;
  try {
    await adminApi.applyUserAccessPolicyNow(detail.value.user.id, row.policyId);
    await load();
  } finally {
    applyingNowPolicyId.value = "";
  }
};

const toggleTemplatePolicy = (policyId: string) => {
  templateApplyForm.value.policyIds = templateApplyForm.value.policyIds.includes(policyId) ? templateApplyForm.value.policyIds.filter((item) => item !== policyId) : [...templateApplyForm.value.policyIds, policyId];
};

const applyTemplatePolicies = async () => {
  if (!detail.value || detail.value.user.role !== "special" || !templateApplyForm.value.policyIds.length) return;
  if (templateApplyForm.value.mode === "replace" && !window.confirm("覆盖会在下一个业务日替换当前个人取货设定，确认继续吗？")) return;
  saving.value = true;
  try {
    await adminApi.batchAssignPolicies({ userIds: [detail.value.user.id], policyIds: [...templateApplyForm.value.policyIds], mode: templateApplyForm.value.mode });
    templateApplyForm.value.policyIds = [];
    await load();
  } finally {
    saving.value = false;
  }
};

const changeMonth = async (offset: number) => {
  const [year, month] = (calendarMonth.value || new Date().toISOString().slice(0, 7)).split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  calendarMonth.value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  selectedDateKey.value = `${calendarMonth.value}-01`;
  await load();
};

const selectDate = async (dateKey: string) => {
  selectedDateKey.value = dateKey;
  await load();
};

watch(selectedDeviceGoods, (goodsList) => {
  if (!goodsList.some((entry) => entry.goodsId === form.value.goodsId)) form.value.goodsId = goodsList[0]?.goodsId ?? "";
});

watch(() => route.params.userId, async () => {
  calendarMonth.value = "";
  selectedDateKey.value = "";
  templateApplyForm.value.policyIds = [];
  resetAccessPolicyForm();
  await load();
});

onMounted(async () => {
  ensureCalendarState();
  await load();
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div><p class="admin-kicker">人员详情</p><h3 class="admin-page__section-title">{{ detail?.user.name ?? "加载中" }}</h3></div>
      </div>
    </section>

    <section v-if="detail" class="admin-grid admin-grid--main-aside">
      <div class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">基本信息</span><h3 class="admin-panel__title">人员信息与当前状态</h3></div></div>
          <div class="admin-kv">
            <div class="admin-kv__row"><span class="admin-kv__label">姓名</span><span class="admin-kv__value">{{ detail.user.name }}</span></div>
            <div class="admin-kv__row"><span class="admin-kv__label">手机号</span><span class="admin-kv__value"><span class="admin-code">{{ detail.user.phone }}</span><span class="admin-table__subtext">{{ detail.user.ledgerStatus === "unregistered" ? "未注册" : "已注册" }}</span></span></div>
            <div class="admin-kv__row"><span class="admin-kv__label">角色</span><span class="admin-kv__value"><span>{{ formatRole(detail.user.role) }}</span><span class="admin-table__subtext">{{ detail.user.status === "active" ? "账号已启用" : "账号已停用" }}</span></span></div>
            <div class="admin-kv__row"><span class="admin-kv__label">区域</span><span class="admin-kv__value">{{ detail.user.regionName || detail.user.neighborhood || "未设置区域" }}</span></div>
            <div class="admin-kv__row"><span class="admin-kv__label">标签</span><span class="admin-kv__value">{{ detail.user.tags.join("、") || "暂无标签" }}</span></div>
          </div>
        </article>

        <article v-if="detail.user.role === 'special' && detail.stats" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">统计情况</span><h3 class="admin-panel__title">取货、补货与补扣</h3></div></div>
          <div class="admin-grid admin-grid--stats-3">
            <StatTile title="取货件数" :value="detail.stats.pickupCount" hint="该人员累计取货数量" tone="accent" />
            <StatTile title="补货件数" :value="detail.stats.donationCount" hint="该人员累计补货数量" />
            <StatTile title="补扣件数" :value="detail.stats.adjustmentCount" hint="该人员累计人工补扣数量" tone="warning" />
          </div>
          <div class="admin-note">最近活跃时间：{{ formatDateTime(detail.stats.lastActiveAt) }}</div>
        </article>

        <article v-if="detail.user.role === 'special' && detail.policyCalendar" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div><span class="admin-kicker">领取情况日历</span><h3 class="admin-panel__title">按日期查看各时间段领取完成情况</h3></div>
            <div class="admin-toolbar">
              <button class="admin-button admin-button--ghost" @click="changeMonth(-1)">上月</button>
              <span class="admin-code">{{ currentMonthTitle }}</span>
              <button class="admin-button admin-button--ghost" @click="changeMonth(1)">下月</button>
            </div>
          </div>
          <div class="user-calendar">
            <div v-for="weekday in calendarWeekdays" :key="weekday" class="user-calendar__weekday">{{ weekday }}</div>
            <button v-for="day in detail.policyCalendar.days" :key="day.dateKey" class="user-calendar__day" :class="[day.inCurrentMonth ? '' : 'user-calendar__day--muted', day.dateKey === detail.policyCalendar.selectedDateKey ? 'user-calendar__day--selected' : '', formatCalendarState(day.completionStatus)]" @click="selectDate(day.dateKey)">
              <span>{{ day.day }}</span>
              <span v-if="day.hasPickup || day.hasAdjustment" class="user-calendar__markers"><span v-if="day.hasPickup" class="user-calendar__marker"></span><span v-if="day.hasAdjustment" class="user-calendar__adjustment">×</span></span>
            </button>
          </div>
          <div v-if="selectedDateSummary" class="admin-note">已选日期 {{ selectedDateSummary.businessDateKey }}：{{ formatBusinessStatus(selectedDateSummary.completionStatus) }}，已领取 {{ selectedDateSummary.fulfilledGoods }}/{{ selectedDateSummary.totalGoods }}。</div>
          <table v-if="selectedDateSummary" class="admin-table">
            <thead><tr><th>时段</th><th>设定</th><th>领取情况</th></tr></thead>
            <tbody>
              <tr v-for="window in selectedDateSummary.windows" :key="`${window.policyId}-${window.startHour}-${window.dateKey}`">
                <td class="admin-code">{{ String(window.startHour).padStart(2, "0") }}:00-{{ String(window.endHour).padStart(2, "0") }}:00</td>
                <td>{{ window.policyName }}</td>
                <td><div class="user-detail__usage-list"><span v-for="goods in window.goodsUsage" :key="goods.goodsId">{{ goods.goodsName }} {{ goods.usedQuantity }}/{{ goods.quantityLimit }}</span></div></td>
              </tr>
            </tbody>
          </table>
        </article>

        <article v-if="detail.user.role === 'merchant'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">待办任务</span><h3 class="admin-panel__title">该商户关联任务</h3></div></div>
          <table v-if="detail.relatedTasks?.length" class="admin-table">
            <thead><tr><th>到期时间</th><th>任务</th><th>柜机</th></tr></thead>
            <tbody>
              <tr v-for="task in detail.relatedTasks" :key="task.id">
                <td class="admin-code">{{ formatDateTime(task.dueAt) }}</td>
                <td><span class="admin-table__strong">{{ task.title }}</span><span class="admin-table__subtext">{{ task.detail }}</span></td>
                <td><RouterLink v-if="task.deviceCode" class="admin-link" :to="`/operations/${task.deviceCode}`">{{ task.deviceCode }}</RouterLink><span v-else>-</span></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty"><div class="admin-empty__title">当前没有关联任务</div><div class="admin-empty__body">临期、缺货和设备问题会在这里显示。</div></div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">日志记录</span><h3 class="admin-panel__title">该人员相关日志</h3></div></div>
          <table v-if="detail.recentLogs.length" class="admin-table">
            <thead><tr><th>时间</th><th>动作</th><th>动作人</th><th>状态</th><th>详情</th></tr></thead>
            <tbody>
              <tr v-for="log in detail.recentLogs" :key="log.id">
                <td class="admin-code">{{ formatDateTime(log.occurredAt) }}</td>
                <td><span class="admin-table__strong">{{ log.description }}</span><span class="admin-table__subtext">{{ log.detail }}</span></td>
                <td><RouterLink v-if="resolveLogActorRoute(log.actor)" class="admin-link" :to="resolveLogActorRoute(log.actor)!">{{ log.actor.name }}</RouterLink><span v-else>{{ log.actor.name }}</span><span class="admin-table__subtext">{{ log.actor.type }}</span></td>
                <td><span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">{{ formatLogStatus(log.status) }}</span></td>
                <td><RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty"><div class="admin-empty__title">还没有相关日志</div><div class="admin-empty__body">当该人员发生取货、补货、补扣或状态调整时，这里会自动记录。</div></div>
        </article>

        <article v-if="detail.user.role !== 'admin'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">记录明细</span><h3 class="admin-panel__title">{{ detail.user.role === "merchant" ? "最近投放记录" : "最近取货 / 补货记录" }}</h3></div></div>
          <table class="admin-table">
            <thead><tr><th>时间</th><th>货品</th><th>数量</th><th>柜机</th><th>类型</th><th>平台关联</th></tr></thead>
            <tbody>
              <tr v-for="record in detail.recentRecords" :key="record.id">
                <td class="admin-code">{{ formatDateTime(record.happenedAt) }}</td>
                <td><span class="admin-table__strong">{{ record.goodsName }}</span><span class="admin-table__subtext">{{ record.goodsId }}</span></td>
                <td class="admin-code">{{ record.quantity }}</td>
                <td><RouterLink class="admin-link" :to="`/operations/${record.deviceCode}`">{{ record.deviceCode }}</RouterLink></td>
                <td>{{ formatRecordType(record.type) }}</td>
                <td>
                  <span v-if="isLocalOnlyRecord(record)" class="admin-table__strong user-detail__local-only">仅本地，未同步平台</span>
                  <span v-else-if="isPlatformRefundRecord(record)" class="admin-table__strong">已同步平台退款</span>
                  <span v-else-if="record.orderNo || record.sourceOrderNo || record.transactionId" class="admin-table__strong">已关联平台订单</span>
                  <span v-if="record.orderNo" class="admin-table__subtext">订单 {{ record.orderNo }}</span>
                  <span v-if="record.sourceOrderNo" class="admin-table__subtext">原订单 {{ record.sourceOrderNo }}</span>
                  <span v-if="record.transactionId" class="admin-table__subtext">交易号 {{ record.transactionId }}</span>
                  <span v-if="record.refundNo" class="admin-table__subtext">退款单 {{ record.refundNo }}</span>
                  <span v-if="!record.orderNo && !record.sourceOrderNo && !record.transactionId && !record.refundNo" class="admin-table__subtext">{{ isLocalOnlyRecord(record) ? "本地手工记录" : "本地记录" }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </article>
      </div>

      <aside class="admin-grid">
        <article v-if="detail.user.role === 'special'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">个人取货设定</span><h3 class="admin-panel__title">取货量属于个人设定，模板只负责让设定一致或新增</h3></div><button class="admin-button admin-button--ghost" @click="resetAccessPolicyForm">新增设定</button></div>
          <div v-if="groupedPersonalPolicies.length" class="user-policy-groups">
            <section v-for="group in groupedPersonalPolicies" :key="group.goodsId" class="user-policy-group">
              <div class="user-policy-group__head"><div><span class="admin-table__strong">{{ group.goodsName }}</span><span class="admin-table__subtext">{{ group.goodsId }}</span></div><span class="admin-table__subtext">{{ group.rows.length }} 条设定</span></div>
              <div class="user-policy-bars">
                <div v-for="row in group.rows" :key="`${row.policyId}-${row.goodsId}`" class="user-policy-bar">
                  <div class="user-policy-bar__main"><span class="user-policy-bar__quantity"><span class="user-policy-bar__quantity-label">数量</span><span class="user-policy-bar__quantity-value">{{ row.quantity }}</span><span class="user-policy-bar__quantity-unit">件</span></span><span class="user-policy-bar__meta">{{ formatWeekdays(row.weekdays) }} · {{ String(row.startHour).padStart(2, "0") }}:00-{{ String(row.endHour).padStart(2, "0") }}:00</span><span class="admin-table__subtext">来源：{{ row.sourceLabel }} · {{ row.effectiveLabel }}</span></div>
                  <div class="admin-inline-links">
                    <button class="admin-text-button" @click="fillAccessPolicyForm(row)">修改</button>
                    <button
                      v-if="row.effectiveLabel === '次日生效'"
                      class="admin-text-button"
                      :disabled="applyingNowPolicyId === row.policyId"
                      @click="applyAccessPolicyNow(row)"
                    >
                      {{ applyingNowPolicyId === row.policyId ? "处理中" : "立即生效" }}
                    </button>
                    <button class="admin-text-button user-policy-delete" @click="deleteAccessPolicy(row)">删除</button>
                  </div>
                </div>
              </div>
            </section>
          </div>
          <div v-else class="admin-empty"><div class="admin-empty__title">当前还没有个人取货设定</div><div class="admin-empty__body">{{ inheritedTemplatePolicies.length ? "当前仍沿用模板口径，请先在下方执行新增或覆盖，生成个人设定后再单独维护。" : "可直接新增个人设定，或先从模板生成后再逐项修改。" }}</div></div>
          <div v-if="inheritedTemplatePolicies.length" class="admin-note">当前还存在按模板推导的有效设定：{{ inheritedTemplatePolicies.map((policy) => policy.name).join("、") }}。执行下方模板新增或覆盖后，会转成可单独维护的个人设定。</div>
          <div class="user-detail-form">
            <div class="admin-field"><span class="admin-field__label">生效星期</span><div class="user-policy-weekdays"><label v-for="weekday in weekdayOptions" :key="weekday.value" class="user-policy-weekdays__item"><input v-model="accessPolicyForm.weekdays" type="checkbox" :value="weekday.value" /><span>{{ weekday.label }}</span></label></div></div>
            <div class="user-policy-hours">
              <label class="admin-field"><span class="admin-field__label">开始时间</span><select v-model="accessPolicyForm.startHour" class="admin-select"><option v-for="hour in hourOptions" :key="hour" :value="hour">{{ String(hour).padStart(2, "0") }}:00</option></select></label>
              <label class="admin-field"><span class="admin-field__label">结束时间</span><select v-model="accessPolicyForm.endHour" class="admin-select"><option v-for="hour in hourEndOptions" :key="hour" :value="hour">{{ String(hour).padStart(2, "0") }}:00</option></select></label>
            </div>
            <label class="admin-field"><span class="admin-field__label">状态</span><select v-model="accessPolicyForm.status" class="admin-select"><option value="active">启用</option><option value="inactive">停用</option></select></label>
            <div class="admin-field">
              <span class="admin-field__label">货品、时间段与数量</span>
              <div class="user-policy-limits">
                <div v-for="(limit, index) in accessPolicyForm.goodsLimits" :key="`${index}-${limit.goodsId}`" class="user-policy-limits__row">
                  <select v-model="limit.goodsId" class="admin-select"><option v-for="goods in goodsCatalog" :key="goods.goodsId" :value="goods.goodsId">{{ goods.name }} / {{ goods.goodsId }}</option></select>
                  <input v-model.number="limit.quantity" class="admin-input" type="number" min="1" />
                  <button class="admin-button admin-button--ghost" @click="removePolicyGoodsLimit(index)">删除</button>
                </div>
              </div>
              <button v-if="!editingAccessPolicyId" class="admin-text-button" @click="addPolicyGoodsLimit">继续添加商品</button>
            </div>
            <button class="admin-button" :disabled="saving || accessPolicyForm.endHour <= accessPolicyForm.startHour" @click="submitAccessPolicy">{{ saving ? "保存中" : editingAccessPolicyId ? "保存个人设定" : "新增个人设定" }}</button>
          </div>
        </article>

        <article v-if="detail.user.role === 'special'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">模板操作</span><h3 class="admin-panel__title">模板只是批量下发这些最小单元，不替代个人设定</h3></div></div>
          <div class="user-detail-form">
            <label class="admin-field"><span class="admin-field__label">应用方式</span><select v-model="templateApplyForm.mode" class="admin-select"><option value="bind">新增到个人设定</option><option value="replace">覆盖个人设定</option></select></label>
            <div class="admin-field"><span class="admin-field__label">模板选择</span><div class="user-template-checklist"><label v-for="policy in policyTemplates" :key="policy.id" class="user-template-check"><input :checked="templateApplyForm.policyIds.includes(policy.id)" type="checkbox" @change="toggleTemplatePolicy(policy.id)" /><span>{{ policy.name }}</span><span class="admin-table__subtext">{{ formatWeekdays(policy.weekdays) }} · {{ String(policy.startHour).padStart(2, "0") }}:00-{{ String(policy.endHour).padStart(2, "0") }}:00 · {{ policy.goodsLimits.map((limit) => `${limit.goodsName} x${limit.quantity}`).join("，") }}</span></label></div></div>
            <div class="admin-note">{{ templateApplyForm.mode === "replace" ? "覆盖会在二次确认后，于下一个业务日替换当前个人设定。" : "新增会把模板中的每个货品最小单元追加到该人员的个人设定中。" }}</div>
            <button class="admin-button" :disabled="saving || !templateApplyForm.policyIds.length" @click="applyTemplatePolicies">{{ saving ? "处理中" : templateApplyForm.mode === "replace" ? "覆盖个人设定" : "新增到个人设定" }}</button>
          </div>
        </article>

        <article v-if="detail.user.role === 'special'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">手工补扣</span><h3 class="admin-panel__title">从货物库中选择商品</h3></div></div>
          <div class="user-detail-form">
            <label class="admin-field"><span class="admin-field__label">柜机</span><select v-model="form.deviceCode" class="admin-select"><option v-for="device in devices" :key="device.deviceCode" :value="device.deviceCode">{{ device.name }} / {{ device.deviceCode }}</option></select></label>
            <label class="admin-field"><span class="admin-field__label">货品</span><select v-model="form.goodsId" class="admin-select"><option v-for="goods in selectedDeviceGoods" :key="goods.goodsId" :value="goods.goodsId">{{ goods.name }} / {{ goods.goodsId }}</option></select></label>
            <label class="admin-field"><span class="admin-field__label">数量</span><input v-model.number="form.quantity" class="admin-input" type="number" min="1" /></label>
            <label class="admin-field"><span class="admin-field__label">方向</span><select v-model="form.direction" class="admin-select"><option value="deduct">补扣</option><option value="restock">补货</option></select></label>
            <label class="admin-field"><span class="admin-field__label">备注</span><input v-model="form.note" class="admin-input" placeholder="例如用户领取异常后人工补扣" /></label>
            <div class="admin-note">当前手工补货 / 手工补扣只修正本地库存与人员记录，不会在平台创建补货或补扣订单。</div>
            <button class="admin-button" :disabled="saving || !selectedGoods" @click="submitAdjustment">{{ saving ? "提交中" : form.direction === "restock" ? "提交手工补货" : "提交手工补扣" }}</button>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">关联事件</span><h3 class="admin-panel__title">最近开柜事件</h3></div></div>
          <div v-if="detail.recentEvents.length" class="admin-list">
            <div v-for="event in detail.recentEvents" :key="event.eventId" class="admin-list__row">
              <div class="admin-list__main"><span class="admin-list__title">{{ event.orderNo }}</span><span class="admin-list__meta">{{ formatDateTime(event.updatedAt) }} · {{ event.deviceCode }} · {{ event.status }}</span></div>
              <RouterLink class="admin-link" :to="`/logs?subjectType=event&subjectId=${event.eventId}`">查看日志</RouterLink>
            </div>
          </div>
          <div v-else class="admin-empty"><div class="admin-empty__title">{{ loading ? "正在加载事件记录" : "还没有开柜事件" }}</div><div class="admin-empty__body">后续产生的开柜链路会同步显示在这里。</div></div>
        </article>
      </aside>
    </section>
  </section>
</template>

<style scoped>
.user-detail-form,.user-policy-weekdays,.user-policy-limits,.user-policy-groups,.user-policy-bars,.user-template-checklist{display:grid;gap:10px}
.user-policy-group{display:grid;gap:10px;padding:12px;border:1px solid var(--admin-line);border-radius:10px;background:var(--admin-panel-muted)}
.user-policy-group__head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.user-policy-bar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--admin-line);border-radius:8px;background:var(--admin-panel)}
.user-policy-bar__main{display:grid;gap:4px}
.user-policy-bar__quantity{display:flex;align-items:baseline;gap:6px}
.user-policy-bar__quantity-label,.user-policy-bar__quantity-unit{color:var(--admin-text)}
.user-policy-bar__quantity-value{color:var(--admin-accent-strong);font-weight:700;font-size:1.05rem}
.user-template-check{display:grid;gap:4px;padding:10px 12px;border:1px solid var(--admin-line);border-radius:8px;background:var(--admin-panel-muted)}
.user-policy-weekdays{grid-template-columns:repeat(4,minmax(0,1fr))}
.user-policy-weekdays__item{display:flex;align-items:center;gap:8px}
.user-policy-hours{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.user-policy-limits__row{display:grid;grid-template-columns:minmax(0,1fr) 100px 84px;gap:8px}
.user-calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.user-calendar__weekday{padding:6px 4px;text-align:center;color:var(--admin-muted);font-size:.78rem;font-weight:700}
.user-calendar__day{min-height:68px;display:grid;justify-items:center;align-content:center;gap:8px;border:1px solid var(--admin-line);border-radius:10px;background:var(--admin-panel);cursor:pointer}
.user-calendar__day--muted{color:#98a4b3;background:var(--admin-panel-muted)}
.user-calendar__day--selected{border-color:var(--admin-accent);background:var(--admin-accent-soft)}
.user-calendar__marker{width:12px;height:12px;border-radius:999px;border:2px solid var(--admin-accent)}
.user-calendar__markers{display:flex;align-items:center;gap:6px}
.user-calendar__adjustment{color:var(--admin-danger);font-size:.9rem;font-weight:700;line-height:1}
.calendar-day--complete .user-calendar__marker{background:var(--admin-accent)}
.user-detail__usage-list{display:grid;gap:4px}
.admin-text-button{border:0;padding:0;background:transparent;color:var(--admin-accent);font:inherit;cursor:pointer}
.user-policy-delete{color:var(--admin-danger)}
.user-detail__local-only{color:var(--admin-warning-strong)}
@media (max-width:720px){.user-policy-hours,.user-policy-limits__row,.user-policy-weekdays,.user-policy-bar{grid-template-columns:1fr}.user-policy-group__head{flex-direction:column;align-items:flex-start}}
</style>
