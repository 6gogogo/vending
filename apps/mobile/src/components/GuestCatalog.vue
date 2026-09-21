<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import type { PublicDevice } from "@vm/shared-types";

import { mobileApi } from "../api/mobile";
import { guestCopy as copy } from "../constants/guest-copy";
import MobileShell from "../layouts/MobileShell.vue";
import { buildDeviceQueryUrl, buildPickupLoginUrl, buildQueryLoginUrl } from "../utils/cabinet-entry";
import GlassCard from "./ui/GlassCard.vue";

const props = withDefaults(defineProps<{
  mode?: "home" | "nearby";
  deviceCode?: string;
  scanned?: boolean;
  refreshKey?: number;
}>(), { mode: "home", deviceCode: "", scanned: false, refreshKey: 0 });
const devices = ref<PublicDevice[]>([]);
const loading = ref(false);
const failed = ref(false);
const brokenImages = reactive<Record<string, boolean>>({});
let latestRequest = 0;
const isDetail = computed(() => Boolean(props.deviceCode));
const title = computed(() => isDetail.value ? devices.value[0]?.name ?? "柜机物资"
  : props.mode === "home" ? copy.title : copy.nearbyTitle);
const subtitle = computed(() => isDetail.value ? copy.detailSubtitle
  : props.mode === "home" ? copy.subtitle : copy.nearbySubtitle);

const load = async () => {
  const request = ++latestRequest;
  loading.value = true;
  failed.value = false;
  // 重新查询期间隐藏旧库存；失败时不把缓存数量当作实时数量。
  devices.value = [];
  try {
    const result = props.deviceCode
      ? [await mobileApi.getPublicDevice(props.deviceCode)]
      : await mobileApi.listPublicDevices();
    if (request === latestRequest) devices.value = result;
  } catch {
    if (request === latestRequest) failed.value = true;
  } finally {
    if (request === latestRequest) loading.value = false;
  }
};

const browse = () => uni.switchTab({ url: "/pages/tabs/nearby" });
const showDevice = (deviceCode: string) => uni.navigateTo({ url: buildDeviceQueryUrl(deviceCode) });
const login = () => uni.navigateTo({
  url: props.deviceCode
    ? props.scanned ? buildPickupLoginUrl(props.deviceCode) : buildQueryLoginUrl(props.deviceCode)
    : "/pages/common/app-login"
});
const help = () => uni.navigateTo({ url: "/pages/common/help-center" });
watch(() => [props.deviceCode, props.refreshKey], () => { void load(); }, { immediate: true });
onBeforeUnmount(() => { latestRequest += 1; });
</script>

<template>
  <MobileShell mode="care" :eyebrow="isDetail ? '柜机物资' : '公益服务'" :title="title" :subtitle="subtitle">
    <GlassCard v-if="!isDetail && mode === 'home'" tone="accent">
      <view class="vm-stack">
        <text class="guest-heading">{{ copy.serviceTitle }}</text>
        <text class="guest-body">{{ copy.serviceBody }}</text>
        <view v-for="(step, index) in copy.steps" :key="step" class="guest-step">
          <text class="guest-step__number">{{ index + 1 }}</text><text>{{ step }}</text>
        </view>
        <button class="vm-button" @tap="browse">{{ copy.browse }}</button>
      </view>
    </GlassCard>

    <view class="guest-toolbar">
      <text class="guest-heading">{{ isDetail ? '物资与库存' : copy.devices }}</text>
      <button class="vm-button vm-button--ghost guest-refresh" :disabled="loading" @tap="load">{{ copy.refresh }}</button>
    </view>
    <GlassCard v-if="loading || failed || !devices.length" tone="quiet">
      <text class="guest-body" :role="failed ? 'alert' : 'status'">
        {{ loading ? copy.loading : failed ? copy.failed : copy.emptyDevices }}
      </text>
      <button v-if="failed" class="vm-button vm-button--soft" @tap="load">{{ copy.refresh }}</button>
    </GlassCard>
    <GlassCard v-for="device in devices" :key="device.deviceCode" tone="quiet">
      <view class="vm-stack">
        <view class="guest-device-heading">
          <text class="guest-heading">{{ device.name }}</text>
          <text class="guest-status">{{ copy.status[device.status] }}</text>
        </view>
        <text class="guest-body">{{ device.address || device.location }}</text>
        <view v-for="door in device.doors" :key="door.doorNum" class="vm-stack">
          <text v-if="device.doors.length > 1" class="guest-door">{{ door.label }}</text>
          <text v-if="!door.goods.length" class="guest-body">{{ copy.emptyGoods }}</text>
          <view v-for="goods in door.goods" :key="goods.goodsId" class="guest-goods">
            <image v-if="goods.imageUrl && !brokenImages[goods.goodsId]" class="guest-goods__image"
              :src="goods.imageUrl" :alt="goods.name" mode="aspectFit"
              @error="brokenImages[goods.goodsId] = true" />
            <view v-else class="guest-goods__placeholder">{{ copy.imageFallback }}</view>
            <view class="guest-goods__body">
              <text class="guest-goods__name">{{ goods.name }}</text>
              <text class="guest-goods__stock" :class="{ 'guest-goods__stock--empty': goods.stock <= 0 }">
                {{ goods.status === 'inactive' ? copy.inactive : goods.stock > 0 ? copy.stock(goods.stock) : copy.emptyStock }}
              </text>
            </view>
          </view>
        </view>
        <button v-if="!isDetail" class="vm-button vm-button--soft" @tap="showDevice(device.deviceCode)">{{ copy.detail }}</button>
      </view>
    </GlassCard>
    <GlassCard tone="quiet">
      <view class="vm-stack">
        <button class="vm-button" @tap="login">{{ isDetail ? copy.pickupLogin : copy.login }}</button>
        <button class="vm-button vm-button--ghost" @tap="isDetail ? browse() : help()">{{ isDetail ? copy.browse : copy.help }}</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.guest-heading { font-size: 32rpx; font-weight: 700; color: var(--vm-text); }
.guest-body { display: block; font-size: 27rpx; line-height: 1.7; color: var(--vm-muted); }
.guest-step { display: flex; align-items: flex-start; gap: 16rpx; font-size: 28rpx; line-height: 1.6; }
.guest-step__number { flex-shrink: 0; width: 44rpx; text-align: center; border-radius: 50%; background: var(--vm-accent-soft); color: var(--vm-accent); font-weight: 700; }
.guest-toolbar, .guest-device-heading { display: flex; justify-content: space-between; align-items: center; gap: 20rpx; }
.guest-refresh { flex-shrink: 0; width: auto; margin: 0; padding: 12rpx 20rpx; min-height: 72rpx; font-size: 26rpx; }
.guest-status { flex-shrink: 0; font-size: 24rpx; color: var(--vm-muted); }
.guest-door { font-size: 26rpx; color: var(--vm-muted); }
.guest-goods { display: flex; align-items: center; gap: 20rpx; padding: 18rpx 0; border-top: 1rpx solid var(--vm-line); }
.guest-goods__image, .guest-goods__placeholder { flex-shrink: 0; width: 120rpx; height: 120rpx; border-radius: 20rpx; background: var(--vm-bg-soft); }
.guest-goods__placeholder { display: flex; align-items: center; justify-content: center; font-size: 23rpx; color: var(--vm-muted); }
.guest-goods__body { display: flex; flex-direction: column; gap: 12rpx; min-width: 0; }
.guest-goods__name { font-size: 29rpx; line-height: 1.5; font-weight: 600; }
.guest-goods__stock { font-size: 27rpx; color: var(--vm-accent-strong); }
.guest-goods__stock--empty { color: var(--vm-muted); }
</style>
