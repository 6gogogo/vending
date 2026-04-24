<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { DeviceRecord, MerchantGoodsTemplate } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const templates = ref<MerchantGoodsTemplate[]>([]);
const devices = ref<DeviceRecord[]>([]);
const selectedTemplateId = ref("");
const selectedDeviceCode = ref("");
const quantity = ref(0);
const productionDate = ref(new Date().toISOString().slice(0, 10));
const note = ref("");
const submitting = ref(false);
const presetDeviceCode = ref("");

const selectedTemplate = computed(() =>
  templates.value.find((entry) => entry.id === selectedTemplateId.value)
);

const selectedDevice = computed(() =>
  devices.value.find((entry) => entry.deviceCode === selectedDeviceCode.value)
);

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

const submit = async () => {
  if (!selectedTemplateId.value || !selectedDeviceCode.value) {
    uni.showToast({
      title: "请选择模板和柜机",
      icon: "none"
    });
    return;
  }

  submitting.value = true;
  try {
    await mobileApi.createMerchantRestock({
      templateId: selectedTemplateId.value,
      deviceCode: selectedDeviceCode.value,
      quantity: quantity.value,
      productionDate: productionDate.value,
      note: note.value || undefined
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
  <MobileShell eyebrow="按模板补货" title="登记补货" subtitle="选择柜机、模板、数量和生产日期，系统会自动推导保质期。">
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" @tap="submit" :loading="submitting">提交补货登记</button>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/merchant/templates')">后端商品模板</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">选择货品模板</text>
          <text class="vm-subtitle">请先选择后端公共模板，数量和保质期会自动带入。</text>
        </view>

        <view class="template-list">
          <button
            v-for="item in templates"
            :key="item.id"
            class="template-item"
            :class="{ 'template-item--active': selectedTemplateId === item.id }"
            @tap="selectTemplate(item)"
          >
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

    <GlassCard tone="quiet">
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
          <input v-model.number="quantity" class="vm-field__input" type="number" placeholder="请输入本次补货件数" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">生产日期</text>
          <picker mode="date" :value="productionDate" @change="productionDate = $event.detail.value">
            <view class="vm-field__input picker-value">{{ productionDate || "请选择生产日期" }}</view>
          </picker>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">备注（选填）</text>
          <input v-model="note" class="vm-field__input" placeholder="例如：上午批次、临期处理补投" />
        </view>

        <view class="summary-panel">
          <text class="summary-panel__title">提交前确认</text>
          <text class="summary-panel__body">模板：{{ selectedTemplate?.goodsName ?? "未选择" }}</text>
          <text class="summary-panel__body">柜机：{{ selectedDevice?.name ?? "未选择" }}</text>
          <text class="summary-panel__body">数量：{{ quantity || 0 }} 件</text>
          <text class="summary-panel__body">预计到期：{{ estimatedExpireDate || "等待计算" }}</text>
        </view>

        <view class="action-grid">
          <button class="vm-button" :loading="submitting" @tap="submit">提交补货登记</button>
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
.action-grid {
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

.picker-value {
  display: flex;
  align-items: center;
}

.summary-panel {
  display: grid;
  align-items: start;
}
</style>

