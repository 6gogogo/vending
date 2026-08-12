<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type {
  RegistrationApplicationProfile,
  RegionRecord,
  UserRole
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { createAppLoginContinuation } from "../../utils/app-login-continuation";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const profileCopy = appCopy.unifiedAuth.profile;
const saving = ref(false);
const initialized = ref(false);
const regions = ref<RegionRecord[]>([]);
const selectedRegionIndex = ref(-1);
const selectedRole = ref<UserRole>();
const form = reactive<RegistrationApplicationProfile>({
  name: "",
  neighborhood: "",
  regionId: "",
  regionName: "",
  note: "",
  merchantName: "",
  contactName: "",
  address: ""
});

const isImported = computed(() => Boolean(sessionStore.draft?.linkedUserId));
const role = computed<UserRole | undefined>(() =>
  isImported.value ? sessionStore.draft?.requestedRole : selectedRole.value
);
const roleLabel = computed(() =>
  role.value === "merchant" ? profileCopy.merchantRole : profileCopy.specialRole
);
const activeRegions = computed(() => regions.value.filter((entry) => entry.status === "active"));
const regionLabel = computed(() =>
  isImported.value
    ? form.regionName || form.neighborhood || profileCopy.unset
    : activeRegions.value[selectedRegionIndex.value]?.name || profileCopy.regionPlaceholder
);

const { continueApprovedLogin } = createAppLoginContinuation({
  getPickupTarget: () => sessionStore.pickupTarget,
  consumePickupTarget: () => sessionStore.consumePickupTarget(),
  bootstrapSession: () => sessionStore.bootstrap().then(() => undefined),
  getSessionRole: () => sessionStore.user?.role,
  setSession: (session) => sessionStore.setSession(session),
  redirectTo: (url) => uni.redirectTo({ url }),
  routeRoleHome: (userRole) => {
    syncRoleTabBar(userRole);
    uni.switchTab({ url: resolveHomePath(userRole) });
  }
});

const syncForm = () => {
  const source = sessionStore.profileDraft;
  form.name = source?.name ?? "";
  form.neighborhood = source?.neighborhood ?? "";
  form.regionId = source?.regionId ?? "";
  form.regionName = source?.regionName ?? source?.neighborhood ?? "";
  form.note = source?.note ?? "";
  form.merchantName = source?.merchantName ?? "";
  form.contactName = source?.contactName ?? "";
  form.address = source?.address ?? "";

  const matchIndex = activeRegions.value.findIndex(
    (entry) => entry.id === form.regionId || entry.name === form.regionName
  );
  selectedRegionIndex.value = matchIndex;
  selectedRole.value = isImported.value ? undefined : sessionStore.draft?.requestedRole;
};

const syncSelectedRegion = () => {
  const selected = activeRegions.value[selectedRegionIndex.value];
  form.regionId = selected?.id ?? "";
  form.regionName = selected?.name ?? "";
  form.neighborhood = selected?.name ?? "";
};

const changeRegion = (event: { detail?: { value?: string | number } }) => {
  selectedRegionIndex.value = Number(event.detail?.value ?? 0);
  syncSelectedRegion();
};

const selectRole = (nextRole: UserRole) => {
  selectedRole.value = nextRole;
};

const ensureDraft = async () => {
  await sessionStore.bootstrap();
  if (sessionStore.user) {
    continueApprovedLogin({
      state: "approved",
      token: sessionStore.token!,
      user: sessionStore.user,
      quota: sessionStore.quota
    });
    return;
  }
  if (sessionStore.application?.status === "pending") {
    uni.reLaunch({ url: "/pages/common/review-status" });
    return;
  }
  if (!sessionStore.draft) {
    uni.reLaunch({ url: "/pages/common/app-login" });
    return;
  }

  if (!initialized.value) {
    try {
      regions.value = await mobileApi.regions();
    } catch (error) {
      uni.showToast({ title: getErrorMessage(error), icon: "none" });
    }
    syncForm();
    initialized.value = true;
  }
};

const validate = () => {
  if (!form.name.trim()) throw new Error(profileCopy.validation.name);
  if (!role.value) throw new Error(profileCopy.validation.role);
  if (!form.regionId || !form.regionName) throw new Error(profileCopy.validation.region);
  if (role.value === "merchant") {
    if (!form.merchantName?.trim()) throw new Error(profileCopy.validation.merchantName);
    if (!form.contactName?.trim()) throw new Error(profileCopy.validation.contactName);
    if (!form.address?.trim()) throw new Error(profileCopy.validation.address);
  }
};

const submit = async () => {
  if (!sessionStore.draft || saving.value) return;
  try {
    validate();
  } catch (error) {
    uni.showToast({ title: getErrorMessage(error), icon: "none" });
    return;
  }

  saving.value = true;
  sessionStore.setProfileDraft({ ...form });
  try {
    const response = await mobileApi.submitMobileProfile({
      draftToken: sessionStore.draft.token,
      requestedRole: role.value!,
      profile: { ...form }
    });
    if (response.state === "approved") {
      continueApprovedLogin(response);
      return;
    }
    sessionStore.setDraft({
      draft: response.draft,
      application: response.application,
      profileDraft: response.application.profile
    });
    uni.reLaunch({ url: "/pages/common/review-status" });
  } catch (error) {
    uni.showToast({ title: getErrorMessage(error), icon: "none" });
  } finally {
    saving.value = false;
  }
};

onShow(() => {
  void ensureDraft();
});
</script>

<template>
  <view class="profile-page">
    <view class="page-header">
      <text>{{ isImported ? profileCopy.importedPageTitle : profileCopy.newPageTitle }}</text>
    </view>

    <view class="compact-hero">
      <image class="compact-hero__image" src="/static/auth/vm-auth-hero.png" mode="aspectFill" />
      <view class="compact-hero__copy">
        <text class="compact-hero__eyebrow">
          {{ isImported ? profileCopy.importedEyebrow : profileCopy.newEyebrow }}
        </text>
        <text class="compact-hero__title">
          {{ isImported ? profileCopy.importedHeroTitle : profileCopy.newHeroTitle }}
        </text>
      </view>
    </view>

    <view class="profile-card">
      <view class="verified-phone">
        <view>
          <text class="verified-phone__label">{{ profileCopy.verifiedPhone }}</text>
          <text class="verified-phone__value">{{ sessionStore.draft?.phone }}</text>
        </view>
        <text class="verified-phone__mark">{{ profileCopy.verified }}</text>
      </view>

      <view class="field-group">
        <text class="field-label">{{ profileCopy.nameLabel }}</text>
        <input v-model="form.name" class="text-input" maxlength="100" :placeholder="profileCopy.namePlaceholder" />
      </view>

      <view class="field-group">
        <text class="field-label">{{ profileCopy.roleLabel }}</text>
        <view v-if="isImported" class="readonly-value">
          <text>{{ roleLabel }}</text><text class="readonly-value__mark">{{ profileCopy.confirmed }}</text>
        </view>
        <view v-else class="segment-control">
          <button :class="{ active: role === 'special' }" @tap="selectRole('special')">{{ profileCopy.specialRole }}</button>
          <button :class="{ active: role === 'merchant' }" @tap="selectRole('merchant')">{{ profileCopy.merchantRole }}</button>
        </view>
      </view>

      <view class="field-group">
        <text class="field-label">{{ profileCopy.regionLabel }}</text>
        <view v-if="isImported" class="readonly-value">
          <text>{{ regionLabel }}</text><text class="readonly-value__mark">{{ profileCopy.confirmed }}</text>
        </view>
        <picker v-else :range="activeRegions" range-key="name" :value="Math.max(selectedRegionIndex, 0)" @change="changeRegion">
          <view class="picker-value">{{ regionLabel }}</view>
        </picker>
      </view>

      <template v-if="role === 'merchant'">
        <view class="field-group">
          <text class="field-label">{{ profileCopy.merchantNameLabel }}</text>
          <input v-model="form.merchantName" class="text-input" :placeholder="profileCopy.merchantNamePlaceholder" />
        </view>
        <view class="field-group">
          <text class="field-label">{{ profileCopy.contactNameLabel }}</text>
          <input v-model="form.contactName" class="text-input" :placeholder="profileCopy.contactNamePlaceholder" />
        </view>
        <view class="field-group">
          <text class="field-label">{{ profileCopy.addressLabel }}</text>
          <input v-model="form.address" class="text-input" :placeholder="profileCopy.addressPlaceholder" />
        </view>
      </template>

      <view v-if="!isImported" class="field-group">
        <text class="field-label">{{ profileCopy.noteLabel }}</text>
        <textarea v-model="form.note" class="text-area" maxlength="1000" :placeholder="profileCopy.notePlaceholder" />
      </view>

      <button class="primary-button" :loading="saving" :disabled="saving" @tap="submit">
        {{ isImported ? profileCopy.confirm : profileCopy.submitReview }}
      </button>
    </view>
  </view>
</template>

<style scoped>
.profile-page {
  box-sizing: border-box;
  min-height: 100vh;
  padding: calc(env(safe-area-inset-top) + 28rpx) 24rpx calc(env(safe-area-inset-bottom) + 52rpx);
  background: #fffaf3;
  color: #191914;
}
.page-header { display: flex; align-items: center; justify-content: center; height: 92rpx; font-size: 46rpx; font-weight: 900; }
.compact-hero { position: relative; height: 290rpx; overflow: hidden; border: 2rpx solid #c4dcc6; border-radius: 42rpx; }
.compact-hero__image { width: 100%; height: 100%; }
.compact-hero__copy { position: absolute; left: 42rpx; top: 62rpx; display: flex; flex-direction: column; gap: 10rpx; }
.compact-hero__eyebrow { color: #24854a; font-size: 29rpx; font-weight: 800; }
.compact-hero__title { font-size: 44rpx; font-weight: 900; }
.profile-card { position: relative; display: flex; flex-direction: column; gap: 32rpx; margin-top: 22rpx; padding: 38rpx; border: 2rpx solid #d6e2d2; border-radius: 42rpx; background: rgba(255,255,255,.97); box-shadow: 0 24rpx 54rpx rgba(82,65,42,.1); }
.verified-phone { display: flex; align-items: center; justify-content: space-between; min-height: 106rpx; padding: 18rpx 24rpx; border: 2rpx solid #c5ddc7; border-radius: 28rpx; background: #eff8ed; }
.verified-phone > view { display: flex; flex-direction: column; gap: 7rpx; }
.verified-phone__label { color: #756d64; font-size: 24rpx; font-weight: 700; }
.verified-phone__value { font-size: 32rpx; font-weight: 800; }
.verified-phone__mark { color: #176638; font-size: 25rpx; font-weight: 800; }
.field-group { display: flex; flex-direction: column; gap: 15rpx; }
.field-label { font-size: 32rpx; font-weight: 800; }
.text-input, .picker-value, .readonly-value { box-sizing: border-box; width: 100%; min-height: 102rpx; padding: 0 26rpx; border: 3rpx solid #e5ddd1; border-radius: 28rpx; background: #ffffff; color: #191914; font-size: 31rpx; font-weight: 600; }
.picker-value, .readonly-value { display: flex; align-items: center; }
.readonly-value { justify-content: space-between; border-color: #c8ddc9; background: #eff7ed; font-weight: 800; }
.readonly-value__mark { color: #176638; font-size: 25rpx; font-weight: 800; }
.segment-control { display: grid; grid-template-columns: 1fr 1fr; gap: 16rpx; }
.segment-control button { min-height: 94rpx; margin: 0; border: 2rpx solid #e5ddd1; border-radius: 26rpx; background: #ffffff; color: #756d64; font-size: 30rpx; font-weight: 800; }
.segment-control button.active { border-color: #acd0b1; background: #e8f4e8; color: #176638; }
.text-area { box-sizing: border-box; width: 100%; min-height: 180rpx; padding: 24rpx 26rpx; border: 3rpx solid #e5ddd1; border-radius: 28rpx; background: #fff; font-size: 30rpx; line-height: 1.55; }
.primary-button { width: 100%; min-height: 106rpx; margin: 10rpx 0 0; border: 0; border-radius: 28rpx; background: #24854a; color: #fff; font-size: 36rpx; line-height: 106rpx; font-weight: 900; box-shadow: 0 18rpx 36rpx rgba(28,113,59,.18); }
</style>
