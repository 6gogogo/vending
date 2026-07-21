<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import type {
  DeviceMonitoringDetail,
  DeviceRecord,
  ExpiredBatchDispositionMethod,
  GoodsBatchRecord,
  WarehouseInventorySnapshot
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { useAdminSessionStore } from "../stores/session";
import { formatDate, formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";

const sessionStore = useAdminSessionStore();
const canTransferWarehouse = computed(() => sessionStore.can("warehouse:transfer"));
const canStocktakeWarehouse = computed(() => sessionStore.can("warehouse:stocktake"));
const canDisposeExpiredWarehouse = computed(() => sessionStore.can("warehouse:dispose-expired"));
const canExportWarehouse = computed(() => sessionStore.can("warehouse:export"));
const loading = ref(false);
const saving = ref(false);
const snapshot = ref<WarehouseInventorySnapshot>();
const devices = ref<DeviceRecord[]>([]);
const stocktakeDetail = ref<DeviceMonitoringDetail>();
const message = ref<{ type: "success" | "error"; text: string }>();
const confirmation = ref<{
  title: string;
  description: string;
  rows: Array<{ label: string; value: string }>;
  details?: string[];
  confirmLabel: string;
}>();
const confirmationDialog = ref<HTMLDialogElement>();
const confirmationCancelButton = ref<HTMLButtonElement>();
let confirmationResolver: ((confirmed: boolean) => void) | undefined;
let confirmationPreviousFocus: HTMLElement | undefined;
const showMessage = (type: "success" | "error", text: string) => {
  message.value = { type, text };
};

const requestConfirmation = async (value: NonNullable<typeof confirmation.value>) => {
  if (confirmationResolver) {
    return false;
  }

  confirmationPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  confirmation.value = value;
  const result = new Promise<boolean>((resolve) => {
    confirmationResolver = resolve;
  });
  await nextTick();
  if (confirmationDialog.value && !confirmationDialog.value.open) {
    confirmationDialog.value.showModal();
  }
  confirmationCancelButton.value?.focus();
  return result;
};

const restoreConfirmationFocus = async () => {
  const target = confirmationPreviousFocus;
  confirmationPreviousFocus = undefined;
  await nextTick();

  if (target?.isConnected && !target.matches(":disabled") && target.getAttribute("aria-disabled") !== "true") {
    target.focus();
  }
};

const answerConfirmation = (confirmed: boolean) => {
  const resolve = confirmationResolver;
  confirmationResolver = undefined;
  if (confirmationDialog.value?.open) {
    confirmationDialog.value.close();
  }
  confirmation.value = undefined;
  resolve?.(confirmed);

  if (!confirmed) {
    void restoreConfirmationFocus();
  }
};

const transferForm = ref({
  fromCode: "WAREHOUSE-LOCAL",
  toCode: "",
  goodsId: "",
  sourceBatchId: "",
  quantity: 1,
  note: ""
});

const stocktakeForm = ref({
  deviceCode: "",
  note: ""
});

const dispositionMethodLabels: Record<ExpiredBatchDispositionMethod, string> = {
  destroy: "报废销毁",
  return_supplier: "退回供应方",
  other: "其他合规处置"
};
const dispositionForm = ref<{
  batchId: string;
  quantity: number;
  method: ExpiredBatchDispositionMethod;
  reason: string;
}>({
  batchId: "",
  quantity: 1,
  method: "destroy",
  reason: ""
});
const dispositionRequestKey = ref("");
const dispositionFeedback = ref("");

const stocktakeItems = ref<Array<{ goodsId: string; goodsName: string; actualQuantity: number; systemQuantity: number }>>([]);

const locationOptions = computed(() => {
  const warehouse = snapshot.value?.warehouse;
  return [
    ...(warehouse
      ? [
          {
            code: warehouse.code,
            name: warehouse.name
          }
        ]
      : []),
    ...devices.value.map((item) => ({
      code: item.deviceCode,
      name: item.name
    }))
  ];
});

const sourceGoodsOptions = computed(() => {
  if (!transferForm.value.fromCode) {
    return [];
  }

  const grouped = new Map<
    string,
    { goodsId: string; goodsName: string; currentStock: number; batchCount: number; nearestExpiryAt?: string }
  >();

  for (const batch of (snapshot.value?.transferableBatches ?? []).filter(
    (entry) => entry.deviceCode === transferForm.value.fromCode
  )) {
    const existing = grouped.get(batch.goodsId);

    if (existing) {
      existing.currentStock += batch.remainingQuantity;
      existing.batchCount += 1;
      existing.nearestExpiryAt = sortExpiry(existing.nearestExpiryAt, batch.expiresAt);
      continue;
    }

    grouped.set(batch.goodsId, {
      goodsId: batch.goodsId,
      goodsName: resolveGoodsName(batch.goodsId),
      currentStock: batch.remainingQuantity,
      batchCount: 1,
      nearestExpiryAt: batch.expiresAt
    });
  }

  return [...grouped.values()].sort((left, right) => left.goodsId.localeCompare(right.goodsId));
});

const sourceBatchOptions = computed(() =>
  (snapshot.value?.transferableBatches ?? [])
    .filter(
      (entry) =>
        entry.deviceCode === transferForm.value.fromCode &&
        entry.goodsId === transferForm.value.goodsId
    )
    .sort(compareBatchByExpiry)
);

const selectedBatch = computed(() =>
  sourceBatchOptions.value.find((entry) => entry.batchId === transferForm.value.sourceBatchId)
);

const expiredWarehouseBatches = computed(() =>
  (snapshot.value?.expiredBatches ?? [])
    .filter((entry) => entry.deviceCode === snapshot.value?.warehouse.code)
    .sort(compareBatchByExpiry)
);

const selectedExpiredBatch = computed(() =>
  expiredWarehouseBatches.value.find((entry) => entry.batchId === dispositionForm.value.batchId)
);

const selectExpiredBatch = (batch: GoodsBatchRecord) => {
  dispositionForm.value.batchId = batch.batchId;
  dispositionForm.value.quantity = Math.min(1, batch.remainingQuantity);
  dispositionForm.value.reason = "";
  dispositionRequestKey.value = "";
  dispositionFeedback.value = "";
};

const resetDispositionForm = () => {
  dispositionForm.value.batchId = "";
  dispositionForm.value.quantity = 1;
  dispositionForm.value.method = "destroy";
  dispositionForm.value.reason = "";
  dispositionRequestKey.value = "";
};

const loadStocktakeDevice = async (deviceCode: string) => {
  if (!deviceCode) {
    stocktakeDetail.value = undefined;
    stocktakeItems.value = [];
    return;
  }

  stocktakeDetail.value = await adminApi.deviceDetail(deviceCode);
  stocktakeItems.value = stocktakeDetail.value.stockChanges.map((item) => ({
    goodsId: item.goodsId,
    goodsName: item.goodsName,
    actualQuantity: item.currentStock,
    systemQuantity: item.currentStock
  }));
};

const load = async () => {
  loading.value = true;
  try {
    const [warehouseResponse, deviceResponse] = await Promise.all([
      adminApi.warehouseInventory(),
      adminApi.devices()
    ]);

    snapshot.value = warehouseResponse;
    devices.value = deviceResponse;

    transferForm.value.toCode = transferForm.value.toCode || deviceResponse[0]?.deviceCode || "";
    transferForm.value.goodsId =
      transferForm.value.goodsId || sourceGoodsOptions.value[0]?.goodsId || "";
    transferForm.value.sourceBatchId =
      sourceBatchOptions.value.find((entry) => entry.batchId === transferForm.value.sourceBatchId)?.batchId ??
      sourceBatchOptions.value[0]?.batchId ??
      "";
    stocktakeForm.value.deviceCode = stocktakeForm.value.deviceCode || deviceResponse[0]?.deviceCode || "";

    if (stocktakeForm.value.deviceCode) {
      await loadStocktakeDevice(stocktakeForm.value.deviceCode);
    }
  } catch (error) {
    showMessage("error", `仓库数据加载失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    loading.value = false;
  }
};

const submitTransfer = async () => {
  if (!canTransferWarehouse.value) {
    showMessage("error", "当前账号没有仓库调拨权限，不能提交库存调拨。");
    return;
  }

  if (
    !transferForm.value.fromCode ||
    !transferForm.value.toCode ||
    !transferForm.value.goodsId ||
    !transferForm.value.sourceBatchId
  ) {
    showMessage("error", "提交调拨前请先选择来源、目标、货品和来源批次。");
    return;
  }

  if (transferForm.value.fromCode === transferForm.value.toCode) {
    showMessage("error", "调拨来源与目标不能相同。");
    return;
  }

  if (
    !Number.isInteger(transferForm.value.quantity) ||
    transferForm.value.quantity <= 0 ||
    !selectedBatch.value ||
    transferForm.value.quantity > selectedBatch.value.remainingQuantity
  ) {
    showMessage("error", "调拨数量必须是来源批次可用范围内的正整数。");
    return;
  }

  const transferGoodsName = resolveGoodsName(transferForm.value.goodsId);
  const sourceName = locationOptions.value.find((item) => item.code === transferForm.value.fromCode)?.name;
  const targetName = locationOptions.value.find((item) => item.code === transferForm.value.toCode)?.name;
  const transferConfirmed = await requestConfirmation({
    title: "最后核对库存调拨",
    description: "确认后将立即变更来源与目标位置的批次库存。",
    rows: [
      { label: "来源", value: `${sourceName ?? transferForm.value.fromCode}（${transferForm.value.fromCode}）` },
      { label: "目标", value: `${targetName ?? transferForm.value.toCode}（${transferForm.value.toCode}）` },
      { label: "货品", value: transferGoodsName },
      { label: "来源批次", value: transferForm.value.sourceBatchId },
      { label: "批次到期", value: formatBatchDate(selectedBatch.value?.expiresAt) },
      { label: "数量", value: String(transferForm.value.quantity) }
    ],
    confirmLabel: "确认并立即调拨"
  });

  if (!transferConfirmed) {
    return;
  }

  saving.value = true;
  try {
    const goodsName = transferGoodsName;
    const quantity = transferForm.value.quantity;
    const sourceBatchId = transferForm.value.sourceBatchId;
    const toCode = transferForm.value.toCode;
    await adminApi.createInventoryTransfer({
      fromCode: transferForm.value.fromCode,
      toCode: transferForm.value.toCode,
      goodsId: transferForm.value.goodsId,
      quantity: transferForm.value.quantity,
      sourceBatchId: transferForm.value.sourceBatchId,
      note: transferForm.value.note || undefined
    });
    showMessage("success", `已调拨 ${goodsName} x${quantity} 到 ${toCode}，来源批次 ${sourceBatchId}。`);
    transferForm.value.note = "";
    await load();
  } catch (error) {
    showMessage("error", `提交调拨失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
    await restoreConfirmationFocus();
  }
};

const submitExpiredDisposition = async () => {
  if (!canDisposeExpiredWarehouse.value) {
    showMessage("error", "当前账号没有过期物资处置权限，不能提交处置记录。");
    return;
  }

  const batch = selectedExpiredBatch.value;

  if (!batch) {
    showMessage("error", "请先从待处置队列选择一个过期批次。");
    return;
  }

  if (
    !Number.isInteger(dispositionForm.value.quantity) ||
    dispositionForm.value.quantity <= 0 ||
    dispositionForm.value.quantity > batch.remainingQuantity
  ) {
    showMessage("error", "处置数量必须是该批次待处置范围内的正整数。");
    return;
  }

  const reason = dispositionForm.value.reason.trim();

  if (!reason) {
    showMessage("error", "请填写可供后续追溯的处置理由。");
    return;
  }

  const quantity = dispositionForm.value.quantity;
  const goodsName = resolveGoodsName(batch.goodsId);
  const methodLabel = dispositionMethodLabels[dispositionForm.value.method];
  const confirmed = await requestConfirmation({
    title: "确认处置过期物资",
    description: "确认后将从该批次精确扣减库存并写入处置记录，此操作不能通过普通调拨撤回。",
    rows: [
      { label: "货品", value: goodsName },
      { label: "批次", value: batch.batchId },
      { label: "过期日期", value: formatBatchDate(batch.expiresAt) },
      { label: "位置", value: batch.locationName || batch.deviceCode },
      { label: "处置数量", value: `${quantity} 件（当前待处置 ${batch.remainingQuantity} 件）` },
      { label: "处置方式", value: methodLabel },
      { label: "处置理由", value: reason }
    ],
    confirmLabel: "确认并记录处置"
  });

  if (!confirmed) {
    return;
  }

  dispositionRequestKey.value ||= globalThis.crypto?.randomUUID?.() ??
    `${batch.batchId}-${Date.now()}`;
  saving.value = true;

  try {
    const disposition = await adminApi.createExpiredBatchDisposition(batch.batchId, {
      confirmed: true,
      quantity,
      method: dispositionForm.value.method,
      reason,
      idempotencyKey: dispositionRequestKey.value
    });
    showMessage("success", `已完成 ${goodsName} 批次 ${batch.batchId} 的 ${quantity} 件过期物资处置。`);
    dispositionFeedback.value = `处置记录已保存：${goodsName} ${quantity} 件，批次剩余 ${disposition.remainingQuantity} 件待处置。`;
    resetDispositionForm();
    await load();
  } catch (error) {
    showMessage("error", `处置提交失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
    await restoreConfirmationFocus();
  }
};

const submitStocktake = async () => {
  if (!canStocktakeWarehouse.value) {
    showMessage("error", "当前账号没有仓库盘点权限，不能提交盘点。");
    return;
  }

  if (!stocktakeForm.value.deviceCode || !stocktakeItems.value.length) {
    showMessage("error", "提交盘点前请先选择盘点柜机，并确认盘点明细。");
    return;
  }

  if (stocktakeItems.value.some((item) => !Number.isInteger(item.actualQuantity) || item.actualQuantity < 0)) {
    showMessage("error", "实盘数量必须是大于或等于 0 的整数。");
    return;
  }

  const changedItems = stocktakeItems.value.filter(
    (item) => item.actualQuantity !== item.systemQuantity
  );
  const changeSummary = changedItems.length
    ? changedItems
        .map(
          (item) =>
            `${item.goodsName}：系统 ${item.systemQuantity}，实盘 ${item.actualQuantity}`
        )
        .join("\n")
    : "无数量差异，仍会生成本次盘点记录。";
  const stocktakeConfirmed = await requestConfirmation({
    title: "最后核对盘点结果",
    description: "确认后将立即按实盘数量调整柜机库存，并生成不可忽略的盘点记录。",
    rows: [
      { label: "柜机", value: stocktakeForm.value.deviceCode },
      { label: "明细数", value: String(stocktakeItems.value.length) },
      { label: "差异数", value: String(changedItems.length) }
    ],
    details: changeSummary.split("\n"),
    confirmLabel: "确认并立即提交盘点"
  });

  if (!stocktakeConfirmed) {
    return;
  }

  saving.value = true;
  try {
    const deviceCode = stocktakeForm.value.deviceCode;
    const itemCount = stocktakeItems.value.length;
    await adminApi.createStocktake({
      deviceCode: stocktakeForm.value.deviceCode,
      note: stocktakeForm.value.note || undefined,
      items: stocktakeItems.value.map((item) => ({
        goodsId: item.goodsId,
        actualQuantity: item.actualQuantity
      }))
    });
    showMessage("success", `已提交 ${deviceCode} 的盘点结果，共 ${itemCount} 个货品明细。`);
    stocktakeForm.value.note = "";
    await load();
  } catch (error) {
    showMessage("error", `提交盘点失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
    await restoreConfirmationFocus();
  }
};

const exportStocktake = async (id: string) => {
  if (!canExportWarehouse.value) {
    showMessage("error", "当前账号没有导出仓库盘点权限。");
    return;
  }

  if (!sessionStore.token) {
    showMessage("error", "导出失败：登录状态已失效，请重新登录后再试。");
    return;
  }

  try {
    const file = await adminApi.exportStocktake(id, sessionStore.token);
    const url = window.URL.createObjectURL(file.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
    showMessage("success", `盘点导出文件已生成：${file.filename}。`);
  } catch (error) {
    showMessage("error", `盘点导出失败：${readErrorMessage(error, "请稍后重试")}`);
  }
};

watch(
  () => transferForm.value.fromCode,
  () => {
    transferForm.value.goodsId = sourceGoodsOptions.value[0]?.goodsId || "";
    transferForm.value.sourceBatchId = sourceBatchOptions.value[0]?.batchId || "";
  }
);

watch(
  () => transferForm.value.goodsId,
  () => {
    transferForm.value.sourceBatchId = sourceBatchOptions.value[0]?.batchId || "";
  }
);

watch(
  selectedBatch,
  (value) => {
    if (!value) {
      transferForm.value.quantity = 1;
      return;
    }

    transferForm.value.quantity = Math.max(
      1,
      Math.min(transferForm.value.quantity || 1, value.remainingQuantity)
    );
  },
  { immediate: true }
);

watch(
  () => stocktakeForm.value.deviceCode,
  async (value) => {
    await loadStocktakeDevice(value);
  }
);

watch(
  () => [
    dispositionForm.value.batchId,
    dispositionForm.value.quantity,
    dispositionForm.value.method,
    dispositionForm.value.reason
  ],
  () => {
    dispositionRequestKey.value = "";
  }
);

onMounted(load);
onUnmounted(() => {
  confirmationResolver?.(false);
  confirmationResolver = undefined;
  confirmationPreviousFocus = undefined;
});

function compareBatchByExpiry(left: GoodsBatchRecord, right: GoodsBatchRecord) {
  const leftExpiry = left.expiresAt ?? "9999-12-31T23:59:59.999Z";
  const rightExpiry = right.expiresAt ?? "9999-12-31T23:59:59.999Z";

  if (leftExpiry !== rightExpiry) {
    return leftExpiry.localeCompare(rightExpiry);
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function sortExpiry(current?: string, next?: string) {
  if (!current) {
    return next;
  }

  if (!next) {
    return current;
  }

  return current.localeCompare(next) <= 0 ? current : next;
}

function resolveGoodsName(goodsId: string) {
  return (
    snapshot.value?.items.find((item) => item.goodsId === goodsId)?.goodsName ??
    devices.value
      .flatMap((item) => item.doors.flatMap((door) => door.goods))
      .find((goods) => goods.goodsId === goodsId)?.name ??
    goodsId
  );
}

function formatBatchDate(value?: string) {
  return value ? formatDate(value) : "未设保质期";
}

function isBatchTransferable(batch: Pick<GoodsBatchRecord, "expiresAt">, now = Date.now()) {
  if (!batch.expiresAt) {
    return true;
  }

  const expiresAt = Date.parse(batch.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">本地仓库</p>
          <h3 class="admin-page__section-title">作为中转站处理调拨、盘点与库存衔接</h3>
        </div>
      </div>

      <div
        v-if="message"
        class="admin-note"
        :class="{ 'warehouse-note--error': message.type === 'error' }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ message.text }}
      </div>

      <div class="admin-grid admin-grid--stats-4">
        <StatTile
          title="仓库实物库存"
          :value="snapshot?.physicalTotalStock ?? 0"
          hint="包含可调拨与过期待处置物资"
        />
        <StatTile title="可调拨库存" :value="snapshot?.transferableTotalStock ?? 0" hint="仍在有效期内，可进入正常调拨" />
        <StatTile title="过期待处置" :value="snapshot?.expiredTotalStock ?? 0" hint="已隔离，不会进入正常调拨" />
        <StatTile title="仓库货品种类" :value="snapshot?.goodsKinds ?? 0" hint="本地仓库当前覆盖种类" />
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">仓库库存</span>
            <h3 class="admin-panel__title">查看仓库当前在库量和保质期批次</h3>
          </div>
        </div>

        <table v-if="snapshot?.items.length" class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>库存</th>
              <th>批次数</th>
              <th>批次明细</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.items" :key="item.goodsId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                  {{ item.goodsName }}
                </RouterLink>
                <span class="admin-table__subtext">{{ item.goodsId }}</span>
              </td>
              <td class="admin-code">{{ item.totalStock }}</td>
              <td class="admin-code">{{ item.batchCount }}</td>
              <td>
                <div class="warehouse-batch-list">
                  <div v-for="batch in item.batches.slice(0, 4)" :key="batch.batchId" class="warehouse-batch-item">
                    <span class="admin-table__strong">{{ formatBatchDate(batch.expiresAt) }}</span>
                    <span class="admin-table__subtext">剩余 {{ batch.remainingQuantity }} 件</span>
                    <span v-if="!isBatchTransferable(batch)" class="admin-pill admin-pill--danger">已过期 · 不可调拨</span>
                  </div>
                  <span v-if="item.batches.length > 4" class="admin-table__subtext">
                    其余 {{ item.batches.length - 4 }} 批请进详情查看
                  </span>
                </div>
              </td>
              <td><RouterLink class="admin-link" :to="`/goods/${item.goodsId}`">详情</RouterLink></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载仓库库存" : "当前仓库没有库存" }}</div>
          <div class="admin-empty__body">调拨到本地仓库后，这里会展示当前在库情况。</div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">调拨</span>
              <h3 class="admin-panel__title">在柜机与本地仓库之间调拨物资</h3>
            </div>
          </div>

          <div v-if="canTransferWarehouse" class="warehouse-form">
            <label class="admin-field">
              <span class="admin-field__label">来源</span>
              <select v-model="transferForm.fromCode" class="admin-select">
                <option v-for="item in locationOptions" :key="item.code" :value="item.code">
                  {{ item.name }} / {{ item.code }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">去向</span>
              <select v-model="transferForm.toCode" class="admin-select">
                <option v-for="item in locationOptions" :key="item.code" :value="item.code">
                  {{ item.name }} / {{ item.code }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">货品</span>
              <select v-model="transferForm.goodsId" class="admin-select">
                <option v-for="item in sourceGoodsOptions" :key="item.goodsId" :value="item.goodsId">
                  {{ item.goodsName }} / 当前 {{ item.currentStock }} / {{ item.batchCount }} 批 / 最早 {{ formatBatchDate(item.nearestExpiryAt) }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">来源批次</span>
              <select v-model="transferForm.sourceBatchId" class="admin-select">
                <option v-for="item in sourceBatchOptions" :key="item.batchId" :value="item.batchId">
                  {{ formatBatchDate(item.expiresAt) }} / 剩余 {{ item.remainingQuantity }} / {{ item.locationName || item.deviceCode }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">数量</span>
              <input
                v-model.number="transferForm.quantity"
                class="admin-input"
                type="number"
                min="1"
                :max="selectedBatch?.remainingQuantity || undefined"
              />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">备注</span>
              <input v-model="transferForm.note" class="admin-input" placeholder="例如 上午调拨" />
            </label>
            <div v-if="selectedBatch" class="admin-note">
              当前选择批次：保质期 {{ formatBatchDate(selectedBatch.expiresAt) }}，可调拨 {{ selectedBatch.remainingQuantity }} 件。
            </div>
            <div v-else class="admin-note warehouse-note--error">
              当前来源没有可调拨批次；已过期批次仍保留在库存中，但不能进入正常调拨流程。
            </div>
            <button class="admin-button" :disabled="saving || !selectedBatch" @click="submitTransfer">{{ saving ? "处理中" : "提交调拨" }}</button>
          </div>
          <div v-else class="admin-note">当前账号只能查看仓库库存，提交调拨需要“仓库调拨”权限。</div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">盘点</span>
              <h3 class="admin-panel__title">按单柜机盘点并导出 Excel</h3>
            </div>
          </div>

          <div v-if="canStocktakeWarehouse" class="warehouse-form">
            <label class="admin-field">
              <span class="admin-field__label">盘点柜机</span>
              <select v-model="stocktakeForm.deviceCode" class="admin-select">
                <option v-for="device in devices" :key="device.deviceCode" :value="device.deviceCode">
                  {{ device.name }} / {{ device.deviceCode }}
                </option>
              </select>
            </label>
            <div v-if="stocktakeItems.length" class="warehouse-stocktake-list">
              <div v-for="item in stocktakeItems" :key="item.goodsId" class="warehouse-stocktake-item">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ item.goodsName }}</span>
                  <span class="admin-list__meta">系统库存 {{ item.systemQuantity }}</span>
                </div>
                <input
                  v-model.number="item.actualQuantity"
                  class="admin-input"
                  type="number"
                  min="0"
                  step="1"
                  :aria-label="`${item.goodsName}实盘数量`"
                />
              </div>
            </div>
            <label class="admin-field">
              <span class="admin-field__label">备注</span>
              <input v-model="stocktakeForm.note" class="admin-input" placeholder="例如 早班盘点" />
            </label>
            <button class="admin-button" :disabled="saving || !stocktakeItems.length" @click="submitStocktake">
              {{ saving ? "处理中" : "提交盘点" }}
            </button>
          </div>
          <div v-else class="admin-note">当前账号只能查看盘点记录，提交盘点需要“仓库盘点”权限。</div>
        </article>
      </aside>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">过期待处置队列</span>
            <h3 class="admin-panel__title">隔离展示已过期批次，按批次完成处置</h3>
          </div>
          <span class="admin-pill" :class="expiredWarehouseBatches.length ? 'admin-pill--danger' : 'admin-pill--success'">
            {{ expiredWarehouseBatches.length ? `${snapshot?.expiredTotalStock ?? 0} 件待处置` : "队列已清空" }}
          </span>
        </div>

        <table v-if="expiredWarehouseBatches.length" class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>批次</th>
              <th>过期日期</th>
              <th>待处置</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in expiredWarehouseBatches" :key="batch.batchId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${batch.goodsId}`">
                  {{ resolveGoodsName(batch.goodsId) }}
                </RouterLink>
                <span class="admin-table__subtext">{{ batch.goodsId }}</span>
              </td>
              <td class="admin-code">{{ batch.batchId }}</td>
              <td>{{ formatBatchDate(batch.expiresAt) }}</td>
              <td class="admin-code">{{ batch.remainingQuantity }}</td>
              <td>
                <button
                  v-if="canDisposeExpiredWarehouse"
                  type="button"
                  class="admin-button admin-button--ghost"
                  :aria-pressed="dispositionForm.batchId === batch.batchId"
                  @click="selectExpiredBatch(batch)"
                >
                  {{ dispositionForm.batchId === batch.batchId ? "已选择" : "选择处置" }}
                </button>
                <span v-else class="admin-table__subtext">仅可查看</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前没有过期待处置批次</div>
          <div class="admin-empty__body">过期批次会自动隔离在此，不会混入可调拨库存。</div>
        </div>
      </article>

      <aside class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">处置登记</span>
            <h3 class="admin-panel__title">核对批次、数量、方式和理由</h3>
          </div>
        </div>

        <div v-if="canDisposeExpiredWarehouse" class="warehouse-form">
          <div
            v-if="dispositionFeedback"
            class="admin-note"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ dispositionFeedback }}
          </div>
          <div v-if="selectedExpiredBatch" class="admin-note warehouse-disposition-selection">
            <strong>{{ resolveGoodsName(selectedExpiredBatch.goodsId) }}</strong>
            <span>批次 {{ selectedExpiredBatch.batchId }}</span>
            <span>过期 {{ formatBatchDate(selectedExpiredBatch.expiresAt) }} · 待处置 {{ selectedExpiredBatch.remainingQuantity }} 件</span>
          </div>
          <div v-else class="admin-note">先从左侧队列选择一个过期批次，再填写处置信息。</div>

          <label class="admin-field">
            <span class="admin-field__label">处置数量</span>
            <input
              v-model.number="dispositionForm.quantity"
              class="admin-input"
              type="number"
              min="1"
              step="1"
              :max="selectedExpiredBatch?.remainingQuantity || undefined"
              :disabled="!selectedExpiredBatch"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">处置方式</span>
            <select v-model="dispositionForm.method" class="admin-select" :disabled="!selectedExpiredBatch">
              <option v-for="(label, value) in dispositionMethodLabels" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">处置理由</span>
            <textarea
              v-model="dispositionForm.reason"
              class="admin-input warehouse-disposition-reason"
              maxlength="300"
              rows="4"
              placeholder="例如 包装破损，按社区过期物资流程销毁"
              :disabled="!selectedExpiredBatch"
            />
          </label>
          <button
            type="button"
            class="admin-button admin-button--danger"
            :disabled="saving || !selectedExpiredBatch"
            @click="submitExpiredDisposition"
          >
            {{ saving ? "处理中" : "核对并提交处置" }}
          </button>
        </div>
        <div v-else class="admin-note">当前账号只能查看待处置队列，提交处置需要“过期物资处置”权限。</div>
      </aside>
    </section>

    <section class="admin-panel admin-panel-block">
      <div class="admin-panel__head">
        <div>
          <span class="admin-kicker">最近处置记录</span>
          <h3 class="admin-panel__title">保留批次、方式、理由和经办人，便于追溯</h3>
        </div>
      </div>

      <table v-if="snapshot?.recentExpiredDispositions.length" class="admin-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>货品 / 批次</th>
            <th>位置</th>
            <th>方式</th>
            <th>数量</th>
            <th>理由</th>
            <th>经办人</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in snapshot.recentExpiredDispositions" :key="item.id">
            <td class="admin-code">{{ formatDateTime(item.disposedAt) }}</td>
            <td>
              <span class="admin-table__strong">{{ item.goodsName }}</span>
              <span class="admin-table__subtext admin-code">{{ item.batchId }}</span>
            </td>
            <td>{{ item.locationName }}</td>
            <td>{{ dispositionMethodLabels[item.method] }}</td>
            <td class="admin-code">{{ item.quantity }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.actorUserName || "管理员" }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="admin-empty">
        <div class="admin-empty__title">当前没有过期物资处置记录</div>
        <div class="admin-empty__body">完成一次处置后，这里会显示可追溯的最近记录。</div>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">最近调拨</span>
            <h3 class="admin-panel__title">记录来源、去向、批次和数量</h3>
          </div>
        </div>

        <table v-if="snapshot?.transfers.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>货品</th>
              <th>来源</th>
              <th>去向</th>
              <th>批次</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.transfers" :key="item.id">
              <td class="admin-code">{{ formatDateTime(item.happenedAt) }}</td>
              <td>{{ item.goodsName }}</td>
              <td>{{ item.fromName }}</td>
              <td>{{ item.toName }}</td>
              <td>
                <div class="warehouse-batch-list">
                  <div
                    v-for="batch in item.batches"
                    :key="`${item.id}-${batch.sourceBatchId}`"
                    class="warehouse-batch-item"
                  >
                    <span class="admin-table__strong">{{ formatBatchDate(batch.expiresAt) }}</span>
                    <span class="admin-table__subtext">{{ batch.quantity }} 件</span>
                  </div>
                </div>
              </td>
              <td class="admin-code">{{ item.quantity }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前没有调拨记录</div>
          <div class="admin-empty__body">提交一次调拨后，这里会出现最新记录。</div>
        </div>
      </article>

      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">最近盘点</span>
            <h3 class="admin-panel__title">盘点后可直接导出 Excel</h3>
          </div>
        </div>

        <table v-if="snapshot?.stocktakes.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>柜机</th>
              <th>条目数</th>
              <th>导出</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.stocktakes" :key="item.id">
              <td class="admin-code">{{ formatDateTime(item.createdAt) }}</td>
              <td>
                <RouterLink class="admin-link" :to="`/operations/${item.deviceCode}`">{{ item.deviceName }}</RouterLink>
              </td>
              <td class="admin-code">{{ item.items.length }}</td>
              <td>
                <button v-if="canExportWarehouse" class="admin-button admin-button--ghost" @click="exportStocktake(item.id)">导出 Excel</button>
                <span v-else class="admin-table__subtext">需要导出仓库盘点权限</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前没有盘点记录</div>
          <div class="admin-empty__body">完成一次盘点后，这里会保留最近结果。</div>
        </div>
      </article>
    </section>

    <dialog
      v-if="confirmation"
      ref="confirmationDialog"
      class="warehouse-confirm admin-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="warehouse-confirm-title"
      aria-describedby="warehouse-confirm-description"
      @cancel.prevent="answerConfirmation(false)"
    >
      <header class="warehouse-confirm__head">
        <div>
          <p class="admin-kicker">高风险操作 · 提交前核对</p>
          <h2 id="warehouse-confirm-title" class="warehouse-confirm__title">{{ confirmation.title }}</h2>
        </div>
        <button
          type="button"
          class="admin-button admin-button--ghost"
          aria-label="关闭确认对话框"
          @click="answerConfirmation(false)"
        >
          取消
        </button>
      </header>

      <p id="warehouse-confirm-description" class="admin-copy">{{ confirmation.description }}</p>
      <dl class="warehouse-confirm__summary">
        <div v-for="row in confirmation.rows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      </dl>
      <div v-if="confirmation.details?.length" class="warehouse-confirm__details">
        <strong>差异明细</strong>
        <ul>
          <li v-for="line in confirmation.details" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="admin-note warehouse-confirm__warning">
        请再次确认对象、批次和数量无误；如有疑问，请取消并返回修改。
      </div>
      <div class="warehouse-confirm__actions">
        <button ref="confirmationCancelButton" type="button" class="admin-button admin-button--ghost" @click="answerConfirmation(false)">
          返回修改
        </button>
        <button type="button" class="admin-button admin-button--danger" @click="answerConfirmation(true)">
          {{ confirmation.confirmLabel }}
        </button>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.warehouse-form,
.warehouse-stocktake-list {
  display: grid;
  gap: 10px;
}

.warehouse-batch-list {
  display: grid;
  gap: 6px;
}

.warehouse-batch-item {
  display: grid;
  gap: 2px;
}

.warehouse-stocktake-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px;
  gap: 10px;
  align-items: center;
}

.warehouse-note--error {
  color: #b42318;
}

.warehouse-disposition-selection {
  display: grid;
  gap: 4px;
}

.warehouse-disposition-reason {
  min-height: 96px;
  resize: vertical;
}

.warehouse-confirm::backdrop {
  background: rgba(15, 23, 42, 0.5);
}

.warehouse-confirm {
  box-sizing: border-box;
  width: min(620px, calc(100% - 48px));
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  margin: auto;
  overflow: auto;
  overscroll-behavior: contain;
  gap: 16px;
  padding: 22px;
  border: 1px solid var(--admin-line);
  border-top: 4px solid #b42318;
  box-shadow: 0 22px 55px rgba(15, 23, 42, 0.28);
}

.warehouse-confirm[open] {
  display: grid;
}

.warehouse-confirm__head,
.warehouse-confirm__actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.warehouse-confirm__title {
  margin: 5px 0 0;
  color: var(--admin-text);
  font-size: 1.3rem;
}

.warehouse-confirm__summary {
  display: grid;
  margin: 0;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  overflow: hidden;
}

.warehouse-confirm__summary > div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 14px;
  padding: 11px 13px;
}

.warehouse-confirm__summary > div + div {
  border-top: 1px solid var(--admin-line);
}

.warehouse-confirm__summary dt {
  color: var(--admin-text-muted);
  font-size: 13px;
  font-weight: 700;
}

.warehouse-confirm__summary dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.warehouse-confirm__details {
  max-height: 180px;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.warehouse-confirm__details ul {
  margin: 8px 0 0;
  padding-left: 20px;
}

.warehouse-confirm__warning {
  color: #8a2c24;
  background: #fff1ef;
  border-color: #e4b7b2;
}

@media (max-width: 640px) {
  .warehouse-confirm {
    width: calc(100% - 24px);
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    margin: auto auto 12px;
  }

  .warehouse-confirm__head,
  .warehouse-confirm__actions {
    align-items: stretch;
    flex-direction: column;
  }

  .warehouse-confirm__summary > div {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
