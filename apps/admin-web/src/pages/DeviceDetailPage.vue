<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import { adminApi } from "../api/admin";
import AmapLocationPicker from "../components/AmapLocationPicker.vue";

const route = useRoute();

const detail = ref<Awaited<ReturnType<typeof adminApi.deviceDetail>>>();
const loading = ref(false);
const refreshing = ref(false);
const syncing = ref(false);
const remoteOpening = ref(false);
const resolvingTaskId = ref("");
const selectedDoorNum = ref("1");
const lastUpdatedAt = ref("");
const mapPickerVisible = ref(false);
const updatingLocation = ref(false);
const goodsCatalog = ref<Awaited<ReturnType<typeof adminApi.goodsCatalog>>>([]);
const addingGoods = ref(false);
const removingGoodsId = ref("");
const selectedGoodsToAdd = ref("");
const debugPanelVisible = ref(false);
const debugLoading = ref(false);
const debugLoaded = ref(false);
const debugCallbackLogs = ref<Awaited<ReturnType<typeof adminApi.deviceCallbackLogs>>>([]);
const debugSystemAuditLogs = ref<Awaited<ReturnType<typeof adminApi.systemAuditLogs>>>([]);
const notifyingPaymentEventId = ref("");
const refundingEventId = ref("");

let timer: ReturnType<typeof setInterval> | undefined;

const selectedDoorGoods = computed(() => {
  const device = detail.value?.device;

  if (!device) {
    return [];
  }

  if (!selectedDoorNum.value) {
    return device.doors.flatMap((door) => door.goods);
  }

  return device.doors.find((door) => door.doorNum === selectedDoorNum.value)?.goods ?? [];
});
const pendingTasks = computed(() => detail.value?.pendingTasks ?? []);
const recentEvents = computed(() => detail.value?.recentEvents ?? []);
const recentLogs = computed(() => detail.value?.recentLogs ?? []);
const businessDayServedUsers = computed(() => detail.value?.businessDayServedUsers ?? []);
const stockChangeMap = computed(
  () => new Map((detail.value?.stockChanges ?? []).map((item) => [item.goodsId, item]))
);
const addableGoodsOptions = computed(() => {
  const existingGoodsIds = new Set(selectedDoorGoods.value.map((item) => item.goodsId));

  return goodsCatalog.value.filter(
    (item) => item.status !== "inactive" && !existingGoodsIds.has(item.goodsId)
  );
});
const debugSystemAuditRows = computed(() =>
  debugSystemAuditLogs.value.filter(
    (entry) =>
      entry.path.includes("/external/smartvm") ||
      entry.path.includes("/api/cabinet-events/callbacks") ||
      entry.path.includes("/api/inventory-orders/callbacks/refund")
  )
);

const formatDeviceStatus = (status?: "online" | "offline" | "maintenance") =>
  status === "online" ? "在线" : status === "maintenance" ? "维护中" : "离线";

const formatDoorState = (state?: "open" | "closed" | "unknown") =>
  state === "open" ? "门已开" : state === "closed" ? "门已关" : "门状态未知";

const formatEventStatus = (status: string) => {
  if (status === "created") return "已创建";
  if (status === "opening") return "开门中";
  if (status === "opened") return "门已开";
  if (status === "closed") return "门已关";
  if (status === "settled") return "已结算";
  if (status === "failed") return "失败";
  if (status === "timeout_unopened") return "超时未开门";
  if (status === "stuck_open") return "久开未关";
  if (status === "refunded") return "已退款";
  return status;
};

const formatPlatformSyncStatus = (event: NonNullable<typeof recentEvents.value>[number]) => {
  if (event.refundedAt) {
    return `已退款${event.refundNo ? ` / ${event.refundNo}` : ""}`;
  }

  if (event.paymentNotifyStatus === "success") {
    return `已回写付款成功${event.paymentTransactionId ? ` / ${event.paymentTransactionId}` : ""}`;
  }

  if (event.paymentNotifyStatus === "failed") {
    return `回写失败${event.paymentNotifyMessage ? `：${event.paymentNotifyMessage}` : ""}`;
  }

  if (event.adjustmentOrderNo && event.adjustmentAmount && event.adjustmentAmount > 0) {
    return `补扣待支付 / ${event.adjustmentOrderNo}`;
  }

  if (event.adjustmentOrderNo) {
    return `补扣已产生 / ${event.adjustmentOrderNo}`;
  }

  if (event.paymentNotifyStatus === "pending") {
    return event.paymentNotifyMessage || "待回写";
  }

  return "未关联平台动作";
};

const formatLogStatus = (status: string) =>
  status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";

const formatUserRole = (role: "admin" | "merchant" | "special") =>
  role === "admin" ? "管理员" : role === "merchant" ? "商户" : "特殊群体";

const formatDebugPayload = (value: unknown) => {
  if (value === undefined || value === null) {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatGoodsStock = (goods: NonNullable<typeof selectedDoorGoods.value>[number]) => {
  const base =
    goods.thresholdEnabled && goods.lowStockThreshold !== undefined
      ? `${goods.stock}/${goods.lowStockThreshold}`
      : `${goods.stock}`;
  const tags: string[] = [];

  if (goods.thresholdEnabled && goods.lowStockThreshold !== undefined && goods.stock <= 0) {
    tags.push("缺货");
  } else if (
    goods.thresholdEnabled &&
    goods.lowStockThreshold !== undefined &&
    goods.stock < goods.lowStockThreshold
  ) {
    tags.push("缺货");
  }

  if (goods.expiringSoon) {
    tags.push("临期");
  }

  return tags.length ? `${base}（${tags.join("，")}）` : base;
};

const taskActionLabel = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  task.grade === "fault" ? "标记已知晓" : "手动完成";

const taskGradeLabel = (grade: "fault" | "feedback" | "warning") =>
  grade === "fault" ? "故障" : grade === "feedback" ? "反馈" : "预警";

const load = async () => {
  loading.value = true;
  try {
    const [deviceDetail, catalogResponse] = await Promise.all([
      adminApi.deviceDetail(String(route.params.deviceCode)),
      adminApi.goodsCatalog()
    ]);
    detail.value = deviceDetail;
    goodsCatalog.value = catalogResponse;
    if (!detail.value.device.doors.some((door) => door.doorNum === selectedDoorNum.value)) {
      selectedDoorNum.value = detail.value.device.doors[0]?.doorNum ?? "1";
    }
    if (!selectedGoodsToAdd.value || !addableGoodsOptions.value.some((item) => item.goodsId === selectedGoodsToAdd.value)) {
      selectedGoodsToAdd.value = addableGoodsOptions.value[0]?.goodsId ?? "";
    }
    lastUpdatedAt.value = new Date().toLocaleString("zh-CN", { hour12: false });
  } finally {
    loading.value = false;
  }
};

const loadDebugPanel = async () => {
  debugLoading.value = true;
  try {
    const [callbackLogs, systemAuditLogs] = await Promise.all([
      adminApi.deviceCallbackLogs(String(route.params.deviceCode), 30),
      adminApi.systemAuditLogs({
        deviceCode: String(route.params.deviceCode),
        limit: 40
      })
    ]);
    debugCallbackLogs.value = callbackLogs;
    debugSystemAuditLogs.value = systemAuditLogs;
    debugLoaded.value = true;
  } finally {
    debugLoading.value = false;
  }
};

const refreshDevice = async () => {
  refreshing.value = true;
  try {
    detail.value = await adminApi.refreshDevice(String(route.params.deviceCode));
    lastUpdatedAt.value = new Date().toLocaleString("zh-CN", { hour12: false });
  } finally {
    refreshing.value = false;
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const syncGoods = async () => {
  syncing.value = true;
  try {
    await adminApi.syncDeviceGoods(String(route.params.deviceCode), selectedDoorNum.value);
    await load();
  } finally {
    syncing.value = false;
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const remoteOpen = async () => {
  remoteOpening.value = true;
  try {
    await adminApi.remoteOpenDevice(String(route.params.deviceCode), selectedDoorNum.value);
    await load();
  } finally {
    remoteOpening.value = false;
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const notifyPaymentSuccess = async (event: NonNullable<typeof recentEvents.value>[number]) => {
  const defaultTransactionId =
    event.paymentTransactionId ||
    event.adjustmentOrderNo ||
    `manual-pay-${event.orderNo}-${Date.now()}`;
  const transactionId = window.prompt("请输入支付交易号 transactionId", defaultTransactionId)?.trim();

  if (!transactionId) {
    return;
  }

  const defaultAmount = String(event.adjustmentAmount ?? event.amount ?? 0);
  const amountInput = window.prompt("请输入支付金额（单位：分）", defaultAmount)?.trim();

  if (!amountInput) {
    return;
  }

  const amount = Number(amountInput);

  if (Number.isNaN(amount)) {
    window.alert("操作失败：支付金额必须是数字");
    return;
  }

  if (!window.confirm(`确认向平台回写订单 ${event.orderNo} 的付款成功结果吗？`)) {
    return;
  }

  notifyingPaymentEventId.value = event.eventId;
  try {
    await adminApi.notifyPaymentSuccess({
      orderNo: event.orderNo,
      eventId: event.eventId,
      transactionId,
      deviceCode: event.deviceCode,
      amount
    });
    window.alert("操作成功");
    await load();
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    notifyingPaymentEventId.value = "";
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const refundEvent = async (event: NonNullable<typeof recentEvents.value>[number]) => {
  const defaultTransactionId = event.paymentTransactionId || `refund-txn-${event.orderNo}`;
  const transactionId = window.prompt("请输入退款对应的交易号 transactionId", defaultTransactionId)?.trim();

  if (!transactionId) {
    return;
  }

  const defaultRefundNo = event.refundNo || `refund-${event.orderNo}-${Date.now()}`;
  const refundNo = window.prompt("请输入退款单号 refundNo", defaultRefundNo)?.trim();

  if (!refundNo) {
    return;
  }

  const defaultAmount = String(event.amount ?? event.adjustmentAmount ?? 0);
  const amountInput = window.prompt("请输入退款金额（单位：分）", defaultAmount)?.trim();

  if (!amountInput) {
    return;
  }

  const amount = Number(amountInput);

  if (Number.isNaN(amount)) {
    window.alert("操作失败：退款金额必须是数字");
    return;
  }

  if (!window.confirm(`确认向平台发起订单 ${event.orderNo} 的退款吗？`)) {
    return;
  }

  refundingEventId.value = event.eventId;
  try {
    await adminApi.refundOrder({
      orderNo: event.orderNo,
      transactionId,
      deviceCode: event.deviceCode,
      refundNo,
      amount
    });
    window.alert("操作成功");
    await load();
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    refundingEventId.value = "";
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const resolveTask = async (taskId: string) => {
  const task = pendingTasks.value.find((entry) => entry.id === taskId);
  if (!task || !window.confirm(`确认${taskActionLabel(task)}？`)) {
    return;
  }
  resolvingTaskId.value = taskId;
  try {
    await adminApi.resolveAlert(
      taskId,
      task?.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
    );
    await load();
  } finally {
    resolvingTaskId.value = "";
  }
};

const saveLocation = async (payload: { longitude: number; latitude: number; location: string }) => {
  updatingLocation.value = true;
  try {
    await adminApi.updateDeviceLocation(String(route.params.deviceCode), {
      location: payload.location,
      address: payload.location,
      longitude: payload.longitude,
      latitude: payload.latitude
    });
    mapPickerVisible.value = false;
    await load();
  } finally {
    updatingLocation.value = false;
  }
};

const toggleDebugPanel = async () => {
  debugPanelVisible.value = !debugPanelVisible.value;

  if (debugPanelVisible.value && !debugLoaded.value) {
    await loadDebugPanel();
  }
};

const addGoods = async () => {
  if (!selectedGoodsToAdd.value) {
    window.alert("操作失败：请先选择要加入的货品");
    return;
  }

  addingGoods.value = true;
  try {
    detail.value = await adminApi.addDeviceGoods(String(route.params.deviceCode), {
      goodsId: selectedGoodsToAdd.value,
      doorNum: selectedDoorNum.value
    });
    selectedGoodsToAdd.value = addableGoodsOptions.value[0]?.goodsId ?? "";
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    addingGoods.value = false;
  }
};

const removeGoods = async (goodsId: string) => {
  if (!window.confirm("确认移除这条零库存货品？")) {
    return;
  }

  removingGoodsId.value = goodsId;
  try {
    detail.value = await adminApi.removeDeviceGoods(String(route.params.deviceCode), goodsId, selectedDoorNum.value);
    if (selectedGoodsToAdd.value === goodsId) {
      selectedGoodsToAdd.value = "";
    }
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    removingGoodsId.value = "";
  }
};

watch(
  () => route.params.deviceCode,
  async () => {
    await load();
  }
);

onMounted(async () => {
  await load();
  timer = setInterval(load, 8_000);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">单柜机值守页</p>
          <h3 class="admin-page__section-title">{{ detail?.device.name ?? "加载中" }}</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">自动刷新 8 秒一次</span>
          <span class="admin-copy">最近刷新：{{ lastUpdatedAt || "尚未加载" }}</span>
        </div>
      </div>
    </section>

    <section v-if="detail" class="admin-grid">
      <article class="admin-panel admin-panel-block">
        <div class="device-detail-status">
          <div class="device-detail-status__item">
            <span class="admin-kicker">柜机状态</span>
            <strong>{{ formatDeviceStatus(detail.device.status) }}</strong>
            <span class="admin-table__subtext">{{ detail.device.deviceCode }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">门状态</span>
            <strong>{{ formatDoorState(detail.runtime.doorState) }}</strong>
            <span class="admin-table__subtext">{{ detail.runtime.openedAfterLastCommand ? "已收到开门反馈" : "未收到开门反馈" }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">最近开门</span>
            <strong class="admin-code">{{ detail.runtime.lastOpenedAt ? detail.runtime.lastOpenedAt.slice(0, 16).replace("T", " ") : "-" }}</strong>
            <span class="admin-table__subtext">最近关门：{{ detail.runtime.lastClosedAt ? detail.runtime.lastClosedAt.slice(0, 16).replace("T", " ") : "-" }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">库存与服务</span>
            <strong class="admin-code">{{ detail.totalStock }} 件</strong>
            <span class="admin-table__subtext">累计服务 {{ detail.servedUsers }} 人 / 今日 {{ businessDayServedUsers.length }} 人</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">待处理</span>
            <strong class="admin-code">{{ pendingTasks.length }} 项</strong>
            <span class="admin-table__subtext">最近心跳：{{ detail.device.lastSeenAt.slice(0, 16).replace("T", " ") }}</span>
          </div>
        </div>
      </article>

      <section class="admin-grid admin-grid--main-aside">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">货品台账</span>
              <h3 class="admin-panel__title">本地库存由服务端维护，相对业务日起点显示变化量</h3>
            </div>
            <div class="admin-toolbar">
              <label class="admin-field admin-field--inline">
                <span class="admin-field__label">货门</span>
                <select v-model="selectedDoorNum" class="admin-select">
                  <option v-for="door in detail.device.doors" :key="door.doorNum" :value="door.doorNum">
                    {{ door.label }} / {{ door.doorNum }}
                  </option>
                </select>
              </label>
              <button class="admin-button admin-button--ghost" :disabled="syncing" @click="syncGoods">
                {{ syncing ? "同步中" : "同步货品种类" }}
              </button>
            </div>
          </div>

          <div class="device-goods-toolbar">
            <label class="admin-field admin-field--inline device-goods-toolbar__field">
              <span class="admin-field__label">新增货品</span>
              <select v-model="selectedGoodsToAdd" class="admin-select">
                <option value="">请选择货品</option>
                <option v-for="item in addableGoodsOptions" :key="item.goodsId" :value="item.goodsId">
                  {{ item.name }} / {{ item.goodsCode }}
                </option>
              </select>
            </label>
            <button class="admin-button" :disabled="addingGoods || !selectedGoodsToAdd" @click="addGoods">
              {{ addingGoods ? "加入中" : "加入柜机" }}
            </button>
            <span class="admin-copy">零库存且已移除的货品将不再显示；未开启阈值时即使库存为 0 也不会触发缺货提醒。</span>
          </div>

          <table class="admin-table">
            <thead>
              <tr>
                <th>货品</th>
                <th>分类</th>
                <th>库存</th>
                <th>今日变化</th>
                <th>临期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="goods in selectedDoorGoods" :key="goods.goodsId">
                <td>
                  <span class="admin-table__strong">{{ goods.name }}</span>
                  <span class="admin-table__subtext">{{ goods.goodsId }}</span>
                </td>
                <td>{{ goods.category }}</td>
                <td class="admin-code">{{ formatGoodsStock(goods) }}</td>
                <td>
                  <span
                    class="admin-pill"
                    :class="(stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0) >= 0 ? 'admin-pill--success' : 'admin-pill--warning'"
                  >
                    {{ (stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0) >= 0 ? "+" : "" }}{{ stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0 }}
                  </span>
                </td>
                <td class="admin-code">
                  {{ goods.expiresAt ? goods.expiresAt.slice(0, 16).replace("T", " ") : "-" }}
                </td>
                <td>
                  <button
                    v-if="goods.stock <= 0"
                    class="admin-button admin-button--ghost"
                    :disabled="removingGoodsId === goods.goodsId"
                    @click="removeGoods(goods.goodsId)"
                  >
                    {{ removingGoodsId === goods.goodsId ? "移除中" : "移除" }}
                  </button>
                  <span v-else class="admin-table__subtext">库存未清零</span>
                </td>
              </tr>
            </tbody>
          </table>
        </article>

        <aside class="admin-grid">
          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">地图位置</span>
                <h3 class="admin-panel__title">保存柜机坐标后，移动端会按距离排序</h3>
              </div>
              <button class="admin-button admin-button--ghost" :disabled="updatingLocation" @click="mapPickerVisible = true">
                {{ updatingLocation ? "保存中" : "设置位置" }}
              </button>
            </div>
            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">位置说明</span>
                <span class="admin-kv__value">{{ detail.device.location }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">坐标</span>
                <span class="admin-kv__value admin-code">
                  {{
                    detail.device.longitude !== undefined && detail.device.latitude !== undefined
                      ? `${detail.device.longitude.toFixed(6)}, ${detail.device.latitude.toFixed(6)}`
                      : "未设置"
                  }}
                </span>
              </div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">今日服务人员</span>
                <h3 class="admin-panel__title">业务日 {{ detail.businessDateKey }} 内的领取 / 补货情况</h3>
              </div>
            </div>
            <table v-if="businessDayServedUsers.length" class="admin-table">
              <thead>
                <tr>
                  <th>人员</th>
                  <th>商品</th>
                  <th>数量</th>
                  <th>最近时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in businessDayServedUsers" :key="entry.userId">
                  <td>
                    <RouterLink class="admin-link" :to="`/users/${entry.userId}`">{{ entry.userName }}</RouterLink>
                    <span class="admin-table__subtext">{{ formatUserRole(entry.role) }}</span>
                  </td>
                  <td>{{ entry.goodsSummary }}</td>
                  <td class="admin-code">{{ entry.totalQuantity }}</td>
                  <td class="admin-code">{{ entry.lastServedAt.slice(0, 16).replace("T", " ") }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">今日还没有人员操作这台柜机</div>
              <div class="admin-empty__body">领取、补货和手工补扣都会在这里汇总。</div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">控制区</span>
                <h3 class="admin-panel__title">主动刷新与远程开门</h3>
              </div>
            </div>
            <div class="device-detail-actions">
              <button class="admin-button admin-button--ghost" :disabled="refreshing" @click="refreshDevice">
                {{ refreshing ? "刷新中" : "立即刷新" }}
              </button>
              <button class="admin-button" :disabled="remoteOpening" @click="remoteOpen">
                {{ remoteOpening ? "下发中" : "远程开门" }}
              </button>
            </div>
            <div class="admin-note">
              若门状态长时间不变化或最近一次开门后未收到开门确认，请直接关注右侧待处理任务。
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">待处理任务</span>
                <h3 class="admin-panel__title">故障、缺货、反馈统一处理</h3>
              </div>
            </div>
            <div v-if="pendingTasks.length" class="admin-list">
              <div v-for="task in pendingTasks" :key="task.id" class="admin-list__row">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ task.title }}</span>
                  <span class="admin-list__meta">
                    {{ taskGradeLabel(task.grade) }} · {{ task.status === "acknowledged" ? "已知晓" : "待处理" }} · {{ task.dueAt.slice(0, 16).replace("T", " ") }}
                  </span>
                  <span class="admin-table__subtext">{{ task.detail }}</span>
                </div>
                <div class="device-task-actions">
                  <button
                    v-if="task.status === 'open'"
                    class="admin-button admin-button--ghost"
                    :disabled="resolvingTaskId === task.id"
                    @click="resolveTask(task.id)"
                  >
                    {{ resolvingTaskId === task.id ? "处理中" : taskActionLabel(task) }}
                  </button>
                  <span v-else class="admin-table__subtext">已知晓</span>
                  <RouterLink class="admin-link" :to="`/logs?subjectType=alert&subjectId=${task.id}`">日志</RouterLink>
                </div>
              </div>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">当前没有待处理任务</div>
              <div class="admin-empty__body">低库存、长时间敞门和用户反馈会显示在这里。</div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">最近开柜事件</span>
                <h3 class="admin-panel__title">按时间倒序查看</h3>
              </div>
            </div>
            <table v-if="recentEvents.length" class="admin-table">
              <thead>
                <tr>
                  <th>订单</th>
                  <th>状态</th>
                  <th>平台联动</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="event in recentEvents" :key="event.eventId">
                  <td>
                    <span class="admin-table__strong">{{ event.orderNo }}</span>
                    <span class="admin-table__subtext">{{ event.eventId }}</span>
                  </td>
                  <td>{{ formatEventStatus(event.status) }}</td>
                  <td>
                    <span class="admin-table__strong">{{ formatPlatformSyncStatus(event) }}</span>
                    <span v-if="event.paymentNotifyMessage" class="admin-table__subtext">{{ event.paymentNotifyMessage }}</span>
                    <span
                      v-if="event.adjustmentOrderNo"
                      class="admin-table__subtext"
                    >
                      补扣单 {{ event.adjustmentOrderNo }}{{ event.adjustmentAmount !== undefined ? ` / ${event.adjustmentAmount} 分` : "" }}
                    </span>
                    <span
                      v-if="event.refundNo || event.refundTransactionId"
                      class="admin-table__subtext"
                    >
                      {{ event.refundNo ? `退款单 ${event.refundNo}` : "" }}{{ event.refundNo && event.refundTransactionId ? " / " : "" }}{{ event.refundTransactionId ? `交易号 ${event.refundTransactionId}` : "" }}
                    </span>
                  </td>
                  <td>
                    <span class="admin-code">{{ event.updatedAt.slice(0, 16).replace("T", " ") }}</span>
                    <RouterLink class="admin-table__subtext admin-link" :to="`/logs?subjectType=event&subjectId=${event.eventId}`">
                      查看关联日志
                    </RouterLink>
                  </td>
                  <td>
                    <div class="device-event-actions">
                      <button
                        class="admin-button admin-button--ghost"
                        :disabled="notifyingPaymentEventId === event.eventId"
                        @click="notifyPaymentSuccess(event)"
                      >
                        {{ notifyingPaymentEventId === event.eventId ? "回写中" : "付款成功" }}
                      </button>
                      <button
                        class="admin-button admin-button--ghost"
                        :disabled="refundingEventId === event.eventId || event.status === 'refunded'"
                        @click="refundEvent(event)"
                      >
                        {{ refundingEventId === event.eventId ? "退款中" : event.status === "refunded" ? "已退款" : "退款" }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">{{ loading ? "正在加载事件" : "当前没有开柜事件" }}</div>
              <div class="admin-empty__body">远程开门、用户取货和商户补货都会在这里记录。</div>
            </div>
          </article>
        </aside>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">底层调试</p>
            <h3 class="admin-page__section-title">默认忽略柜机底层操作，只有排查平台联调问题时再展开</h3>
          </div>
          <div class="admin-toolbar">
            <button class="admin-button admin-button--ghost" @click="toggleDebugPanel">
              {{ debugPanelVisible ? "收起底层调试" : "查看底层调试" }}
            </button>
            <button
              v-if="debugPanelVisible"
              class="admin-button admin-button--ghost"
              :disabled="debugLoading"
              @click="loadDebugPanel"
            >
              {{ debugLoading ? "刷新中" : "刷新调试信息" }}
            </button>
          </div>
        </div>

        <article v-if="debugPanelVisible" class="admin-panel admin-panel-block">
          <div class="debug-grid">
            <section class="debug-panel">
              <h4 class="debug-panel__title">平台外呼与系统审计</h4>
              <div v-if="debugSystemAuditRows.length" class="debug-list">
                <article v-for="entry in debugSystemAuditRows" :key="`${entry.occurredAt}-${entry.path}`" class="debug-card">
                  <div class="debug-card__meta">
                    <span class="admin-code">{{ entry.occurredAt.slice(0, 19).replace("T", " ") }}</span>
                    <span class="admin-pill" :class="entry.statusCode >= 500 ? 'admin-pill--danger' : entry.statusCode >= 400 ? 'admin-pill--warning' : 'admin-pill--success'">
                      {{ entry.statusCode }}
                    </span>
                    <span class="admin-code">{{ entry.path }}</span>
                  </div>
                  <p v-if="entry.error?.message" class="debug-card__error">错误：{{ entry.error.message }}</p>
                  <details>
                    <summary>查看请求与响应</summary>
                    <pre class="debug-card__pre">请求：
{{ formatDebugPayload(entry.body) }}

响应：
{{ formatDebugPayload(entry.response) }}</pre>
                  </details>
                </article>
              </div>
              <div v-else class="admin-empty">
                <div class="admin-empty__title">{{ debugLoading ? "正在加载系统审计" : "暂无底层系统审计" }}</div>
                <div class="admin-empty__body">这里会显示 SmartVM 外呼请求、返回状态和错误原文。</div>
              </div>
            </section>

            <section class="debug-panel">
              <h4 class="debug-panel__title">平台回调原始记录</h4>
              <div v-if="debugCallbackLogs.length" class="debug-list">
                <article v-for="entry in debugCallbackLogs" :key="entry.id" class="debug-card">
                  <div class="debug-card__meta">
                    <span class="admin-code">{{ entry.receivedAt.slice(0, 19).replace("T", " ") }}</span>
                    <span class="admin-pill admin-pill--neutral">{{ entry.type }}</span>
                  </div>
                  <pre class="debug-card__pre">{{ formatDebugPayload(entry.payload) }}</pre>
                </article>
              </div>
              <div v-else class="admin-empty">
                <div class="admin-empty__title">{{ debugLoading ? "正在加载回调记录" : "暂无相关回调" }}</div>
                <div class="admin-empty__body">这里会保留门状态、结算、补扣、退款等平台回推的原始报文。</div>
              </div>
            </section>
          </div>
        </article>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">柜机日志</p>
            <h3 class="admin-page__section-title">查看该柜机的全部关键操作和异常</h3>
          </div>
          <RouterLink class="admin-link" :to="`/logs?subjectType=device&subjectId=${detail.device.deviceCode}`">进入日志总览</RouterLink>
        </div>

        <article class="admin-panel admin-panel-block">
          <table v-if="recentLogs.length" class="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in recentLogs" :key="log.id">
                <td class="admin-code">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</td>
                <td>
                  <span class="admin-table__strong">{{ log.description }}</span>
                  <span class="admin-table__subtext">{{ log.detail }}</span>
                </td>
                <td>
                  <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                    {{ formatLogStatus(log.status) }}
                  </span>
                </td>
                <td>
                  <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有柜机日志</div>
            <div class="admin-empty__body">刷新、远程开门、故障回调和货物流动会自动记录在这里。</div>
          </div>
        </article>
      </section>
    </section>

    <div v-if="mapPickerVisible" class="device-map-backdrop" @click.self="mapPickerVisible = false">
      <section class="device-map-panel admin-panel">
        <AmapLocationPicker
          :initial-longitude="detail.device.longitude"
          :initial-latitude="detail.device.latitude"
          :initial-location="detail.device.location"
          @close="mapPickerVisible = false"
          @confirm="saveLocation"
        />
      </section>
    </div>
  </section>
</template>

<style scoped>
.device-detail-status {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.device-detail-status__item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.device-detail-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.device-event-actions {
  display: grid;
  gap: 6px;
}

.device-goods-toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 360px) auto minmax(0, 1fr);
  gap: 10px;
  align-items: end;
  margin-bottom: 12px;
}

.device-goods-toolbar__field {
  min-width: 0;
}

.debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.debug-panel {
  display: grid;
  gap: 10px;
}

.debug-panel__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--admin-text);
}

.debug-list {
  display: grid;
  gap: 10px;
}

.debug-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.debug-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.debug-card__error {
  margin: 0;
  color: #b42318;
  font-size: 13px;
}

.debug-card__pre {
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid var(--admin-line);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.device-task-actions {
  display: grid;
  justify-items: end;
  gap: 6px;
}

.device-map-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.device-map-panel {
  width: min(960px, 100%);
  padding: 14px;
}

.admin-field--inline {
  min-width: 160px;
}

@media (max-width: 1280px) {
  .device-detail-status {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .device-goods-toolbar {
    grid-template-columns: 1fr;
  }

  .debug-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .device-detail-status,
  .device-detail-actions {
    grid-template-columns: 1fr;
  }
}
</style>
