<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { RegistrationApplicationProfile, RegistrationPhoneLookup, RegionRecord, UserRole } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
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
const showVerificationPreview =
  import.meta.env.DEV && import.meta.env.VITE_SHOW_VERIFICATION_PREVIEW === "true";

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

const enablePublicAdminRegistration =
  String(import.meta.env.VITE_ENABLE_PUBLIC_ADMIN_REGISTRATION ?? "")
    .trim()
    .toLowerCase() === "true";

const baseRoleOptions = [
  { value: "special" as const, label: "我是用户", description: "领取和使用服务", icon: "users" as const },
  { value: "merchant" as const, label: "我是商家", description: "补货与协作", icon: "restock" as const },
  { value: "admin" as const, label: "管理员", description: "用于审核巡检", icon: "review" as const }
];

const roleOptions = computed(() =>
  enablePublicAdminRegistration
    ? baseRoleOptions
    : baseRoleOptions.filter((item) => item.value !== "admin")
);

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
const selectedRegionLabel = computed(
  () => regionOptions.value.find((item) => item.value === selectedRegionId.value)?.label ?? "请选择区域"
);
const phoneValid = computed(() => /^1\d{10}$/.test(phone.value.trim()));
const registerSteps = computed(() => [
  {
    label: "提交资料",
    description: phoneValid.value ? "手机号已填写" : "先验证手机号",
    state: "current" as const
  },
  {
    label: "等待审核",
    description: hasPendingDraft.value ? "已有待审资料" : "工作人员处理",
    state: hasPendingDraft.value ? "current" as const : "todo" as const
  },
  {
    label: "审核后登录",
    description: "通过后进入服务",
    state: isApprovedPhone.value ? "done" as const : "todo" as const
  }
]);

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
    } else if (response.application?.requestedRole) {
      requestedRole.value = response.application.requestedRole;
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

  sendingCode.value = true;
  try {
    const response = await mobileApi.requestCode(phone.value.trim(), "register");
    previewCode.value = showVerificationPreview ? response.previewCode ?? "" : "";
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
      throw new Error("请输入商家名称");
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
  <MobileShell eyebrow="注册申请" title="提交注册申请" subtitle="填写必要信息，工作人员审核通过后即可使用。">
    <GlassCard tone="accent" class="register-card">
      <view class="vm-stack">
        <FlowSteps :steps="registerSteps" />

        <view class="review-guide">
          <view class="review-guide__head">
            <MenuIcon name="review" size="sm" tone="accent" />
            <text class="review-guide__title">审核说明</text>
          </view>
          <text class="review-guide__body">提交后由工作人员在后台核对姓名、手机号、区域和身份资料。审核通过后可直接返回登录页；如被驳回，可按原因修改后重新提交。</text>
          <text class="review-guide__body">如果需要人工协助，可通过反馈入口联系工作人员。</text>
        </view>

        <view class="form-grid">
          <view class="vm-field">
            <text class="vm-field__label">手机号</text>
            <view class="vm-field-shell">
              <MenuIcon name="phone" size="sm" tone="neutral" />
              <input
                v-model="phone"
                class="vm-field-shell__input"
                type="tel"
                inputmode="numeric"
                maxlength="11"
                name="phone"
                aria-label="手机号"
                placeholder="请输入 11 位手机号"
              />
            </view>
          </view>

          <view class="vm-field">
            <view class="field-header">
              <text class="vm-field__label">验证码</text>
              <text class="vm-field__helper">提交时必填</text>
            </view>
            <view class="vm-field-shell vm-field-shell--stacked-action">
              <MenuIcon name="code" size="sm" tone="neutral" />
              <input
                v-model="code"
                class="vm-field-shell__input"
                type="tel"
                inputmode="numeric"
                maxlength="6"
                name="verification-code"
                aria-label="验证码"
                placeholder="请输入验证码"
              />
              <button
                class="vm-field-shell__button"
                :disabled="sendingCode"
                :loading="sendingCode"
                @tap="sendCode"
                aria-label="获取验证码"
              >
                发送
              </button>
            </view>
          </view>
        </view>

        <view v-if="showVerificationPreview && previewCode" class="debug-box">
          <text class="debug-box__label">当前验证码</text>
          <text class="vm-number">{{ previewCode }}</text>
        </view>

        <view v-if="helperMessage" class="status-box">
          <text class="status-box__value">{{ helperMessage }}</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet" class="register-card">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">选择身份与区域</text>
          <text class="vm-subtitle">请选择与你实际使用场景一致的身份，系统会只展示必要资料。</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">身份</text>
          <view class="role-segment">
            <button
              v-for="item in roleOptions"
              :key="item.value"
              class="role-option"
              :class="{ 'role-option--active': effectiveRole === item.value }"
              :disabled="Boolean(fixedRole)"
              @tap="requestedRole = item.value"
            >
              <MenuIcon :name="item.icon" size="sm" :tone="effectiveRole === item.value ? 'accent' : 'neutral'" />
              <view class="role-option__copy">
                <text class="role-option__label">{{ item.label }}</text>
                <text class="role-option__desc">{{ item.description }}</text>
              </view>
            </button>
          </view>
          <text class="vm-field__hint">
            用户用于领取和使用服务；商家用于补货与协作。管理员账号由后台分配，默认不开放自助申请。
          </text>
        </view>

        <view class="form-grid">
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
        </view>

        <template v-if="effectiveRole === 'merchant'">
          <view class="vm-field">
            <text class="vm-field__label">商家名称</text>
            <input v-model="form.merchantName" class="vm-field__input" placeholder="请输入商家名称" />
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
      </view>
    </GlassCard>

    <GlassCard tone="quiet" class="register-card">
      <view class="vm-stack">
        <view class="vm-field">
          <text class="vm-field__label">备注（选填）</text>
          <textarea
            v-model="form.note"
            class="vm-textarea"
            maxlength="200"
            placeholder="补充说明身份信息或特殊情况"
          />
        </view>

        <view class="submit-actions">
          <button class="vm-button" :loading="submitting" @tap="submit">
            {{ hasPendingDraft ? "覆盖更新并重新提交" : "提交注册资料" }}
          </button>
          <button class="vm-button vm-button--ghost" @tap="goLogin">已有账号，直接登录</button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.register-card {
  overflow: hidden;
}

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.vm-field__helper,
.debug-box__label,
.section-heading__title {
  line-height: 1.35;
}

.vm-field__helper,
.debug-box__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.section-heading {
  display: grid;
  gap: 8rpx;
}

.section-heading__title {
  font-size: 30rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.form-grid,
.submit-actions,
.review-guide {
  display: grid;
  gap: 18rpx;
}

.review-guide {
  padding: 20rpx 22rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-success-line);
  background: rgba(255, 255, 255, 0.88);
}

.review-guide__head {
  display: inline-flex;
  align-items: center;
  gap: 12rpx;
}

.review-guide__title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.review-guide__body,
.vm-field__hint {
  font-size: 23rpx;
  line-height: 1.65;
  color: var(--vm-text-soft);
}

.picker-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.role-segment {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190rpx, 1fr));
  gap: 12rpx;
}

.role-option {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 10rpx;
  min-height: 144rpx;
  padding: 16rpx 10rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: rgba(255, 255, 255, 0.78);
  color: var(--vm-text);
}

.role-option--active {
  border-color: var(--vm-accent-line);
  background: var(--vm-accent-bg);
  box-shadow: inset 0 1rpx 0 rgba(255, 255, 255, 0.78);
}

.role-option[disabled] {
  opacity: 1;
}

.role-option__copy {
  display: grid;
  gap: 4rpx;
  justify-items: center;
  text-align: center;
}

.role-option__label {
  font-size: 24rpx;
  line-height: 1.25;
  font-weight: 800;
  color: var(--vm-text);
}

.role-option__desc {
  font-size: 20rpx;
  line-height: 1.35;
  color: var(--vm-text-soft);
}

.debug-box,
.status-box {
  display: grid;
  gap: 8rpx;
  padding: 18rpx 20rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--vm-line);
  background: rgba(255, 255, 255, 0.78);
}

.status-box__value {
  font-size: 25rpx;
  line-height: 1.55;
  color: var(--vm-text);
}

@media screen and (min-width: 720px) {
  .form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
