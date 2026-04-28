<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { GoodsCategory, GoodsCategoryRecord, WarehouseRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { formatDate, formatDateTime } from "../utils/datetime";

const route = useRoute();
const packageFormOptions = ["瓶装", "盒装", "袋装", "杯装", "罐装", "桶装", "份装", "散装", "其他"];

const detail = ref<Awaited<ReturnType<typeof adminApi.goodsDetail>>>();
const warehouses = ref<WarehouseRecord[]>([]);
const goodsCategories = ref<GoodsCategoryRecord[]>([]);
const loading = ref(false);
const saving = ref(false);
const uploadingImage = ref(false);

const goodsForm = ref({
  goodsCode: "",
  name: "",
  fullName: "",
  category: "daily" as GoodsCategory,
  categoryName: "",
  price: 0,
  packageForm: "盒装",
  specification: "",
  manufacturer: "",
  imageUrl: "",
  status: "active" as "active" | "inactive"
});

const batchForm = ref({
  deviceCode: "",
  quantity: 1,
  expiresAt: "",
  sourceType: "admin" as "admin" | "merchant" | "system",
  sourceUserName: "",
  note: ""
});

const batchRemoveForm = ref<Record<string, { quantity: number; note: string }>>({});
const thresholdForm = ref<Record<string, { enabled: boolean; lowStockThreshold: number }>>({});

const goods = computed(() => detail.value?.goods);
const batches = computed(() => detail.value?.batches ?? []);
const deviceSettings = computed(() => detail.value?.deviceSettings ?? []);
const recentLogs = computed(() => detail.value?.recentLogs ?? []);
const formatDate = (value?: string) => (value ? value.slice(0, 10) : "-");
const filteredGoodsCategories = computed(() =>
  goodsCategories.value.filter(
    (item) => item.status === "active" && item.category === goodsForm.value.category
  )
);
const locationOptions = computed(() => [
  ...warehouses.value.map((item) => ({
    code: item.code,
    name: item.name
  })),
  ...deviceSettings.value.map((item) => ({
    code: item.deviceCode,
    name: item.deviceName
  }))
]);
const actionMode = computed(() => {
  if (route.query.action === "inbound") {
    return "inbound";
  }

  if (route.query.action === "outbound") {
    return "outbound";
  }

  return "";
});

const focusActionSection = async () => {
  await nextTick();

  if (typeof document === "undefined") {
    return;
  }

  const targetId =
    actionMode.value === "inbound"
      ? "goods-inbound-section"
      : actionMode.value === "outbound"
        ? "goods-batches-section"
        : "";

  if (!targetId) {
    return;
  }

  document.getElementById(targetId)?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
};

const load = async () => {
  loading.value = true;
  try {
    const [response, warehouseResponse, categoryResponse] = await Promise.all([
      adminApi.goodsDetail(String(route.params.goodsId)),
      adminApi.warehouses(),
      adminApi.goodsCategories()
    ]);
    detail.value = response;
    warehouses.value = warehouseResponse;
    goodsCategories.value = categoryResponse;
    goodsForm.value = {
      goodsCode: response.goods.goodsCode,
      name: response.goods.name,
      fullName: response.goods.fullName ?? response.goods.name,
      category: response.goods.category,
      categoryName: response.goods.categoryName ?? "",
      price: response.goods.price,
      packageForm: response.goods.packageForm ?? "盒装",
      specification: response.goods.specification ?? "",
      manufacturer: response.goods.manufacturer ?? "",
      imageUrl: response.goods.imageUrl,
      status: response.goods.status ?? "active"
    };
    batchForm.value.deviceCode =
      actionMode.value === "inbound"
        ? warehouseResponse[0]?.code ?? response.deviceSettings[0]?.deviceCode ?? ""
        : response.deviceSettings[0]?.deviceCode ?? warehouseResponse[0]?.code ?? "";
    thresholdForm.value = Object.fromEntries(
      response.deviceSettings.map((item) => [
        item.deviceCode,
        {
          enabled: item.enabled,
          lowStockThreshold: item.lowStockThreshold ?? 1
        }
      ])
    );
    batchRemoveForm.value = Object.fromEntries(
      response.batches.map((item) => [
        item.batchId,
        {
          quantity: Math.max(1, item.remainingQuantity),
          note: ""
        }
      ])
    );

    await focusActionSection();
  } finally {
    loading.value = false;
  }
};

const saveGoods = async () => {
  if (!goods.value) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.updateGoods(goods.value.goodsId, {
      goodsCode: goodsForm.value.goodsCode,
      name: goodsForm.value.name,
      fullName: goodsForm.value.fullName,
      category: goodsForm.value.category,
      categoryName: goodsForm.value.categoryName || undefined,
      price: goodsForm.value.price,
      packageForm: goodsForm.value.packageForm || undefined,
      specification: goodsForm.value.specification || undefined,
      manufacturer: goodsForm.value.manufacturer || undefined,
      imageUrl: goodsForm.value.imageUrl,
      status: goodsForm.value.status
    });
    await load();
  } finally {
    saving.value = false;
  }
};

const uploadGoodsImage = async (event: Event) => {
  const target = event.target as HTMLInputElement | null;
  const file = target?.files?.[0];

  if (!file) {
    return;
  }

  uploadingImage.value = true;
  try {
    const uploaded = await adminApi.uploadImage(file);
    goodsForm.value.imageUrl = uploaded.url;
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    uploadingImage.value = false;
    if (target) {
      target.value = "";
    }
  }
};

const addBatch = async () => {
  if (!goods.value || !batchForm.value.deviceCode || batchForm.value.quantity <= 0) {
    return;
  }

  if (
    !window.confirm(
      `确认向 ${batchForm.value.deviceCode} 新增 ${goods.value.name} x${batchForm.value.quantity} 的补货批次？`
    )
  ) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.addGoodsBatch(goods.value.goodsId, {
      deviceCode: batchForm.value.deviceCode,
      quantity: batchForm.value.quantity,
      expiresAt: batchForm.value.expiresAt ? new Date(`${batchForm.value.expiresAt}T23:59:59`).toISOString() : undefined,
      sourceType: batchForm.value.sourceType,
      sourceUserName: batchForm.value.sourceUserName || undefined,
      note: batchForm.value.note || undefined,
      confirmed: true
    });
    batchForm.value.quantity = 1;
    batchForm.value.expiresAt = "";
    batchForm.value.note = "";
    await load();
  } finally {
    saving.value = false;
  }
};

const removeBatch = async (batchId: string) => {
  const form = batchRemoveForm.value[batchId];

  if (!form || form.quantity <= 0) {
    return;
  }

  if (!window.confirm(`确认从批次 ${batchId} 去除 ${form.quantity} 件？该操作会记录为指定批次补扣。`)) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.removeGoodsBatch(batchId, {
      quantity: form.quantity,
      note: form.note || undefined,
      confirmed: true
    });
    await load();
  } finally {
    saving.value = false;
  }
};

const saveThreshold = async (deviceCode: string) => {
  if (!goods.value) {
    return;
  }

  const form = thresholdForm.value[deviceCode];

  if (!form) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.updateDeviceGoodsThreshold(deviceCode, goods.value.goodsId, {
      enabled: form.enabled,
      lowStockThreshold: form.enabled ? form.lowStockThreshold : undefined
    });
    await load();
  } finally {
    saving.value = false;
  }
};

watch(
  () => goodsForm.value.category,
  () => {
    if (!filteredGoodsCategories.value.some((item) => item.name === goodsForm.value.categoryName)) {
      goodsForm.value.categoryName = filteredGoodsCategories.value[0]?.name ?? "";
    }
  }
);

watch(
  () => route.params.goodsId,
  async () => {
    await load();
  }
);

watch(
  () => route.query.action,
  async () => {
    await focusActionSection();
  }
);

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section v-if="detail" class="admin-grid">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">货物详情</span>
            <h3 class="admin-panel__title">{{ detail.goods.name }}</h3>
          </div>
          <RouterLink class="admin-link" to="/goods">返回货物总览</RouterLink>
        </div>

          <div class="admin-grid admin-grid--stats-4">
          <div class="device-detail-status__item">
            <span class="admin-kicker">货品编号</span>
            <strong class="admin-code">{{ detail.goods.goodsId }}</strong>
            <span class="admin-table__subtext">{{ detail.goods.goodsCode }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">当前总库存</span>
            <strong class="admin-code">{{ detail.totalStock }}</strong>
            <span class="admin-table__subtext">按批次剩余量聚合</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">仓库在库</span>
            <strong class="admin-code">{{ detail.warehouseStock }}</strong>
            <span class="admin-table__subtext">本地仓库当前可调拨库存</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">最短保质期</span>
            <strong class="admin-code">{{ formatDate(detail.nearestExpiryAt) }}</strong>
            <span class="admin-table__subtext">取当前剩余批次中最早到期的一批</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">设备分布</span>
            <strong class="admin-code">{{ detail.deviceDistribution.length }}</strong>
            <span class="admin-table__subtext">已覆盖柜机 / 阈值设置同时在下方可改</span>
          </div>
        </div>
      </article>

      <section class="admin-grid admin-grid--main-aside">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">基础信息</span>
              <h3 class="admin-panel__title">可停用货品种类，但不物理删除历史</h3>
            </div>
          </div>

          <div class="goods-detail-form">
            <label class="admin-field">
              <span class="admin-field__label">商品编号</span>
              <input v-model="goodsForm.goodsCode" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">商品全称</span>
              <input v-model="goodsForm.fullName" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">商品名称</span>
              <input v-model="goodsForm.name" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">商品大类</span>
              <select v-model="goodsForm.category" class="admin-select">
                <option value="food">食品</option>
                <option value="drink">饮品</option>
                <option value="daily">日用品</option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">分类</span>
              <select v-model="goodsForm.categoryName" class="admin-select">
                <option value="">未分类</option>
                <option v-for="item in filteredGoodsCategories" :key="item.id" :value="item.name">
                  {{ item.name }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">价格</span>
              <input v-model.number="goodsForm.price" type="number" min="0" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">包装形式</span>
              <select v-model="goodsForm.packageForm" class="admin-select">
                <option v-for="item in packageFormOptions" :key="item" :value="item">
                  {{ item }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">商品规格</span>
              <input v-model="goodsForm.specification" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">厂家</span>
              <input v-model="goodsForm.manufacturer" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">图片</span>
              <input class="admin-input" type="file" accept="image/*" @change="uploadGoodsImage" />
              <span class="admin-table__subtext">{{ uploadingImage ? "上传中" : "选择本地图片后会自动上传" }}</span>
              <img v-if="goodsForm.imageUrl" class="goods-detail-preview" :src="goodsForm.imageUrl" alt="货品图片预览" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">状态</span>
              <select v-model="goodsForm.status" class="admin-select">
                <option value="active">启用</option>
                <option value="inactive">停用</option>
              </select>
            </label>
          </div>

          <button class="admin-button" :disabled="saving" @click="saveGoods">
            {{ saving ? "保存中" : "保存货品信息" }}
          </button>
        </article>

        <aside class="admin-grid">
          <article
            id="goods-inbound-section"
            class="admin-panel admin-panel-block"
            :class="{ 'panel-focus': actionMode === 'inbound' }"
          >
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">手工入库</span>
                <h3 class="admin-panel__title">新增批次并记录来源</h3>
              </div>
            </div>

            <div class="goods-detail-form">
              <label class="admin-field">
                <span class="admin-field__label">所在位置</span>
                <select v-model="batchForm.deviceCode" class="admin-select">
                  <option v-for="item in locationOptions" :key="item.code" :value="item.code">
                    {{ item.name }} / {{ item.code }}
                  </option>
                </select>
              </label>
              <label class="admin-field">
                <span class="admin-field__label">数量</span>
                <input v-model.number="batchForm.quantity" type="number" min="1" class="admin-input" />
              </label>
              <label class="admin-field">
                <span class="admin-field__label">保质期</span>
                <input v-model="batchForm.expiresAt" type="date" class="admin-input" />
              </label>
              <label class="admin-field">
                <span class="admin-field__label">来源类型</span>
                <select v-model="batchForm.sourceType" class="admin-select">
                  <option value="admin">管理员</option>
                  <option value="merchant">商户</option>
                  <option value="system">系统补录</option>
                </select>
              </label>
              <label class="admin-field">
                <span class="admin-field__label">来源名称</span>
                <input v-model="batchForm.sourceUserName" class="admin-input" placeholder="例如 鲜食爱心商户" />
              </label>
              <label class="admin-field">
                <span class="admin-field__label">备注</span>
                <input v-model="batchForm.note" class="admin-input" placeholder="例如 上午批次" />
              </label>
            </div>

            <div class="admin-note">手工入库、手工去除和批次调整只维护本地库存台账，不会在平台创建补货或退货订单。</div>

            <button class="admin-button" :disabled="saving" @click="addBatch">
              {{ saving ? "处理中" : "新增批次" }}
            </button>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">最近日志</span>
                <h3 class="admin-panel__title">货物流动与阈值调整</h3>
              </div>
            </div>

            <div v-if="recentLogs.length" class="admin-list">
              <div v-for="log in recentLogs" :key="log.id" class="admin-list__row">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ log.description }}</span>
                  <span class="admin-list__meta">{{ formatDateTime(log.occurredAt) }}</span>
                </div>
                <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
              </div>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">当前没有相关日志</div>
              <div class="admin-empty__body">手工入库、去除、阈值设置和同步种类会记录在这里。</div>
            </div>
          </article>
        </aside>
      </section>

      <section id="goods-batches-section" class="admin-page__section" :class="{ 'panel-focus-section': actionMode === 'outbound' }">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">批次列表</p>
            <h3 class="admin-page__section-title">来源、柜机、数量与保质期</h3>
          </div>
        </div>

        <article class="admin-panel admin-panel-block">
          <table v-if="batches.length" class="admin-table">
            <thead>
              <tr>
                <th>批次</th>
                <th>来源</th>
                <th>所在位置</th>
                <th>数量</th>
                <th>保质期</th>
                <th>去除</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="batch in batches" :key="batch.batchId">
                <td>
                  <span class="admin-table__strong">{{ batch.batchId }}</span>
                  <span class="admin-table__subtext">{{ formatDate(batch.createdAt) }}</span>
                </td>
                <td>
                  <span class="admin-table__strong">{{ batch.sourceUserName || batch.sourceType }}</span>
                  <span class="admin-table__subtext">{{ batch.sourceType }}{{ batch.sourceUserId ? ` · ${batch.sourceUserId}` : "" }}</span>
                </td>
                <td>
                  <RouterLink v-if="batch.locationType === 'device'" class="admin-link" :to="`/operations/${batch.deviceCode}`">{{ batch.locationName || batch.deviceCode }}</RouterLink>
                  <RouterLink v-else class="admin-link" to="/warehouse">{{ batch.locationName || "本地仓库" }}</RouterLink>
                  <span class="admin-table__subtext">{{ batch.deviceCode }}</span>
                </td>
                <td class="admin-code">{{ batch.remainingQuantity }} / {{ batch.quantity }}</td>
                <td class="admin-code">{{ formatDate(batch.expiresAt) }}</td>
                <td>
                  <div class="goods-batch-actions">
                    <input
                      v-model.number="batchRemoveForm[batch.batchId].quantity"
                      type="number"
                      min="1"
                      :max="Math.max(1, batch.remainingQuantity)"
                      class="admin-input"
                    />
                    <input
                      v-model="batchRemoveForm[batch.batchId].note"
                      class="admin-input"
                      placeholder="去除说明"
                    />
                    <button
                      class="admin-button admin-button--ghost"
                      :disabled="saving || batch.remainingQuantity <= 0"
                      @click="removeBatch(batch.batchId)"
                    >
                      {{ saving ? "处理中" : "去除" }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前还没有批次记录</div>
            <div class="admin-empty__body">新增批次后，这里会按保质期和创建时间展示明细。</div>
          </div>
        </article>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">柜机阈值</p>
            <h3 class="admin-page__section-title">每台柜机单独开启或关闭低库存提醒</h3>
          </div>
        </div>

        <article class="admin-panel admin-panel-block">
          <table class="admin-table">
            <thead>
              <tr>
                <th>柜机</th>
                <th>当前库存</th>
                <th>最短保质期</th>
                <th>阈值开关</th>
                <th>阈值</th>
                <th>保存</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in deviceSettings" :key="item.deviceCode">
                <td>
                  <RouterLink class="admin-link" :to="`/operations/${item.deviceCode}`">{{ item.deviceName }}</RouterLink>
                  <span class="admin-table__subtext">{{ item.deviceCode }}</span>
                </td>
                <td class="admin-code">{{ item.currentStock }}</td>
                <td class="admin-code">{{ formatDate(item.nearestExpiryAt) }}</td>
                <td>
                  <label class="goods-threshold-toggle">
                    <input v-model="thresholdForm[item.deviceCode].enabled" type="checkbox" />
                    <span>{{ thresholdForm[item.deviceCode].enabled ? "已开启" : "未启用" }}</span>
                  </label>
                </td>
                <td>
                  <input
                    v-model.number="thresholdForm[item.deviceCode].lowStockThreshold"
                    type="number"
                    min="0"
                    class="admin-input"
                    :disabled="!thresholdForm[item.deviceCode].enabled"
                  />
                </td>
                <td>
                  <button class="admin-button admin-button--ghost" :disabled="saving" @click="saveThreshold(item.deviceCode)">
                    {{ saving ? "保存中" : "保存" }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </article>
      </section>
    </section>

    <div v-else class="admin-empty">
      <div class="admin-empty__title">{{ loading ? "正在加载货物详情" : "未找到对应货物" }}</div>
      <div class="admin-empty__body">请返回货物总览重新选择货品，或确认货物编号是否正确。</div>
    </div>
  </section>
</template>

<style scoped>
.goods-detail-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.goods-batch-actions {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr) 80px;
  gap: 8px;
}

.goods-threshold-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.goods-detail-preview {
  width: 100%;
  max-width: 180px;
  height: 180px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--admin-line);
}

.device-detail-status__item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.panel-focus,
.panel-focus-section .admin-panel {
  border-color: rgba(37, 99, 235, 0.4);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.08);
}

@media (max-width: 960px) {
  .goods-detail-form,
  .goods-batch-actions {
    grid-template-columns: 1fr;
  }
}
</style>
