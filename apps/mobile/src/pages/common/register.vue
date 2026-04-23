<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { RegistrationApplicationProfile, RegistrationPhoneLookup, RegionRecord, UserRole } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import { useSmsCooldown } from "../../composables/useSmsCooldown";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";

const sessionStore = useSessionStore();
const phone = ref("");
const code = ref("");
const previewCode = ref("");
const requestedRole = ref<UserRole>("special");
const sendingCode = ref(false);
const submitting = ref(false);
const lookupBusy = ref(false);
const regions = ref<RegionRecord[]>([]);
const selectedRegionId = ref("");
const lookup = ref<RegistrationPhoneLookup>();
const lastLookupPhone = ref("");
const { remainingSeconds, isCoolingDown, startCooldown } = useSmsCooldown(60);

const form = reactive<RegistrationApplicationProfile>({
  name: "",
  neighborhood: "",
  regionId: "",
  regionName: "",
  note: "",
  merchantName: "",
  contactName: "",
  address: "",
  organization: "",
  title: ""
});

const roleOptions = [
  { value: "special" as const, label: "普通用户" },
  { value: "merchant" as const, label: "爱心商户" },
  { value: "admin" as const, label: "管理员" }
];

const activeRegions = computed(() => regions.value.filter((item) => item.status === "active"));
const regionOptions = computed(() =>
  activeRegions.value.map((item) => ({
    value: item.id,
    label: item.name
  }))
);

const fixedRole = computed(() => lookup.value?.fixedRole);
const effectiveRole = computed<UserRole>(() => fixedRole.value ?? requestedRole.value);
const isApprovedPhone = computed(() => lookup.value?.state === "approved");
const hasPendingDraft = computed(
  () => lookup.value?.state === "pending" || lookup.value?.state === "rejected"
);
const helperMessage = computed(() => lookup.value?.message ?? "");
const selectedRoleIndex = computed(() =>
  Math.max(
    0,
    roleOptions.findIndex((item) => item.value === effectiveRole.value)
  )
);
const selectedRegionLabel = computed(
  () => regionOptions.value.find((item) => item.value === selectedRegionId.value)?.label ?? "请选择区域"
);
const phoneValid = computed(() => /^1\d{10}$/.test(phone.value.trim()));
const sendCodeLabel = computed(() =>
  isCoolingDown.value ? `${remainingSeconds.value}s 后重发` : "获取验证码"
);

const applyProfile = (profile?: RegistrationApplicationProfile) => {
  form.name = profile?.name ?? "";
  form.note = profile?.note ?? "";
  form.merchantName = profile?.merchantName ?? "";
  form.contactName = profile?.contactName ?? "";
  form.address = profile?.address ?? "";
  form.organization = profile?.organization ?? "";
  form.title = profile?.title ?? "";

  const regionId = profile?.regionId ?? "";
  const regionName = profile?.regionName ?? profile?.neighborhood ?? "";
  const matched = regionId
    ? activeRegions.value.find((item) => item.id === regionId)
    : activeRegions.value.find((item) => item.name === regionName);

  if (matched) {
    selectedRegionId.value = matched.id;
    form.regionId = matched.id;
    form.regionName = matched.name;
    form.neighborhood = matched.name;
    return;
  }

  selectedRegionId.value = "";
  form.regionId = "";
  form.regionName = "";
  form.neighborhood = "";
};

const syncRegionFields = () => {
  const matched = activeRegions.value.find((item) => item.id === selectedRegionId.value);
  form.regionId = matched?.id ?? "";
  form.regionName = matched?.name ?? "";
  form.neighborhood = matched?.name ?? "";
};

const loadRegions = async () => {
  regions.value = await mobileApi.regions();
  syncRegionFields();
};

const queryPhone = async () => {
  const normalizedPhone = phone.value.trim();

  if (!/^1\d{10}$/.test(normalizedPhone) || normalizedPhone === lastLookupPhone.value) {
    return;
  }

  lookupBusy.value = true;
  try {
    const response = await mobileApi.registrationLookup(normalizedPhone);
    lookup.value = response;
    lastLookupPhone.value = normalizedPhone;

    if (response.fixedRole) {
      requestedRole.value = response.fixedRole;
    }

    applyProfile(response.profile);
  } catch (error) {
    showOperationFailure(error);
  } finally {
    lookupBusy.value = false;
  }
};

const sendCode = async () => {
  if (!phoneValid.value) {
    showOperationFailure(new Error("请输入 11 位手机号"));
    return;
  }

  if (isCoolingDown.value) {
    showOperationFailure(new Error(`请在 ${remainingSeconds.value}s 后重试`));
    return;
  }

  sendingCode.value = true;
  try {
    const response = await mobileApi.requestCode(phone.value.trim(), "register");
    previewCode.value = response.previewCode ?? "";
    startCooldown();
    showOperationSuccess();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    sendingCode.value = false;
  }
};

const validateForm = () => {
  syncRegionFields();

  if (!phoneValid.value) {
    throw new Error("请输入 11 位手机号");
  }

  if (code.value.trim().length < 4) {
    throw new Error("请输入验证码");
  }

  if (!form.name.trim()) {
    throw new Error("请输入姓名");
  }

  if (!form.regionName?.trim()) {
    throw new Error("请选择区域");
  }

  if (!form.regionId) {
    throw new Error("请选择已配置区域");
  }

  if (effectiveRole.value === "merchant") {
    if (!form.merchantName?.trim()) {
      throw new Error("请输入商户名称");
    }

    if (!form.contactName?.trim()) {
      throw new Error("请输入联系人姓名");
    }

    if (!form.address?.trim()) {
      throw new Error("请输入经营地址");
    }
  }

  if (effectiveRole.value === "admin") {
    if (!form.organization?.trim()) {
      throw new Error("请输入所属单位");
    }

    if (!form.title?.trim()) {
      throw new Error("请输入职务");
    }
  }
};

const submit = async () => {
  if (isApprovedPhone.value) {
    showOperationFailure(new Error("该手机号已审核通过，请直接登录"));
    return;
  }

  try {
    validateForm();
  } catch (error) {
    showOperationFailure(error);
    return;
  }

  submitting.value = true;
  try {
    const payload = {
      phone: phone.value.trim(),
      code: code.value.trim(),
      requestedRole: effectiveRole.value,
      profile: {
        ...form,
        name: form.name.trim(),
        note: form.note?.trim(),
        merchantName: form.merchantName?.trim(),
        contactName: form.contactName?.trim(),
        address: form.address?.trim(),
        organization: form.organization?.trim(),
        title: form.title?.trim()
      }
    };

    const response =
      hasPendingDraft.value && lookup.value?.application
        ? await mobileApi.updateRegistration(lookup.value.application.id, payload)
        : await mobileApi.submitRegistration(payload);

    if (response.status === "approved") {
      showOperationSuccess();
      uni.redirectTo({
        url: `/pages/common/app-login?phone=${encodeURIComponent(phone.value.trim())}`
      });
      return;
    }

    sessionStore.setApplication(response);
    sessionStore.setProfileDraft({ ...payload.profile });
    showOperationSuccess();
    uni.redirectTo({
      url: `/pages/common/review-status?phone=${encodeURIComponent(phone.value.trim())}`
    });
  } catch (error) {
    showOperationFailure(error);
  } finally {
    submitting.value = false;
  }
};

const goLogin = () => {
  uni.redirectTo({
    url: `/pages/common/app-login?phone=${encodeURIComponent(phone.value.trim())}`
  });
};

watch(
  () => phone.value.trim(),
  (value) => {
    if (value.length < 11) {
      lookup.value = undefined;
      lastLookupPhone.value = "";
    }

    if (/^1\d{10}$/.test(value) && value !== lastLookupPhone.value) {
      queryPhone();
    }
  }
);

watch(
  () => selectedRegionId.value,
  () => {
    syncRegionFields();
  }
);

onLoad(async (query) => {
  await loadRegions();

  if (typeof query.phone === "string" && query.phone) {
    phone.value = query.phone;
    await queryPhone();
  }
});
</script>

<template>
  <MobileShell eyebrow="注册" title="注册并提交审核" subtitle="手机号与验证码放在最前面，信息会按手机号覆盖更新；已存在待审资料时会自动回填。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="vm-field">
          <text class="vm-field__label">手机号</text>
          <input
            v-model="phone"
            class="vm-field__input"
            type="number"
            maxlength="11"
            placeholder="请输入 11 位手机号"
          />
        </view>

        <view class="vm-field">
          <view class="field-header">
            <text class="vm-field__label">验证码</text>
            <text class="vm-field__helper">提交时必填</text>
          </view>
          <input
            v-model="code"
            class="vm-field__input"
            type="number"
            maxlength="6"
            placeholder="请输入验证码"
          />
        </view>

        <view class="action-row">
          <button
            class="vm-button vm-button--ghost"
            :disabled="sendingCode || isCoolingDown"
            :loading="sendingCode"
            @tap="sendCode"
          >
            {{ sendCodeLabel }}
          </button>
        </view>

        <view v-if="previewCode" class="debug-box">
          <text class="debug-box__label">当前验证码</text>
          <text class="vm-number">{{ previewCode }}</text>
        </view>

        <view v-if="helperMessage" class="status-box">
          <text class="status-box__value">{{ helperMessage }}</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">身份</text>
          <picker :range="roleOptions" range-key="label" :value="selectedRoleIndex" @change="requestedRole = roleOptions[$event.detail.value]?.value ?? 'special'">
            <view class="vm-field__input picker-value">
              {{ roleOptions[selectedRoleIndex]?.label ?? "普通用户" }}
            </view>
          </picker>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">{{ effectiveRole === "merchant" ? "联系人姓名" : "姓名" }}</text>
          <input v-model="form.name" class="vm-field__input" placeholder="请输入姓名" />
        </view>

        <view class="vm-field">
          <text class="vm-field__label">区域</text>
          <picker :range="regionOptions" range-key="label" :value="Math.max(0, regionOptions.findIndex((item) => item.value === selectedRegionId))" @change="selectedRegionId = regionOptions[$event.detail.value]?.value ?? ''">
            <view class="vm-field__input picker-value">
              {{ selectedRegionLabel }}
            </view>
          </picker>
        </view>

        <template v-if="effectiveRole === 'merchant'">
          <view class="vm-field">
            <text class="vm-field__label">商户名称</text>
            <input v-model="form.merchantName" class="vm-field__input" placeholder="请输入商户名称" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">联系人姓名</text>
            <input v-model="form.contactName" class="vm-field__input" placeholder="请输入联系人姓名" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">经营地址</text>
            <input v-model="form.address" class="vm-field__input" placeholder="请输入经营地址" />
          </view>
        </template>

        <template v-if="effectiveRole === 'admin'">
          <view class="vm-field">
            <text class="vm-field__label">所属单位</text>
            <input v-model="form.organization" class="vm-field__input" placeholder="请输入所属单位" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">职务</text>
            <input v-model="form.title" class="vm-field__input" placeholder="请输入职务" />
          </view>
        </template>

        <view class="vm-field">
          <text class="vm-field__label">备注（选填）</text>
          <textarea
            v-model="form.note"
            class="vm-textarea"
            maxlength="200"
            placeholder="补充说明身份信息或特殊情况"
          />
        </view>

        <button class="vm-button" :loading="submitting" @tap="submit">
          {{ hasPendingDraft ? "覆盖更新并重新提交" : "提交注册资料" }}
        </button>
        <button class="vm-button vm-button--ghost" @tap="goLogin">已有账号，直接登录</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.vm-field__helper,
.debug-box__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.action-row {
  display: grid;
  gap: 16rpx;
}

.picker-value {
  display: flex;
  align-items: center;
}
</style>
