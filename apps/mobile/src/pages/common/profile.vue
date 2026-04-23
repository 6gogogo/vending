<script setup lang="ts">
import { computed, reactive } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { RegistrationApplicationProfile, UserRole } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const saving = reactive({
  value: false
});
const form = reactive<RegistrationApplicationProfile>({
  name: "",
  neighborhood: "",
  note: "",
  merchantName: "",
  contactName: "",
  address: "",
  organization: "",
  title: ""
});

const role = computed<UserRole>(() => sessionStore.draft?.requestedRole ?? "special");
const titleMap: Record<UserRole, string> = {
  special: "完善普通用户资料",
  merchant: "完善爱心商户资料",
  admin: "完善管理员资料"
};
const subtitleMap: Record<UserRole, string> = {
  special: "提交后如手机号已预录入可直接通过，否则进入人工审核。",
  merchant: "请补充商户联系人和经营地址，便于补货与追踪去向。",
  admin: "管理员申请需要由现有管理员审核后才能启用高权限。"
};

const syncForm = () => {
  const source = sessionStore.profileDraft;

  form.name = source?.name ?? "";
  form.neighborhood = source?.neighborhood ?? "";
  form.note = source?.note ?? "";
  form.merchantName = source?.merchantName ?? "";
  form.contactName = source?.contactName ?? "";
  form.address = source?.address ?? "";
  form.organization = source?.organization ?? "";
  form.title = source?.title ?? "";
};

const ensureDraft = async () => {
  await sessionStore.bootstrap();

  if (sessionStore.user) {
    uni.reLaunch({
      url: resolveHomePath(sessionStore.user.role)
    });
    return;
  }

  if (!sessionStore.draft) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  syncForm();
};

const submit = async () => {
  if (!sessionStore.draft) {
    return;
  }

  saving.value = true;
  sessionStore.setProfileDraft({ ...form });

  try {
    const response = await mobileApi.submitMobileProfile({
      draftToken: sessionStore.draft.token,
      requestedRole: role.value,
      profile: {
        ...form
      }
    });

    if (response.state === "approved") {
      sessionStore.setSession(response);
      uni.reLaunch({
        url: resolveHomePath(response.user.role)
      });
      return;
    }

    sessionStore.setDraft({
      draft: response.draft,
      application: response.application,
      profileDraft: response.application.profile
    });
    uni.reLaunch({
      url: "/pages/common/review-status"
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    saving.value = false;
  }
};

onShow(() => {
  ensureDraft();
});
</script>

<template>
  <MobileShell eyebrow="资料补全" :title="titleMap[role]" :subtitle="subtitleMap[role]">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="vm-field">
          <text class="vm-field__label">姓名</text>
          <input v-model="form.name" class="vm-field__input" placeholder="请输入姓名" />
        </view>

        <view v-if="role === 'special'" class="vm-field">
          <text class="vm-field__label">所在片区</text>
          <input v-model="form.neighborhood" class="vm-field__input" placeholder="例如：扬名街道" />
        </view>

        <template v-if="role === 'merchant'">
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

        <template v-if="role === 'admin'">
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
          <textarea v-model="form.note" class="vm-textarea" maxlength="120" placeholder="补充说明当前身份信息" />
        </view>

        <button class="vm-button" :loading="saving.value" @tap="submit">提交资料</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.vm-textarea {
  width: 100%;
  min-height: 200rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
  font-size: 28rpx;
  color: var(--vm-text);
}
</style>

