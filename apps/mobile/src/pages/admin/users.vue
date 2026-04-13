<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { UserRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const loading = ref(false);
const users = ref<UserRecord[]>([]);
const selectedRole = ref<UserRecord["role"] | "all">("all");
const selectedUserIds = ref<string[]>([]);
const policies = ref<Array<{ id: string; name: string }>>([]);
const selectedPolicyId = ref("");

const filteredUsers = computed(() =>
  selectedRole.value === "all"
    ? users.value
    : users.value.filter((entry) => entry.role === selectedRole.value)
);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin") {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    const [userResponse, policyResponse] = await Promise.all([
      mobileApi.users(),
      mobileApi.listPolicies()
    ]);
    users.value = userResponse;
    policies.value = policyResponse.map((item) => ({
      id: item.id,
      name: item.name
    }));
    selectedPolicyId.value = policies.value[0]?.id ?? "";
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const toggleUser = (userId: string) => {
  selectedUserIds.value = selectedUserIds.value.includes(userId)
    ? selectedUserIds.value.filter((entry) => entry !== userId)
    : [...selectedUserIds.value, userId];
};

const batchUpdate = async (status: "active" | "inactive") => {
  if (!selectedUserIds.value.length) {
    uni.showToast({
      title: "请先选择人员",
      icon: "none"
    });
    return;
  }

  try {
    await mobileApi.batchUpdateUsers({
      userIds: selectedUserIds.value,
      patch: { status }
    });
    await load();
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

const bindPolicy = async () => {
  const targetUsers = filteredUsers.value
    .filter((entry) => selectedUserIds.value.includes(entry.id) && entry.role === "special")
    .map((entry) => entry.id);

  if (!targetUsers.length || !selectedPolicyId.value) {
    uni.showToast({
      title: "请选择普通用户和策略模板",
      icon: "none"
    });
    return;
  }

  try {
    await mobileApi.batchAssignPolicies({
      userIds: targetUsers,
      policyIds: [selectedPolicyId.value],
      mode: "bind"
    });
    uni.showToast({
      title: "策略已绑定",
      icon: "none"
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

const openDetail = (userId: string) => {
  uni.navigateTo({
    url: `/pages/admin/user-detail?userId=${userId}`
  });
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="人员管理" title="用户列表与批量设置" subtitle="可按角色查看人员并批量启停或绑定普通用户策略。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="role-filter">
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'all' }" @tap="selectedRole = 'all'">全部</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'special' }" @tap="selectedRole = 'special'">普通用户</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'merchant' }" @tap="selectedRole = 'merchant'">爱心商户</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'admin' }" @tap="selectedRole = 'admin'">管理员</button>
        </view>

        <picker :range="policies" range-key="name" @change="selectedPolicyId = policies[$event.detail.value]?.id ?? ''">
          <view class="vm-field__input picker-value">
            {{ policies.find((item) => item.id === selectedPolicyId)?.name ?? "选择普通用户策略模板" }}
          </view>
        </picker>

        <view class="action-grid">
          <button class="vm-button" @tap="batchUpdate('active')">批量启用</button>
          <button class="vm-button vm-button--ghost" @tap="batchUpdate('inactive')">批量停用</button>
          <button class="vm-button vm-button--soft" @tap="bindPolicy">批量绑定策略</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">人员列表</text>
        <view v-if="filteredUsers.length" class="user-list">
          <button v-for="item in filteredUsers" :key="item.id" class="user-item" @tap="openDetail(item.id)">
            <view class="user-item__header">
              <text class="select-mark" @tap.stop="toggleUser(item.id)">
                {{ selectedUserIds.includes(item.id) ? "已选" : "未选" }}
              </text>
              <view class="user-item__main">
                <text class="user-item__title">{{ item.name }}</text>
                <text class="user-item__meta">{{ item.phone }} · {{ roleLabelMap[item.role] }}</text>
                <text class="user-item__meta">{{ item.neighborhood || item.tags.join("、") || "未补充标签" }}</text>
              </view>
              <text class="vm-status" :class="item.status === 'active' ? 'vm-status--success' : 'vm-status--muted'">
                {{ item.status === "active" ? "启用" : "停用" }}
              </text>
            </view>
          </button>
        </view>
        <EmptyState v-else :title="loading ? '正在加载人员' : '当前没有匹配人员'" description="切换角色筛选或等待新的用户通过审核后再查看。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.role-filter,
.action-grid,
.user-list {
  display: grid;
  gap: 16rpx;
}

.section-title,
.user-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.filter-chip {
  min-height: 80rpx;
  border-radius: 22rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  background: rgba(255, 252, 246, 0.88);
  font-size: 26rpx;
}

.filter-chip--active {
  border-color: rgba(47, 143, 102, 0.35);
  background: rgba(241, 251, 244, 0.98);
  color: var(--vm-accent-strong);
}

.picker-value {
  display: flex;
  align-items: center;
}

.user-item {
  display: grid;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.user-item__header {
  display: grid;
  grid-template-columns: 72rpx minmax(0, 1fr) auto;
  gap: 16rpx;
  align-items: start;
}

.select-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 52rpx;
  border-radius: 16rpx;
  background: rgba(47, 143, 102, 0.08);
  color: var(--vm-accent-strong);
  font-size: 20rpx;
}

.user-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  text-align: left;
}

.user-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>
