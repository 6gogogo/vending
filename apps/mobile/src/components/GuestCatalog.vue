<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from "vue";
import type { PublicProduct } from "@vm/shared-types";

import { mobileApi } from "../api/mobile";
import { guestCopy as copy } from "../constants/guest-copy";
import MobileShell from "../layouts/MobileShell.vue";
import { resolveGuestPrimaryActionUrl } from "../utils/guest-pickup";
import { scanDeviceCode } from "../utils/scan-device";
import GlassCard from "./ui/GlassCard.vue";

const props = withDefaults(defineProps<{
  deviceCode?: string;
  scanned?: boolean;
  refreshKey?: number;
}>(), { deviceCode: "", scanned: false, refreshKey: 0 });
const products = ref<PublicProduct[]>([]);
const loading = ref(false);
const failed = ref(false);
const scanning = ref(false);
const brokenImages = reactive<Record<string, boolean>>({});
let latestRequest = 0;

const load = async () => {
  const request = ++latestRequest;
  loading.value = true;
  failed.value = false;
  products.value = [];
  try {
    const result = await mobileApi.listPublicProducts();
    if (request === latestRequest) products.value = result;
  } catch {
    if (request === latestRequest) failed.value = true;
  } finally {
    if (request === latestRequest) loading.value = false;
  }
};

const pickup = async (rescan = false) => {
  if (scanning.value) return;
  scanning.value = true;
  try {
    const url = await resolveGuestPrimaryActionUrl(rescan ? {} : props, scanDeviceCode);
    if (url) uni.navigateTo({ url });
  } catch {
    uni.showToast({ title: copy.scanFailed, icon: "none" });
  } finally {
    scanning.value = false;
  }
};
watch(() => props.refreshKey, () => { void load(); }, { immediate: true });
onBeforeUnmount(() => { latestRequest += 1; });
</script>

<template>
  <MobileShell class="guest-storefront" mode="care" eyebrow="小柜大爱" :title="copy.title"
    :subtitle="scanned && deviceCode ? `柜机编号 ${deviceCode}，开门需先登录。` : copy.subtitle">
    <GlassCard v-if="loading || failed || !products.length" tone="quiet">
      <text class="guest-message" :role="failed ? 'alert' : 'status'">
        {{ loading ? copy.loading : failed ? copy.failed : copy.emptyProducts }}
      </text>
      <button v-if="failed" class="vm-button vm-button--soft" @tap="load">{{ copy.refresh }}</button>
    </GlassCard>
    <view v-else class="guest-products">
      <view v-for="product in products" :key="product.goodsId" class="guest-product">
        <view class="guest-product__picture">
          <image v-if="product.imageUrl && !brokenImages[product.goodsId]" class="guest-product__image"
            :src="product.imageUrl" :alt="product.name" mode="aspectFit"
            @error="brokenImages[product.goodsId] = true" />
          <view v-else class="guest-product__placeholder">{{ copy.imageFallback }}</view>
        </view>
        <text class="guest-product__name">{{ product.name }}</text>
      </view>
    </view>
    <view class="guest-scanbar">
      <button class="vm-button guest-scanbar__button" :disabled="scanning" @tap="pickup()">
        {{ scanning ? copy.scanning : scanned && deviceCode ? '开门' : copy.scan }}
      </button>
      <button v-if="scanned && deviceCode" class="vm-button vm-button--ghost guest-rescan" :disabled="scanning" @tap="pickup(true)">重新扫码</button>
    </view>
  </MobileShell>
</template>

<style scoped>
.guest-storefront { padding-bottom: calc(240rpx + env(safe-area-inset-bottom)); }
.guest-message { display: block; color: var(--vm-muted); font-size: 28rpx; line-height: 1.6; }
.guest-products { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24rpx; }
.guest-product { overflow: hidden; border: 1rpx solid var(--vm-line); border-radius: 24rpx; background: var(--vm-surface); }
.guest-product__picture { position: relative; width: 100%; padding-bottom: 100%; background: #fff; }
.guest-product__image, .guest-product__placeholder { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.guest-product__placeholder { display: flex; align-items: center; justify-content: center; color: var(--vm-muted); font-size: 28rpx; background: var(--vm-bg-soft); }
.guest-product__name { display: block; min-height: 3em; padding: 20rpx; color: var(--vm-text); font-size: 29rpx; font-weight: 600; line-height: 1.5; word-break: break-word; }
.guest-scanbar { position: fixed; z-index: 40; left: 50%; bottom: 0; width: 100%; max-width: 960rpx; box-sizing: border-box; padding: 20rpx 28rpx calc(20rpx + env(safe-area-inset-bottom)); transform: translateX(-50%); border-top: 1rpx solid rgba(46,125,70,.12); background: rgba(255,255,255,.98); box-shadow: 0 -10rpx 30rpx rgba(26,51,33,.07); }
.guest-scanbar__button { min-height: 100rpx; margin: 0; font-size: 34rpx; font-weight: 700; }
.guest-rescan { margin-top: 12rpx; min-height: 60rpx; padding: 8rpx; font-size: 26rpx; }
</style>
