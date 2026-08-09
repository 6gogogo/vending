<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type {
  CabinetReservationRecord,
  DeviceRecord,
  ManualSettlementCandidate,
  ManualSettlementRecord,
  SpecialAccessPolicy,
  UserAccessPolicy,
  UserManagementDetail
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { canRecoverManualSettlement, useAdminSessionStore } from "../stores/session";
import { resolveActorLink } from "../utils/entity-links";
import { formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";

const route = useRoute();
const sessionStore = useAdminSessionStore();
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
const actionMessage = ref<{ type: "success" | "error"; text: string }>();
const reservations = ref<CabinetReservationRecord[]>([]);
const reservationCancelReasons = ref<Record<string, string>>({});
const manualSettlementCandidates = ref<ManualSettlementCandidate[]>([]);
const selectedManualSettlementEventId = ref("");
const manualSettlementRecord = ref<ManualSettlementRecord>();
const manualSettlementForm = ref({
  items: [{ goodsId: "", quantity: 1 }],
  reason: "",
  platformOrderNo: "",
  confirmed: false
});
const manualSettlementFollowUp = ref({
  platformOrderNo: "",
  reason: "",
  resolution: "keep_manual" as "keep_manual" | "use_platform"
});

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
const canRecoverSettlement = computed(
  () => canRecoverManualSettlement(
    sessionStore.user?.backofficeRole,
    sessionStore.permissions
  )
);
const selectedManualSettlementCandidate = computed(() =>
  manualSettlementCandidates.value.find(
    (entry) => entry.eventId === selectedManualSettlementEventId.value
  )
);
const selectedManualSettlementGoods = computed(() => {
  const deviceCode = selectedManualSettlementCandidate.value?.device.deviceCode;
  return devices.value
    .find((entry) => entry.deviceCode === deviceCode)
    ?.doors.flatMap((door) => door.goods) ?? [];
});
const routeManualSettlementEventId = computed(() => {
  const value = route.query.manualSettlementEventId;
  return typeof value === "string" ? value : "";
});
const visibleManualSettlementRecord = computed(() => {
  if (manualSettlementRecord.value) return manualSettlementRecord.value;
  const requestedEventId = routeManualSettlementEventId.value;
  return detail.value?.recentEvents.find(
    (event) =>
      Boolean(event.manualSettlement) &&
      (!requestedEventId || event.eventId === requestedEventId)
  )?.manualSettlement;
});
const manualSettlementRecentEvents = computed(() =>
  (detail.value?.recentEvents ?? []).filter((event) => Boolean(event.manualSettlement))
);
const resolveLogActorRoute = (actor: UserManagementDetail["recentLogs"][number]["actor"]) => resolveActorLink(actor);
const formatRole = (role: UserManagementDetail["user"]["role"]) => role === "special" ? "用户" : role === "merchant" ? "商家" : "管理员";
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
const canManageUserRules = computed(() => sessionStore.can("users:rules:manage"));
const canAdjustStock = computed(() => sessionStore.can("goods:stock-adjust"));
const canCancelReservations = computed(
  () => sessionStore.can("reservations:manage")
);
const showActionMessage = (type: "success" | "error", text: string) => {
  actionMessage.value = { type, text };
};

const formatManualSettlementStatus = (status: ManualSettlementRecord["status"]) =>
  status === "awaiting_order"
    ? "待补订单号"
    : status === "awaiting_platform_completion"
      ? "待平台回写"
      : status === "platform_completed"
        ? "平台已完成"
        : status === "callback_reconciled"
          ? "回调已核对"
          : status === "conflict"
            ? "明细冲突"
            : "已撤销";

const formatReservationStatus = (status: CabinetReservationRecord["status"]) =>
  status === "active"
    ? "有效"
    : status === "fulfilled"
      ? "已领取"
      : status === "cancelled"
        ? "已取消"
        : "已过期";

const resetManualSettlementForm = (candidate?: ManualSettlementCandidate) => {
  const firstGoods = devices.value
    .find((entry) => entry.deviceCode === candidate?.device.deviceCode)
    ?.doors.flatMap((door) => door.goods)[0];
  manualSettlementForm.value = {
    items: [{ goodsId: firstGoods?.goodsId ?? "", quantity: 1 }],
    reason: "",
    platformOrderNo: candidate?.platformOrderNo ?? "",
    confirmed: false
  };
  manualSettlementFollowUp.value = {
    platformOrderNo: "",
    reason: "",
    resolution: "keep_manual"
  };
};

const selectManualSettlementCandidate = (eventId: string) => {
  selectedManualSettlementEventId.value = eventId;
  manualSettlementRecord.value = undefined;
  resetManualSettlementForm(
    manualSettlementCandidates.value.find((entry) => entry.eventId === eventId)
  );
};

const addManualSettlementItem = () => {
  manualSettlementForm.value.items.push({
    goodsId: selectedManualSettlementGoods.value.find(
      (goods) => !manualSettlementForm.value.items.some((item) => item.goodsId === goods.goodsId)
    )?.goodsId ?? "",
    quantity: 1
  });
};

const removeManualSettlementItem = (index: number) => {
  manualSettlementForm.value.items.splice(index, 1);
  if (!manualSettlementForm.value.items.length) addManualSettlementItem();
};

const loadManualSettlementCandidates = async (userId: string) => {
  if (!canRecoverSettlement.value) {
    manualSettlementCandidates.value = [];
    return;
  }
  try {
    manualSettlementCandidates.value = await adminApi.manualSettlementCandidates(userId);
    const requestedEventId = routeManualSettlementEventId.value;
    const nextEventId = manualSettlementCandidates.value.some(
      (entry) => entry.eventId === requestedEventId
    )
      ? requestedEventId
      : manualSettlementCandidates.value.some(
            (entry) => entry.eventId === selectedManualSettlementEventId.value
          )
        ? selectedManualSettlementEventId.value
        : manualSettlementCandidates.value[0]?.eventId ?? "";
    if (nextEventId) {
      if (
        nextEventId !== selectedManualSettlementEventId.value ||
        manualSettlementRecord.value
      ) {
        selectManualSettlementCandidate(nextEventId);
      }
    }
    if (!nextEventId) selectedManualSettlementEventId.value = "";
  } catch (error) {
    manualSettlementCandidates.value = [];
    showActionMessage(
      "error",
      `缺失结算候选加载失败：${readErrorMessage(error, "请稍后重试")}`
    );
  }
};

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
    const [detailResponse, devicesResponse, goodsCatalogResponse, templateResponse, reservationsResponse] = await Promise.all([
      adminApi.userDetail(String(route.params.userId), { month, date }),
      adminApi.devices(),
      adminApi.goodsCatalog(),
      adminApi.policies(),
      adminApi.reservations(String(route.params.userId))
    ]);
    detail.value = detailResponse;
    devices.value = devicesResponse;
    policyTemplates.value = templateResponse;
    reservations.value = reservationsResponse;
    goodsCatalog.value = goodsCatalogResponse.map((item) => ({ goodsId: item.goodsId, name: item.name, category: item.category }));
    calendarMonth.value = detailResponse.policyCalendar?.monthKey ?? month;
    selectedDateKey.value = detailResponse.policyCalendar?.selectedDateKey ?? date;
    if (!form.value.deviceCode) form.value.deviceCode = devicesResponse[0]?.deviceCode ?? "";
    if (!form.value.goodsId) form.value.goodsId = devicesResponse[0]?.doors.flatMap((door) => door.goods)[0]?.goodsId ?? "";
    if (!accessPolicyForm.value.goodsLimits[0]?.goodsId && goodsCatalogResponse[0]) accessPolicyForm.value.goodsLimits[0].goodsId = goodsCatalogResponse[0].goodsId;
    if (detailResponse.user.role === "special") {
      await loadManualSettlementCandidates(detailResponse.user.id);
      const requestedEvent = detailResponse.recentEvents.find(
        (event) =>
          event.eventId === routeManualSettlementEventId.value &&
          !manualSettlementCandidates.value.some(
            (candidate) => candidate.eventId === event.eventId
          ) &&
          Boolean(event.manualSettlement)
      );
      if (requestedEvent?.manualSettlement) {
        manualSettlementRecord.value = requestedEvent.manualSettlement;
        selectedManualSettlementEventId.value = requestedEvent.eventId;
      }
    } else {
      manualSettlementCandidates.value = [];
      selectedManualSettlementEventId.value = "";
      manualSettlementRecord.value = undefined;
    }
  } finally {
    loading.value = false;
  }
};

const submitAdjustment = async () => {
  if (!detail.value || !selectedGoods.value) return;
  if (!canAdjustStock.value) {
    showActionMessage("error", "当前账号没有货品库存调整权限，不能提交手工补货或补扣。");
    return;
  }

  const actionLabel = form.value.direction === "restock" ? "补货" : "补扣";
  const confirmed = window.confirm(
    form.value.direction === "restock"
      ? `确认给 ${detail.value.user.name} 在 ${form.value.deviceCode} ${actionLabel} ${selectedGoods.value.name} x${form.value.quantity}？提交后会生成新批次。`
      : `确认给 ${detail.value.user.name} ${actionLabel} ${selectedGoods.value.name} x${form.value.quantity}？未指定批次时会默认扣除保质期最短的批次。`
  );

  if (!confirmed) return;

  saving.value = true;
  try {
    const goodsName = selectedGoods.value.name;
    const quantity = form.value.quantity;
    const direction = form.value.direction;
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
    showActionMessage(
      "success",
      direction === "restock"
        ? `已为 ${detail.value.user.name} 手工补货 ${goodsName} x${quantity}，本地库存和人员记录已更新。`
        : `已为 ${detail.value.user.name} 手工补扣 ${goodsName} x${quantity}，本地库存和人员记录已更新。`
    );
  } catch (error) {
    showActionMessage("error", `手工调整失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};

const cancelReservation = async (reservation: CabinetReservationRecord) => {
  if (!detail.value || !canCancelReservations.value || reservation.status !== "active") {
    return;
  }
  const reason = reservationCancelReasons.value[reservation.id]?.trim() ?? "";
  if (reason.length < 2 || reason.length > 200) {
    showActionMessage("error", "取消预约前，请填写 2 至 200 字的处理原因。");
    return;
  }
  if (
    !window.confirm(
      `确认取消 ${detail.value.user.name} 的预约？取消后将释放本次预约占用的可领取数量。`
    )
  ) {
    return;
  }
  saving.value = true;
  try {
    await adminApi.cancelReservation(reservation.id, reason);
    delete reservationCancelReasons.value[reservation.id];
    await load();
    showActionMessage("success", "预约已取消，相关可领取数量已释放并记录到操作日志。");
  } catch (error) {
    showActionMessage(
      "error",
      `取消预约失败：${readErrorMessage(error, "请刷新后确认预约仍处于有效状态")}`
    );
  } finally {
    saving.value = false;
  }
};

const submitManualSettlement = async () => {
  const candidate = selectedManualSettlementCandidate.value;
  if (!detail.value || !candidate || !canRecoverSettlement.value) return;
  const items = manualSettlementForm.value.items
    .filter((item) => item.goodsId && Number.isSafeInteger(item.quantity) && item.quantity > 0)
    .map((item) => ({ goodsId: item.goodsId, quantity: item.quantity }));
  const reason = manualSettlementForm.value.reason.trim();
  if (!items.length || items.length !== manualSettlementForm.value.items.length) {
    showActionMessage("error", "请完整填写实际取走商品和正整数数量。");
    return;
  }
  if (new Set(items.map((item) => item.goodsId)).size !== items.length) {
    showActionMessage("error", "同一商品只能填写一次，请合并数量。");
    return;
  }
  if (!reason || !manualSettlementForm.value.confirmed) {
    showActionMessage("error", "请填写处理依据，并确认明细来自实际盘点。");
    return;
  }
  const summary = items
    .map((item) => {
      const goods = selectedManualSettlementGoods.value.find(
        (entry) => entry.goodsId === item.goodsId
      );
      return `${goods?.name ?? item.goodsId} x${item.quantity}`;
    })
    .join("，");
  if (
    !window.confirm(
      `确认按实际盘点为事件 ${candidate.eventId} 补记：${summary}？提交后会立即扣减库存与该用户当日额度。`
    )
  ) {
    return;
  }

  saving.value = true;
  try {
    const eventId = candidate.eventId;
    const result = await adminApi.createManualSettlement(eventId, {
      items,
      reason,
      confirmed: true,
      platformOrderNo:
        candidate.orderState === "awaiting_order"
          ? manualSettlementForm.value.platformOrderNo.trim() || undefined
          : undefined
    });
    await load();
    selectedManualSettlementEventId.value = eventId;
    manualSettlementRecord.value = result;
    showActionMessage(
      "success",
      `人工结算补记已完成；当前状态：${formatManualSettlementStatus(result.status)}。`
    );
  } catch (error) {
    showActionMessage(
      "error",
      `人工结算补记失败：${readErrorMessage(error, "请核对库存与事件状态")}`
    );
  } finally {
    saving.value = false;
  }
};

const linkManualSettlementOrder = async () => {
  const record = visibleManualSettlementRecord.value;
  const orderNo = manualSettlementFollowUp.value.platformOrderNo.trim();
  if (!record || !orderNo) {
    showActionMessage("error", "请填写平台订单号。");
    return;
  }
  saving.value = true;
  try {
    manualSettlementRecord.value = await adminApi.linkManualSettlementOrder(record.eventId, {
      platformOrderNo: orderNo
    });
    manualSettlementFollowUp.value.platformOrderNo = "";
    await load();
    showActionMessage("success", "平台订单号已关联，可继续执行平台完成回写。");
  } catch (error) {
    showActionMessage(
      "error",
      `关联平台订单号失败：${readErrorMessage(error, "请核对订单号")}`
    );
  } finally {
    saving.value = false;
  }
};

const completeManualSettlementPlatform = async () => {
  const record = visibleManualSettlementRecord.value;
  if (!record || !window.confirm(`确认向平台完成订单 ${record.platformOrderNo} 的零元回写吗？`)) {
    return;
  }
  saving.value = true;
  try {
    const result = await adminApi.completeManualSettlementPlatform(record.eventId);
    manualSettlementRecord.value = result.manualSettlement;
    await load();
    showActionMessage("success", "平台完成回写成功；重复点击会复用同一交易号。");
  } catch (error) {
    showActionMessage(
      "error",
      `平台完成回写失败：${readErrorMessage(error, "可稍后重试，不会重复扣减本地库存")}`
    );
  } finally {
    saving.value = false;
  }
};

const revertManualSettlement = async () => {
  const record = visibleManualSettlementRecord.value;
  const reason = manualSettlementFollowUp.value.reason.trim();
  if (!record || !reason) {
    showActionMessage("error", "请填写撤销原因。");
    return;
  }
  if (!window.confirm("确认整单撤销？系统将按原批次恢复库存和用户额度。")) return;
  saving.value = true;
  try {
    manualSettlementRecord.value = await adminApi.revertManualSettlement(record.eventId, {
      reason
    });
    manualSettlementFollowUp.value.reason = "";
    await load();
    showActionMessage("success", "人工结算补记已撤销，原批次库存和用户额度已恢复。");
  } catch (error) {
    showActionMessage(
      "error",
      `撤销失败：${readErrorMessage(error, "请核对是否已经完成平台回写")}`
    );
  } finally {
    saving.value = false;
  }
};

const resolveManualSettlementConflict = async () => {
  const record = visibleManualSettlementRecord.value;
  const reason = manualSettlementFollowUp.value.reason.trim();
  if (!record || !reason) {
    showActionMessage("error", "请填写明细冲突的核对依据。");
    return;
  }
  if (
    !window.confirm(
      manualSettlementFollowUp.value.resolution === "use_platform"
        ? "确认按平台迟到回调修正？系统会反向恢复人工明细，再按平台明细扣减。"
        : "确认保留人工盘点结果？平台迟到明细只作为审计证据保留。"
    )
  ) {
    return;
  }
  saving.value = true;
  try {
    manualSettlementRecord.value = await adminApi.resolveManualSettlementConflict(
      record.eventId,
      {
        resolution: manualSettlementFollowUp.value.resolution,
        reason
      }
    );
    manualSettlementFollowUp.value.reason = "";
    await load();
    showActionMessage("success", "人工结算补记与迟到回调的明细冲突已核对。");
  } catch (error) {
    showActionMessage(
      "error",
      `明细冲突核对失败：${readErrorMessage(error, "请稍后重试")}`
    );
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
  if (!canManageUserRules.value) {
    showActionMessage("error", "当前账号没有取货规则管理权限，不能保存每日可领取物资。");
    return;
  }

  const weekdays = Array.from(new Set(accessPolicyForm.value.weekdays)).sort((left, right) => left - right);
  const goodsLimits = accessPolicyForm.value.goodsLimits.filter((item) => item.goodsId && item.quantity > 0).map((item) => ({ goodsId: item.goodsId, quantity: item.quantity }));
  if (!weekdays.length || !goodsLimits.length || accessPolicyForm.value.endHour <= accessPolicyForm.value.startHour) {
    showActionMessage("error", "保存规则前请至少选择一个星期、一个物资，并保证结束时间晚于开始时间。");
    return;
  }
  saving.value = true;
  try {
    const wasEditing = Boolean(editingAccessPolicyId.value);
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
    showActionMessage(
      "success",
      wasEditing
        ? `已保存 ${detail.value.user.name} 的每日可领取物资设定。`
        : `已为 ${detail.value.user.name} 新增 ${goodsLimits.length} 条每日可领取物资设定。`
    );
  } catch (error) {
    showActionMessage("error", `保存每日可领取物资失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};

const deleteAccessPolicy = async (row: PersonalPolicyRow) => {
  if (!detail.value || !window.confirm(`确认删除 ${row.goodsName} 的这条每日可领取物资设定吗？`)) return;
  if (!canManageUserRules.value) {
    showActionMessage("error", "当前账号没有取货规则管理权限，不能删除每日可领取物资。");
    return;
  }

  saving.value = true;
  try {
    await adminApi.deleteUserAccessPolicy(detail.value.user.id, row.policyId);
    if (editingAccessPolicyId.value === row.policyId) resetAccessPolicyForm();
    await load();
    showActionMessage("success", `已删除 ${row.goodsName} 的每日可领取物资设定。`);
  } catch (error) {
    showActionMessage("error", `删除每日可领取物资失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};

const applyAccessPolicyNow = async (row: PersonalPolicyRow) => {
  if (!detail.value) return;
  if (!canManageUserRules.value) {
    showActionMessage("error", "当前账号没有取货规则管理权限，不能立即生效。");
    return;
  }

  applyingNowPolicyId.value = row.policyId;
  try {
    await adminApi.applyUserAccessPolicyNow(detail.value.user.id, row.policyId);
    await load();
    showActionMessage("success", `${row.goodsName} 的设定已调整为当前业务日生效。`);
  } catch (error) {
    showActionMessage("error", `立即生效失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    applyingNowPolicyId.value = "";
  }
};

const toggleTemplatePolicy = (policyId: string) => {
  templateApplyForm.value.policyIds = templateApplyForm.value.policyIds.includes(policyId) ? templateApplyForm.value.policyIds.filter((item) => item !== policyId) : [...templateApplyForm.value.policyIds, policyId];
};

const applyTemplatePolicies = async () => {
  if (!detail.value || detail.value.user.role !== "special" || !templateApplyForm.value.policyIds.length) return;
  if (!canManageUserRules.value) {
    showActionMessage("error", "当前账号没有取货规则管理权限，不能套用模板。");
    return;
  }

  if (templateApplyForm.value.mode === "replace" && !window.confirm("覆盖会在下一个业务日替换当前每日可领取物资设定，确认继续吗？")) return;
  saving.value = true;
  try {
    const mode = templateApplyForm.value.mode;
    const count = templateApplyForm.value.policyIds.length;
    await adminApi.batchAssignPolicies({ userIds: [detail.value.user.id], policyIds: [...templateApplyForm.value.policyIds], mode: templateApplyForm.value.mode });
    templateApplyForm.value.policyIds = [];
    await load();
    showActionMessage("success", `已${mode === "replace" ? "覆盖" : "新增"} ${count} 个规则模板到 ${detail.value.user.name}。`);
  } catch (error) {
    showActionMessage("error", `套用模板失败：${readErrorMessage(error, "请稍后重试")}`);
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
  manualSettlementCandidates.value = [];
  selectedManualSettlementEventId.value = "";
  manualSettlementRecord.value = undefined;
  reservations.value = [];
  reservationCancelReasons.value = {};
  resetManualSettlementForm();
  resetAccessPolicyForm();
  await load();
});

watch(routeManualSettlementEventId, (eventId) => {
  const candidate = manualSettlementCandidates.value.find((entry) => entry.eventId === eventId);
  if (candidate) {
    selectManualSettlementCandidate(candidate.eventId);
    return;
  }
  const existing = detail.value?.recentEvents.find(
    (event) => event.eventId === eventId && Boolean(event.manualSettlement)
  );
  if (existing?.manualSettlement) {
    selectedManualSettlementEventId.value = existing.eventId;
    manualSettlementRecord.value = existing.manualSettlement;
  }
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
      <div v-if="actionMessage" class="admin-alert" :class="{ 'admin-alert--danger': actionMessage.type === 'error' }">
        {{ actionMessage.text }}
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
          <div class="admin-panel__head"><div><span class="admin-kicker">待办任务</span><h3 class="admin-panel__title">该商家关联任务</h3></div></div>
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
          <div class="admin-panel__head">
            <div><span class="admin-kicker">预约管理</span><h3 class="admin-panel__title">查看并取消当前预约</h3></div>
          </div>
          <div v-if="reservations.length" class="admin-list">
            <div v-for="reservation in reservations" :key="reservation.id" class="admin-list__row user-reservation-row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ reservation.items.map((item) => `${item.goodsName} x${item.quantity}`).join('，') || '未记录具体物资' }}</span>
                <span class="admin-list__meta">{{ formatReservationStatus(reservation.status) }} · 柜机 {{ reservation.deviceCode }} · 保留至 {{ formatDateTime(reservation.expiresAt) }}</span>
                <span class="admin-list__meta admin-code">{{ reservation.id }}</span>
                <span v-if="reservation.cancellationReason" class="admin-list__meta">取消原因：{{ reservation.cancellationReason }}</span>
              </div>
              <div v-if="reservation.status === 'active' && canCancelReservations" class="user-reservation-actions">
                <input
                  v-model="reservationCancelReasons[reservation.id]"
                  class="admin-input"
                  maxlength="200"
                  placeholder="填写取消原因"
                />
                <button
                  class="admin-button admin-button--ghost"
                  type="button"
                  :disabled="saving || (reservationCancelReasons[reservation.id]?.trim().length ?? 0) < 2"
                  @click="cancelReservation(reservation)"
                >
                  取消此预约
                </button>
              </div>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有预约记录</div>
            <div class="admin-empty__body">该人员后续创建的预约会显示在这里。</div>
          </div>
          <div v-if="reservations.some((entry) => entry.status === 'active') && !canCancelReservations" class="admin-note">当前账号可以查看预约，但取消操作需要“预约规则管理”权限。</div>
        </article>

        <article v-if="detail.user.role === 'special'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">每日可领取物资</span><h3 class="admin-panel__title">按人维护可领取物资、数量和时间</h3></div><button v-if="canManageUserRules" class="admin-button admin-button--ghost" @click="resetAccessPolicyForm">新增可领物资</button></div>
          <div v-if="groupedPersonalPolicies.length" class="user-policy-groups">
            <section v-for="group in groupedPersonalPolicies" :key="group.goodsId" class="user-policy-group">
              <div class="user-policy-group__head"><div><span class="admin-table__strong">{{ group.goodsName }}</span><span class="admin-table__subtext">{{ group.goodsId }}</span></div><span class="admin-table__subtext">{{ group.rows.length }} 条设定</span></div>
              <div class="user-policy-bars">
                <div v-for="row in group.rows" :key="`${row.policyId}-${row.goodsId}`" class="user-policy-bar">
                  <div class="user-policy-bar__main"><span class="user-policy-bar__quantity"><span class="user-policy-bar__quantity-label">数量</span><span class="user-policy-bar__quantity-value">{{ row.quantity }}</span><span class="user-policy-bar__quantity-unit">件</span></span><span class="user-policy-bar__meta">{{ formatWeekdays(row.weekdays) }} · {{ String(row.startHour).padStart(2, "0") }}:00-{{ String(row.endHour).padStart(2, "0") }}:00</span><span class="admin-table__subtext">来源：{{ row.sourceLabel }} · {{ row.effectiveLabel }}</span></div>
                  <div class="admin-inline-links">
                    <button v-if="canManageUserRules" class="admin-text-button" @click="fillAccessPolicyForm(row)">修改</button>
                    <button
                      v-if="canManageUserRules && row.effectiveLabel === '次日生效'"
                      class="admin-text-button"
                      :disabled="applyingNowPolicyId === row.policyId"
                      @click="applyAccessPolicyNow(row)"
                    >
                      {{ applyingNowPolicyId === row.policyId ? "处理中" : "立即生效" }}
                    </button>
                    <button v-if="canManageUserRules" class="admin-text-button user-policy-delete" @click="deleteAccessPolicy(row)">删除</button>
                  </div>
                </div>
              </div>
            </section>
          </div>
          <div v-else class="admin-empty"><div class="admin-empty__title">当前还没有每日可领取物资</div><div class="admin-empty__body">{{ inheritedTemplatePolicies.length ? "当前仍沿用模板口径，请先在下方执行新增或覆盖，生成个人设定后再单独维护。" : "可直接新增每日可领取物资，或先从模板生成后再逐项修改。" }}</div></div>
          <div v-if="inheritedTemplatePolicies.length" class="admin-note">当前还存在按模板推导的有效设定：{{ inheritedTemplatePolicies.map((policy) => policy.name).join("、") }}。执行下方模板新增或覆盖后，会转成可单独维护的每日物资设定。</div>
          <div v-if="canManageUserRules" class="user-detail-form">
            <div class="admin-field"><span class="admin-field__label">生效星期</span><div class="user-policy-weekdays"><label v-for="weekday in weekdayOptions" :key="weekday.value" class="user-policy-weekdays__item"><input v-model="accessPolicyForm.weekdays" type="checkbox" :value="weekday.value" /><span>{{ weekday.label }}</span></label></div></div>
            <div class="user-policy-hours">
              <label class="admin-field"><span class="admin-field__label">开始时间</span><select v-model="accessPolicyForm.startHour" class="admin-select"><option v-for="hour in hourOptions" :key="hour" :value="hour">{{ String(hour).padStart(2, "0") }}:00</option></select></label>
              <label class="admin-field"><span class="admin-field__label">结束时间</span><select v-model="accessPolicyForm.endHour" class="admin-select"><option v-for="hour in hourEndOptions" :key="hour" :value="hour">{{ String(hour).padStart(2, "0") }}:00</option></select></label>
            </div>
            <label class="admin-field"><span class="admin-field__label">状态</span><select v-model="accessPolicyForm.status" class="admin-select"><option value="active">启用</option><option value="inactive">停用</option></select></label>
            <div class="admin-field">
              <span class="admin-field__label">物资、每日数量和可领取时间</span>
              <div class="user-policy-limits">
                <div v-for="(limit, index) in accessPolicyForm.goodsLimits" :key="`${index}-${limit.goodsId}`" class="user-policy-limits__row">
                  <select v-model="limit.goodsId" class="admin-select"><option v-for="goods in goodsCatalog" :key="goods.goodsId" :value="goods.goodsId">{{ goods.name }} / {{ goods.goodsId }}</option></select>
                  <input v-model.number="limit.quantity" class="admin-input" type="number" min="1" />
                  <button class="admin-button admin-button--ghost" @click="removePolicyGoodsLimit(index)">删除</button>
                </div>
              </div>
              <button v-if="!editingAccessPolicyId" class="admin-text-button" @click="addPolicyGoodsLimit">继续添加商品</button>
            </div>
            <button class="admin-button" :disabled="saving || accessPolicyForm.endHour <= accessPolicyForm.startHour" @click="submitAccessPolicy">{{ saving ? "保存中" : editingAccessPolicyId ? "保存每日可领取物资" : "新增每日可领取物资" }}</button>
          </div>
          <div v-else class="admin-note">当前账号只能查看每日可领取物资，新增、修改或立即生效需要“取货规则管理”权限。</div>
        </article>

        <article v-if="detail.user.role === 'special' && canManageUserRules" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">模板操作</span><h3 class="admin-panel__title">用模板批量填入每日可领取物资</h3></div></div>
          <div class="user-detail-form">
            <label class="admin-field"><span class="admin-field__label">应用方式</span><select v-model="templateApplyForm.mode" class="admin-select"><option value="bind">新增到个人设定</option><option value="replace">覆盖个人设定</option></select></label>
            <div class="admin-field"><span class="admin-field__label">模板选择</span><div class="user-template-checklist"><label v-for="policy in policyTemplates" :key="policy.id" class="user-template-check"><input :checked="templateApplyForm.policyIds.includes(policy.id)" type="checkbox" @change="toggleTemplatePolicy(policy.id)" /><span>{{ policy.name }}</span><span class="admin-table__subtext">{{ formatWeekdays(policy.weekdays) }} · {{ String(policy.startHour).padStart(2, "0") }}:00-{{ String(policy.endHour).padStart(2, "0") }}:00 · {{ policy.goodsLimits.map((limit) => `${limit.goodsName} x${limit.quantity}`).join("，") }}</span></label></div></div>
            <div class="admin-note">{{ templateApplyForm.mode === "replace" ? "覆盖会在二次确认后，于下一个业务日替换当前个人设定。" : "新增会把模板中的每个货品最小单元追加到该人员的个人设定中。" }}</div>
            <button class="admin-button" :disabled="saving || !templateApplyForm.policyIds.length" @click="applyTemplatePolicies">{{ saving ? "处理中" : templateApplyForm.mode === "replace" ? "覆盖个人设定" : "新增到个人设定" }}</button>
          </div>
        </article>

        <article v-if="detail.user.role === 'special' && canRecoverSettlement" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div><span class="admin-kicker">缺失结算补记</span><h3 class="admin-panel__title">按开柜事件补记实际领取</h3></div>
          </div>
          <div class="admin-note">只处理柜门可信关闭满 10 分钟、仍未收到平台结算明细的事件。预约物资仅供参考，必须按现场盘点填写实际取走商品。</div>

          <div v-if="manualSettlementCandidates.length" class="user-settlement-candidates">
            <button
              v-for="candidate in manualSettlementCandidates"
              :key="candidate.eventId"
              class="user-settlement-candidate"
              :class="{ 'user-settlement-candidate--selected': candidate.eventId === selectedManualSettlementEventId }"
              type="button"
              @click="selectManualSettlementCandidate(candidate.eventId)"
            >
              <span class="admin-table__strong">{{ candidate.device.name }} · {{ formatDateTime(candidate.closedAt) }}</span>
              <span class="admin-table__subtext">事件 {{ candidate.eventId }}</span>
              <span class="admin-table__subtext">{{ candidate.orderState === "recorded" ? `平台订单 ${candidate.platformOrderNo}` : "平台订单号待补" }} · 已等待 {{ Math.floor(candidate.waitingSeconds / 60) }} 分钟</span>
            </button>
          </div>

          <div v-if="selectedManualSettlementCandidate" class="user-detail-form user-settlement-form">
            <div class="admin-kv">
              <div class="admin-kv__row"><span class="admin-kv__label">柜机</span><span class="admin-kv__value">{{ selectedManualSettlementCandidate.device.name }} / {{ selectedManualSettlementCandidate.device.deviceCode }}</span></div>
              <div class="admin-kv__row"><span class="admin-kv__label">开柜事件</span><span class="admin-kv__value admin-code">{{ selectedManualSettlementCandidate.eventId }}</span></div>
              <div class="admin-kv__row"><span class="admin-kv__label">平台订单</span><span class="admin-kv__value admin-code">{{ selectedManualSettlementCandidate.platformOrderNo || "待补" }}</span></div>
            </div>
            <div class="admin-field">
              <span class="admin-field__label">预约物资参考</span>
              <div v-if="selectedManualSettlementCandidate.intentItems.length" class="admin-note">
                {{ selectedManualSettlementCandidate.intentItems.map((item) => `${item.goodsName} x${item.quantity}`).join("，") }}
              </div>
              <div v-else class="admin-note">该事件没有预约物资记录，请仅依据现场盘点填写。</div>
            </div>
            <div class="admin-field">
              <span class="admin-field__label">实际取走商品</span>
              <div class="user-policy-limits">
                <div v-for="(item, index) in manualSettlementForm.items" :key="`${index}-${item.goodsId}`" class="user-policy-limits__row">
                  <select v-model="item.goodsId" class="admin-select">
                    <option value="" disabled>选择已在该柜机建档的商品</option>
                    <option v-for="goods in selectedManualSettlementGoods" :key="goods.goodsId" :value="goods.goodsId">{{ goods.name }} / {{ goods.goodsId }}</option>
                  </select>
                  <input v-model.number="item.quantity" class="admin-input" type="number" min="1" step="1" />
                  <button class="admin-button admin-button--ghost" type="button" @click="removeManualSettlementItem(index)">删除</button>
                </div>
              </div>
              <button class="admin-text-button" type="button" @click="addManualSettlementItem">继续添加商品</button>
            </div>
            <label v-if="selectedManualSettlementCandidate.orderState === 'awaiting_order'" class="admin-field">
              <span class="admin-field__label">平台订单号（可稍后补录）</span>
              <input v-model="manualSettlementForm.platformOrderNo" class="admin-input" placeholder="留空则先完成本地补记" />
            </label>
            <label class="admin-field"><span class="admin-field__label">处理依据</span><textarea v-model="manualSettlementForm.reason" class="admin-textarea" rows="3" placeholder="例如：关门后 10 分钟仍无结算回调，已由现场人员核对实际商品。"></textarea></label>
            <label class="user-settlement-confirm"><input v-model="manualSettlementForm.confirmed" type="checkbox" /><span>已根据现场盘点确认实际商品；没有直接使用预约内容推断领取结果。</span></label>
            <button class="admin-button" :disabled="saving || !manualSettlementForm.confirmed" @click="submitManualSettlement">{{ saving ? "提交中" : "完成本地人工补记" }}</button>
          </div>

          <div v-else-if="!visibleManualSettlementRecord" class="admin-empty">
            <div class="admin-empty__title">当前没有可补记事件</div>
            <div class="admin-empty__body">未达到 10 分钟、没有可信关门记录或已经收到结算流水的事件不会出现在这里。</div>
          </div>

          <div v-if="visibleManualSettlementRecord" class="user-detail-form user-settlement-result">
            <div class="admin-panel__head">
              <div><span class="admin-kicker">补记状态</span><h4 class="admin-panel__title">{{ formatManualSettlementStatus(visibleManualSettlementRecord.status) }}</h4></div>
              <span class="admin-code">{{ visibleManualSettlementRecord.eventId }}</span>
            </div>
            <div class="admin-note">实际明细：{{ visibleManualSettlementRecord.items.map((item) => `${item.goodsName} x${item.quantity}`).join("，") }}</div>
            <div v-if="visibleManualSettlementRecord.platformOrderNo" class="admin-note">平台订单：{{ visibleManualSettlementRecord.platformOrderNo }}</div>
            <template v-if="visibleManualSettlementRecord.status === 'awaiting_order'">
              <label class="admin-field"><span class="admin-field__label">补录平台订单号</span><input v-model="manualSettlementFollowUp.platformOrderNo" class="admin-input" /></label>
              <button class="admin-button" :disabled="saving || !manualSettlementFollowUp.platformOrderNo.trim()" @click="linkManualSettlementOrder">关联平台订单号</button>
            </template>
            <template v-if="visibleManualSettlementRecord.status === 'awaiting_platform_completion' || visibleManualSettlementRecord.status === 'callback_reconciled'">
              <button class="admin-button" :disabled="saving" @click="completeManualSettlementPlatform">{{ saving ? "回写中" : "完成平台回写" }}</button>
            </template>
            <template v-if="visibleManualSettlementRecord.status === 'awaiting_order' || visibleManualSettlementRecord.status === 'awaiting_platform_completion'">
              <label class="admin-field"><span class="admin-field__label">撤销原因</span><input v-model="manualSettlementFollowUp.reason" class="admin-input" placeholder="仅平台回写前可整单撤销" /></label>
              <button class="admin-button admin-button--ghost" :disabled="saving || !manualSettlementFollowUp.reason.trim()" @click="revertManualSettlement">整单撤销并恢复库存额度</button>
            </template>
            <template v-if="visibleManualSettlementRecord.status === 'conflict'">
              <div class="admin-alert admin-alert--danger">平台迟到回调与人工盘点明细不一致；系统没有二次扣减，请核对后选择结果。</div>
              <div class="admin-list">
                <div class="admin-list__row">
                  <div class="admin-list__main">
                    <span class="admin-list__title">人工盘点明细</span>
                    <span
                      v-for="item in visibleManualSettlementRecord.items"
                      :key="`manual-${item.goodsId}`"
                      class="admin-list__meta"
                    >
                      {{ item.goodsName }}（{{ item.goodsId }}）× {{ item.quantity }}，单价 {{ (item.unitPrice / 100).toFixed(2) }} 元
                    </span>
                  </div>
                </div>
                <div v-if="visibleManualSettlementRecord.lateCallback" class="admin-list__row">
                  <div class="admin-list__main">
                    <span class="admin-list__title">平台迟到回调明细</span>
                    <span
                      v-for="item in visibleManualSettlementRecord.lateCallback.items"
                      :key="`platform-${item.goodsId}`"
                      class="admin-list__meta"
                    >
                      {{ item.goodsName }}（{{ item.goodsId }}）× {{ item.quantity }}，单价 {{ (item.unitPrice / 100).toFixed(2) }} 元
                    </span>
                    <span class="admin-list__meta">
                      平台金额 {{ (visibleManualSettlementRecord.lateCallback.platformAmount / 100).toFixed(2) }} 元 · 接收时间 {{ formatDateTime(visibleManualSettlementRecord.lateCallback.receivedAt) }}
                    </span>
                  </div>
                </div>
              </div>
              <label class="admin-field"><span class="admin-field__label">核对结果</span><select v-model="manualSettlementFollowUp.resolution" class="admin-select"><option value="keep_manual">保留人工盘点结果</option><option value="use_platform">按平台迟到回调修正</option></select></label>
              <label class="admin-field"><span class="admin-field__label">核对依据</span><input v-model="manualSettlementFollowUp.reason" class="admin-input" /></label>
              <button class="admin-button" :disabled="saving || !manualSettlementFollowUp.reason.trim()" @click="resolveManualSettlementConflict">完成冲突核对</button>
            </template>
          </div>

          <div v-if="manualSettlementRecentEvents.length" class="user-settlement-history">
            <span class="admin-field__label">最近人工结算补记</span>
            <button
              v-for="event in manualSettlementRecentEvents"
              :key="event.eventId"
              class="admin-text-button"
              type="button"
              @click="selectedManualSettlementEventId = event.eventId; manualSettlementRecord = event.manualSettlement"
            >
              {{ formatDateTime(event.updatedAt) }} · {{ formatManualSettlementStatus(event.manualSettlement!.status) }} · {{ event.eventId }}
            </button>
          </div>
        </article>

        <article v-if="detail.user.role === 'special' && canAdjustStock" class="admin-panel admin-panel-block">
          <div class="admin-panel__head"><div><span class="admin-kicker">库存纠错</span><h3 class="admin-panel__title">修正本地库存与人员记录</h3></div></div>
          <div class="user-detail-form">
            <label class="admin-field"><span class="admin-field__label">柜机</span><select v-model="form.deviceCode" class="admin-select"><option v-for="device in devices" :key="device.deviceCode" :value="device.deviceCode">{{ device.name }} / {{ device.deviceCode }}</option></select></label>
            <label class="admin-field"><span class="admin-field__label">货品</span><select v-model="form.goodsId" class="admin-select"><option v-for="goods in selectedDeviceGoods" :key="goods.goodsId" :value="goods.goodsId">{{ goods.name }} / {{ goods.goodsId }}</option></select></label>
            <label class="admin-field"><span class="admin-field__label">数量</span><input v-model.number="form.quantity" class="admin-input" type="number" min="1" /></label>
            <label class="admin-field"><span class="admin-field__label">方向</span><select v-model="form.direction" class="admin-select"><option value="deduct">补扣</option><option value="restock">补货</option></select></label>
            <label class="admin-field"><span class="admin-field__label">备注</span><input v-model="form.note" class="admin-input" placeholder="例如盘点发现库存差异" /></label>
            <div class="admin-note">库存纠错只修正本地库存与人员记录，不会补写开柜结算，也不会在平台创建订单。缺少平台结算明细时请使用上方“缺失结算补记”。</div>
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
.user-detail-form,.user-policy-weekdays,.user-policy-limits,.user-policy-groups,.user-policy-bars,.user-template-checklist,.user-settlement-candidates,.user-settlement-history{display:grid;gap:10px}
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
.user-settlement-candidate{display:grid;gap:4px;padding:12px;text-align:left;border:1px solid var(--admin-line);border-radius:10px;background:var(--admin-panel);color:inherit;cursor:pointer}
.user-settlement-candidate--selected{border-color:var(--admin-accent);background:var(--admin-accent-soft)}
.user-settlement-form,.user-settlement-result{margin-top:12px;padding-top:12px;border-top:1px solid var(--admin-line)}
.user-settlement-confirm{display:flex;align-items:flex-start;gap:8px;line-height:1.5}
.user-settlement-history{margin-top:14px;padding-top:12px;border-top:1px solid var(--admin-line);justify-items:start}
.user-reservation-row{align-items:flex-start}
.user-reservation-actions{display:grid;min-width:min(100%,320px);gap:8px}
@media (max-width:720px){.user-policy-hours,.user-policy-limits__row,.user-policy-weekdays,.user-policy-bar{grid-template-columns:1fr}.user-policy-group__head{flex-direction:column;align-items:flex-start}}
</style>
