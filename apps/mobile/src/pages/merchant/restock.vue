<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { DeviceRecord, MerchantGoodsTemplate } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
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
    selectedTemplateId.value = templates.value[0]?.id ?? "";
    selectedDeviceCode.value =
      devices.value.find((entry) => entry.deviceCode === presetDeviceCode.value)?.deviceCode ??
      devices.value[0]?.deviceCode ??
      "";
    quantity.value = templates.value[0]?.defaultQuantity ?? 0;
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
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">选择货品模板</text>
          <text class="vm-subtitle">建议先维护模板，再按模板快速登记补货。</text>
        </view>
        <view class="template-list">
          <button
            v-for="item in templates"
            :key="item.id"
            class="template-item"
            :class="{ 'template-item--active': selectedTemplateId === item.id }"
            @tap="selectTemplate(item)"
          >
            <text class="template-item__title">{{ item.goodsName }}</text>
            <text class="template-item__meta">{{ item.defaultQuantity }} 件 · {{ item.defaultShelfLifeDays }} 天</text>
          </button>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">补货柜机</text>
          <picker :range="devices" range-key="name" @change="selectedDeviceCode = devices[$event.detail.value]?.deviceCode ?? ''">
            <view class="vm-field__input picker-value">
              {{ devices.find((item) => item.deviceCode === selectedDeviceCode)?.name ?? "请选择柜机" }}
            </view>
          </picker>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">补货数量</text>
          <input v-model.number="quantity" class="vm-field__input" type="number" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">生产日期</text>
          <input v-model="productionDate" class="vm-field__input" type="text" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">备注（选填）</text>
          <input v-model="note" class="vm-field__input" placeholder="例如：上午批次、临期处理补投" />
        </view>

        <button class="vm-button" :loading="submitting" @tap="submit">提交补货登记</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title,
.template-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.template-list {
  display: grid;
  gap: 16rpx;
}

.template-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  background: rgba(255, 252, 246, 0.88);
}

.template-item--active {
  border-color: rgba(47, 143, 102, 0.35);
  background: rgba(241, 251, 244, 0.98);
}

.template-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.picker-value {
  display: flex;
  align-items: center;
}
</style>
