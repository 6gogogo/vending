<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { DeviceRecord, MerchantGoodsTemplate } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const templates = ref<MerchantGoodsTemplate[]>([]);
const devices = ref<DeviceRecord[]>([]);
const selectedTemplateId = ref("");
const selectedDeviceCode = ref("");
const templateKeyword = ref("");
const quantity = ref(0);
const productionDate = ref(new Date().toISOString().slice(0, 10));
const batchNo = ref("");
const note = ref("");
const submitting = ref(false);
const presetDeviceCode = ref("");

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
const restockFlowSteps = computed(() => [
  {
    label: "选择物品",
    description: selectedTemplate.value?.goodsName ?? "先选择要补货的商品模板",
    state: selectedTemplateId.value ? ("done" as const) : ("current" as const)
  },
  {
    label: "填写批次",
    description: selectedDevice.value ? `${selectedDevice.value.name} · ${quantity.value || 0} 件` : "填写柜机、数量、日期和批次号",
    state: selectedTemplateId.value && selectedDeviceCode.value && quantity.value > 0 ? ("current" as const) : ("todo" as const)
  },
  {
    label: "提交登记",
    description: estimatedExpireDate.value ? `预计到期 ${estimatedExpireDate.value}` : "提交后生成可追溯批次",
    state: "todo" as const
  }
]);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

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
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
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
  if (!selectedTemplateId.value || !selectedDeviceCode.value) {
    uni.showToast({
      title: "请选择模板和柜机",
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
      url: `/pages/common/result?status=success&title=${encodeURIComponent("补货登记成功")}&detail=${encodeURIComponent("补货批次已写入系统，可在货物去向页查看剩余量和保质期。")}`
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
</script>

<template>
  <MobileShell eyebrow="补货登记" title="登记补货" subtitle="选择柜机、商品、数量、生产日期和批次号。">
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button vm-button--warning" @tap="submit" :loading="submitting">提交补货登记</button>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/templates')">后端商品模板</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <FlowSteps :steps="restockFlowSteps" />

        <view class="selected-product-card">
          <MenuIcon name="box" size="lg" tone="accent" />
          <view class="selected-product-card__main">
            <text class="selected-product-card__title">{{ selectedTemplate?.goodsName ?? "请选择补货物品" }}</text>
            <text class="selected-product-card__meta">
              {{ selectedTemplate ? `${selectedTemplateCategoryLabel} · 默认 ${selectedTemplate.defaultQuantity} 件 · 保质期 ${selectedTemplate.defaultShelfLifeDays} 天` : "选择后会自动带出默认数量和保质期。" }}
            </text>
          </view>
          <text class="vm-status" :class="selectedTemplate ? 'vm-status--success' : 'vm-status--pending'">
            {{ selectedTemplate ? "已选中" : "待选择" }}
          </text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">选择货品模板</text>
          <text class="vm-subtitle">优先搜索商品名，选中后自动带入数量和保质期。</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">搜索商品名称</text>
          <input v-model="templateKeyword" class="vm-field__input" placeholder="输入名称、编号、分类或规格" />
        </view>

        <view class="template-list">
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

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">补货明细</text>
          <text class="vm-subtitle">请确认柜机、数量和生产日期后再提交。</text>
        </view>

        <view class="overview-grid">
          <ServiceMetric label="默认件数" :value="selectedTemplate?.defaultQuantity ?? 0" hint="选中模板后自动带入" tone="accent" />
          <ServiceMetric label="保质期" :value="selectedTemplate?.defaultShelfLifeDays ?? 0" hint="单位为天" />
          <ServiceMetric label="预计到期" :value="estimatedExpireDate || '-'" hint="按生产日期自动推导" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">补货柜机</text>
          <picker
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
          <text class="vm-field__label">补货数量</text>
          <view class="quantity-stepper">
            <button class="quantity-stepper__button" @tap="adjustQuantity(-1)">-</button>
            <input v-model.number="quantity" class="quantity-stepper__input" type="number" placeholder="0" />
            <button class="quantity-stepper__button" @tap="adjustQuantity(1)">+</button>
            <text class="quantity-stepper__unit">件</text>
          </view>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">生产日期</text>
          <picker mode="date" :value="productionDate" @change="productionDate = $event.detail.value">
            <view class="vm-field__input picker-value">{{ productionDate || "请选择生产日期" }}</view>
          </picker>
        </view>

        <view class="restock-field-grid">
          <view class="vm-field">
            <text class="vm-field__label">批次号（选填）</text>
            <input v-model="batchNo" class="vm-field__input" placeholder="例如：20240519001" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">备注（选填）</text>
            <input v-model="note" class="vm-field__input" placeholder="例如：上午批次、临期处理补投" />
          </view>
        </view>

        <view class="summary-panel">
          <text class="summary-panel__title">提交前确认</text>
          <text class="summary-panel__body">模板：{{ selectedTemplate?.goodsName ?? "未选择" }}</text>
          <text class="summary-panel__body">柜机：{{ selectedDevice?.name ?? "未选择" }}</text>
          <text class="summary-panel__body">数量：{{ quantity || 0 }} 件</text>
          <text class="summary-panel__body">批次号：{{ batchNo || "系统生成" }}</text>
          <text class="summary-panel__body">预计到期：{{ estimatedExpireDate || "等待计算" }}</text>
        </view>

        <view class="action-grid">
          <button class="vm-button vm-button--warning" :loading="submitting" @tap="submit">提交补货登记</button>
          <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/templates')">查看后端模板</button>
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

.template-item,
.summary-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
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
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
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
  min-height: 92rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: #ffffff;
}

.quantity-stepper__button {
  width: 88rpx;
  min-height: 92rpx;
  color: var(--vm-accent-strong);
  background: var(--vm-accent-soft);
  font-size: 34rpx;
  font-weight: 800;
}

.quantity-stepper__input {
  width: 100%;
  min-height: 92rpx;
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

