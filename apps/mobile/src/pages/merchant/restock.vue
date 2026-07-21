<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { DeviceRecord, MerchantGoodsTemplate } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { formatBeijingDate } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { syncNativeInputAccessibility } from "../../utils/native-input-accessibility";

const sessionStore = useSessionStore();
const templates = ref<MerchantGoodsTemplate[]>([]);
const devices = ref<DeviceRecord[]>([]);
const selectedTemplateId = ref("");
const selectedDeviceCode = ref("");
const templateKeyword = ref("");
const quantity = ref(0);
const productionDate = ref(formatBeijingDate(new Date()));
const batchNo = ref("");
const note = ref("");
const submitting = ref(false);
const presetDeviceCode = ref("");
const loading = ref(false);
const loadError = ref("");

const syncRestockInputAccessibility = async () => {
  await nextTick();
  syncNativeInputAccessibility("merchant-restock-quantity", {
    labelId: "merchant-restock-quantity-label",
    name: "quantity",
    min: 1,
    step: 1
  });
  syncNativeInputAccessibility("merchant-restock-batch", {
    labelId: "merchant-restock-batch-label",
    name: "batch-number"
  });
  syncNativeInputAccessibility("merchant-restock-note", {
    labelId: "merchant-restock-note-label",
    name: "restock-note"
  });
  syncNativeInputAccessibility("merchant-restock-search", {
    labelId: "merchant-restock-search-label",
    name: "template-search"
  });
};

const selectedTemplate = computed(() =>
  templates.value.find((entry) => entry.id === selectedTemplateId.value)
);

const selectedDevice = computed(() =>
  devices.value.find((entry) => entry.deviceCode === selectedDeviceCode.value)
);
const selectedTemplateCategoryLabel = computed(() =>
  selectedTemplate.value
    ? selectedTemplate.value.categoryName ?? categoryLabelMap[selectedTemplate.value.category]
    : ""
);
const filteredTemplates = computed(() => {
  const query = templateKeyword.value.trim().toLowerCase();

  if (!query) {
    return templates.value;
  }

  return templates.value.filter((entry) =>
    [entry.goodsName, entry.fullName, entry.goodsCode, entry.categoryName, entry.specification, entry.manufacturer]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
});

const estimatedExpireDate = computed(() => {
  const shelfLifeDays = selectedTemplate.value?.defaultShelfLifeDays;

  if (!shelfLifeDays || !productionDate.value) {
    return "";
  }

  const date = new Date(`${productionDate.value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  date.setDate(date.getDate() + shelfLifeDays);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
});
const estimatedExpireShort = computed(() => estimatedExpireDate.value.slice(5) || "-");
const estimatedExpireHint = computed(() =>
  estimatedExpireDate.value ? `${estimatedExpireDate.value.slice(0, 4)} 年 · 自动推导` : "按生产日期自动推导"
);
const restockFlowSteps = computed(() => [
  {
    label: "选择物品",
    description: selectedTemplate.value ? "已选常用商品" : "先选常用商品",
    state: selectedTemplateId.value ? ("done" as const) : ("current" as const)
  },
  {
    label: "填写批次",
    description: selectedDevice.value ? `${quantity.value || 0} 件 / ${selectedDevice.value.deviceCode}` : "柜机、数量、日期",
    state: selectedTemplateId.value && selectedDeviceCode.value && quantity.value > 0 ? ("current" as const) : ("todo" as const)
  },
  {
    label: "提交登记",
    description: estimatedExpireDate.value ? "确认后生成" : "提交后可追溯",
    state: "todo" as const
  }
]);

const load = async () => {
  if (loading.value) {
    return;
  }

  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  loadError.value = "";
  try {
    const [templateResponse, deviceResponse] = await Promise.all([
      mobileApi.merchantTemplates(),
      mobileApi.listDevices()
    ]);

    templates.value = templateResponse.filter((entry) => entry.status === "active");
    devices.value = deviceResponse;
    selectedTemplateId.value = selectedTemplate.value?.id ?? templates.value[0]?.id ?? "";
    selectedDeviceCode.value =
      devices.value.find((entry) => entry.deviceCode === presetDeviceCode.value)?.deviceCode ??
      selectedDevice.value?.deviceCode ??
      devices.value[0]?.deviceCode ??
      "";
    quantity.value = selectedTemplate.value?.defaultQuantity ?? templates.value[0]?.defaultQuantity ?? 0;
  } catch (error) {
    loadError.value = getErrorMessage(error);
    uni.showToast({
      title: loadError.value,
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const selectTemplate = (template: MerchantGoodsTemplate) => {
  selectedTemplateId.value = template.id;
  quantity.value = template.defaultQuantity;
};

const adjustQuantity = (delta: number) => {
  quantity.value = Math.max(0, Number(quantity.value || 0) + delta);
};

const submit = async () => {
  if (loadError.value) {
    uni.showToast({
      title: "请先重新加载柜机和商品数据",
      icon: "none"
    });
    return;
  }

  if (!selectedTemplateId.value || !selectedDeviceCode.value) {
    uni.showToast({
      title: "请选择常用商品和柜机",
      icon: "none"
    });
    return;
  }

  if (Number(quantity.value) <= 0) {
    uni.showToast({
      title: "补货数量必须大于 0",
      icon: "none"
    });
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "确认补货登记",
      content: `请确认向 ${selectedDevice.value?.name ?? selectedDeviceCode.value} 补充 ${selectedTemplate.value?.goodsName ?? "货品"} x${quantity.value}，预计到期 ${estimatedExpireDate.value || "未设置"}。提交后会生成可追溯批次。`,
      confirmText: "确认补货",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  submitting.value = true;
  try {
    await mobileApi.createMerchantRestock({
      templateId: selectedTemplateId.value,
      deviceCode: selectedDeviceCode.value,
      quantity: quantity.value,
      productionDate: productionDate.value,
      note: [batchNo.value ? `批次号：${batchNo.value.trim()}` : "", note.value.trim()].filter(Boolean).join("；") || undefined,
      confirmed: true
    });

    uni.reLaunch({
      url: `/pages/common/result?status=success&title=${encodeURIComponent("补货登记成功")}&detail=${encodeURIComponent("补货批次已写入系统，可在货品去向页查看剩余量和保质期。")}`
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    submitting.value = false;
  }
};

const navigate = (url: string) => {
  uni.navigateTo({ url });
};

onShow(() => {
  load();
});

onLoad((query) => {
  if (typeof query.deviceCode === "string" && query.deviceCode) {
    presetDeviceCode.value = query.deviceCode;
  }
});

onMounted(() => {
  void syncRestockInputAccessibility();
});
</script>

<template>
  <MobileShell eyebrow="补货登记" title="登记补货" subtitle="选择柜机、常用商品、数量、生产日期和批次号。">
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" :disabled="loading || Boolean(loadError)" @tap="submit" :loading="submitting">提交补货登记</button>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/templates')">常用商品</button>
      </view>
    </template>

    <GlassCard v-if="loadError" tone="warning">
      <view class="vm-stack">
        <EmptyState title="补货数据加载失败" :description="loadError" />
        <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">
          重新加载
        </button>
      </view>
    </GlassCard>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <FlowSteps :steps="restockFlowSteps" />

        <view class="selected-product-card">
          <MenuIcon name="box" size="lg" tone="accent" />
          <view class="selected-product-card__main">
            <text class="selected-product-card__title">{{ selectedTemplate?.goodsName ?? "请选择补货商品" }}</text>
            <text class="selected-product-card__meta">
              {{ selectedTemplate ? `${selectedTemplateCategoryLabel} · 默认 ${selectedTemplate.defaultQuantity} 件 · 保质期 ${selectedTemplate.defaultShelfLifeDays} 天` : "先维护常用商品，选择后会自动带出默认数量和保质期。" }}
            </text>
          </view>
          <text class="vm-status" :class="selectedTemplate ? 'vm-status--success' : 'vm-status--pending'">
            {{ selectedTemplate ? "已选中" : "待选择" }}
          </text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">补货明细</text>
          <text class="vm-subtitle">请确认柜机、数量和生产日期后再提交。</text>
        </view>

        <view class="overview-grid">
          <ServiceMetric label="默认件数" :value="selectedTemplate?.defaultQuantity ?? 0" hint="选中常用商品后自动带入" tone="accent" />
          <ServiceMetric label="保质期" :value="selectedTemplate?.defaultShelfLifeDays ?? 0" hint="单位为天" />
          <ServiceMetric label="预计到期" :value="estimatedExpireShort" :hint="estimatedExpireHint" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">补货柜机</text>
          <picker
            aria-label="选择补货柜机"
            :range="devices"
            range-key="name"
            :value="Math.max(devices.findIndex((item) => item.deviceCode === selectedDeviceCode), 0)"
            @change="selectedDeviceCode = devices[$event.detail.value]?.deviceCode ?? ''"
          >
            <view class="vm-field__input picker-value">
              {{ selectedDevice?.name ?? "请选择柜机" }}
            </view>
          </picker>
        </view>

        <view class="vm-field">
          <text id="merchant-restock-quantity-label" class="vm-field__label">补货数量</text>
          <view class="quantity-stepper">
            <button class="quantity-stepper__button" aria-label="减少补货数量" @tap="adjustQuantity(-1)">-</button>
            <input
              v-model.number="quantity"
              id="merchant-restock-quantity"
              name="quantity"
              aria-label="补货数量"
              class="quantity-stepper__input"
              type="number"
              min="1"
              step="1"
              placeholder="0"
            />
            <button class="quantity-stepper__button" aria-label="增加补货数量" @tap="adjustQuantity(1)">+</button>
            <text class="quantity-stepper__unit">件</text>
          </view>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">生产日期</text>
          <picker aria-label="选择生产日期" mode="date" :value="productionDate" @change="productionDate = $event.detail.value">
            <view class="vm-field__input picker-value">{{ productionDate || "请选择生产日期" }}</view>
          </picker>
        </view>

        <view class="restock-field-grid">
          <view class="vm-field">
            <text id="merchant-restock-batch-label" class="vm-field__label">批次号（选填）</text>
            <input
              v-model="batchNo"
              id="merchant-restock-batch"
              name="batch-number"
              aria-label="补货批次号"
              class="vm-field__input"
              placeholder="例如：20240519001"
            />
          </view>
          <view class="vm-field">
            <text id="merchant-restock-note-label" class="vm-field__label">备注（选填）</text>
            <input
              v-model="note"
              id="merchant-restock-note"
              name="restock-note"
              aria-label="补货备注"
              class="vm-field__input"
              placeholder="例如：上午批次、临期处理补投"
            />
          </view>
        </view>

        <view class="summary-panel">
          <text class="summary-panel__title">提交前确认</text>
          <text class="summary-panel__body">常用商品：{{ selectedTemplate?.goodsName ?? "未选择" }}</text>
          <text class="summary-panel__body">柜机：{{ selectedDevice?.name ?? "未选择" }}</text>
          <text class="summary-panel__body">数量：{{ quantity || 0 }} 件</text>
          <text class="summary-panel__body">批次号：{{ batchNo || "系统生成" }}</text>
          <text class="summary-panel__body">预计到期：{{ estimatedExpireDate || "等待计算" }}</text>
        </view>

        <view class="action-grid">
          <button class="vm-button" :disabled="loading || Boolean(loadError)" :loading="submitting" @tap="submit">提交补货登记</button>
          <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/templates')">维护常用商品</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">更换常用商品</text>
          <text class="vm-subtitle">常用商品会自动带入数量和保质期，需要调整时再从这里切换。</text>
        </view>

        <view class="vm-field">
          <text id="merchant-restock-search-label" class="vm-field__label">搜索常用商品</text>
          <input
            v-model="templateKeyword"
            id="merchant-restock-search"
            name="template-search"
            aria-label="搜索常用商品"
            class="vm-field__input"
            placeholder="输入名称、编号、分类或规格"
          />
        </view>

        <EmptyState
          v-if="!loadError && !filteredTemplates.length"
          title="暂无可选常用商品"
          description="请先维护常用商品，再回来登记本次补货。"
        />

        <view v-else-if="!loadError" class="template-list template-list--compact">
          <button
            v-for="item in filteredTemplates"
            :key="item.id"
            class="template-item"
            :class="{ 'template-item--active': selectedTemplateId === item.id }"
            @tap="selectTemplate(item)"
          >
            <MenuIcon :name="item.category === 'food' ? 'food' : item.category === 'daily' ? 'daily' : 'drink'" size="md" tone="accent" />
            <view class="template-item__main">
              <text class="template-item__title">{{ item.goodsName }}</text>
              <text class="template-item__meta">{{ item.defaultQuantity }} 件 · {{ item.defaultShelfLifeDays }} 天</text>
            </view>
            <text class="vm-status" :class="selectedTemplateId === item.id ? 'vm-status--online' : 'vm-status--muted'">
              {{ selectedTemplateId === item.id ? "已选中" : "可选" }}
            </text>
          </button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.template-item__main {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title,
.template-item__title,
.summary-panel__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.template-item__meta,
.summary-panel__body {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.hero-action-grid,
.overview-grid,
.template-list,
.action-grid,
.restock-field-grid {
  display: grid;
  gap: 16rpx;
}

.overview-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.hero-action-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.restock-field-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.template-list--compact {
  max-height: 520rpx;
  overflow: hidden;
}

.template-item,
.summary-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 20rpx 22rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.template-item--active {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
}

.selected-product-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18rpx;
  padding: 20rpx 22rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-success-line);
  background: rgba(255, 255, 255, 0.9);
}

.selected-product-card__main {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.selected-product-card__title {
  font-size: 30rpx;
  font-weight: 900;
  color: var(--vm-text);
}

.selected-product-card__meta {
  font-size: 22rpx;
  line-height: 1.55;
  color: var(--vm-text-soft);
}

.quantity-stepper {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  overflow: hidden;
  min-height: 88rpx;
  border-radius: 18rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: #ffffff;
}

.quantity-stepper__button {
  width: 88rpx;
  min-height: 88rpx;
  color: var(--vm-accent-strong);
  background: var(--vm-accent-soft);
  font-size: 34rpx;
  font-weight: 800;
}

.quantity-stepper__input {
  width: 100%;
  min-height: 88rpx;
  text-align: center;
  font-size: 32rpx;
  font-weight: 900;
  color: var(--vm-text);
}

.quantity-stepper__unit {
  padding-right: 24rpx;
  color: var(--vm-text-soft);
  font-size: 24rpx;
}

.picker-value {
  display: flex;
  align-items: center;
}

.summary-panel {
  display: grid;
  align-items: start;
}
</style>

