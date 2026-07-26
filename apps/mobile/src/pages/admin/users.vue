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
import { showOperationSuccess } from "../../utils/operation-feedback";

const sessionStore = useSessionStore();
const loading = ref(false);
const users = ref<UserRecord[]>([]);
const selectedRole = ref<UserRecord["role"] | "all">("all");
const selectedUserIds = ref<string[]>([]);
const policies = ref<Array<{ id: string; name: string }>>([]);
const selectedPolicyId = ref("");
const batchSubmitting = ref<"active" | "inactive" | "policy" | "">("");
const currentUserId = computed(() => sessionStore.user?.id ?? "");

const roleFilterLabelMap: Record<UserRecord["role"] | "all", string> = {
  all: "全部人员",
  special: "普通用户",
  merchant: "商家",
  restocker: "补货员",
  admin: "管理员"
};

const filteredUsers = computed(() =>
  selectedRole.value === "all"
    ? users.value
    : users.value.filter((entry) => entry.role === selectedRole.value)
);

const selectedUsers = computed(() =>
  filteredUsers.value.filter(
    (entry) => entry.id !== currentUserId.value && selectedUserIds.value.includes(entry.id)
  )
);

const selectedUserCount = computed(() => selectedUsers.value.length);
const selectedSpecialUserCount = computed(() =>
  selectedUsers.value.filter((entry) => entry.role === "special").length
);
const selectedScopeLabel = computed(() =>
  selectedRole.value === "all"
    ? "当前全部人员列表"
    : `当前“${roleFilterLabelMap[selectedRole.value]}”筛选结果`
);
const batchActionsDisabled = computed(() =>
  loading.value || Boolean(batchSubmitting.value) || selectedUserCount.value === 0
);
const policyActionDisabled = computed(() =>
  batchActionsDisabled.value
  || selectedSpecialUserCount.value === 0
  || !selectedPolicyId.value
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
    const visibleUserIds = new Set(
      userResponse
        .filter(
          (entry) =>
            entry.id !== currentUserId.value
            && (selectedRole.value === "all" || entry.role === selectedRole.value)
        )
        .map((entry) => entry.id)
    );
    selectedUserIds.value = selectedUserIds.value.filter((userId) => visibleUserIds.has(userId));
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

const setRoleFilter = (role: UserRecord["role"] | "all") => {
  if (selectedRole.value === role) {
    return;
  }

  selectedUserIds.value = [];
  selectedRole.value = role;
};

const toggleUser = (userId: string) => {
  if (
    batchSubmitting.value
    || userId === currentUserId.value
    || !filteredUsers.value.some((entry) => entry.id === userId)
  ) {
    return;
  }

  selectedUserIds.value = selectedUserIds.value.includes(userId)
    ? selectedUserIds.value.filter((entry) => entry !== userId)
    : [...selectedUserIds.value, userId];
};

const batchUpdate = async (status: "active" | "inactive") => {
  if (batchSubmitting.value) {
    return;
  }

  const targetUserIds = selectedUsers.value.map((entry) => entry.id);
  if (!targetUserIds.length) {
    uni.showToast({
      title: "请先选择人员",
      icon: "none"
    });
    return;
  }

  const count = targetUserIds.length;
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: status === "active" ? "确认批量启用" : "确认批量停用",
      content: status === "active"
        ? `将启用已选择的 ${count} 名人员。启用后，对应账号可恢复使用其已有权限。`
        : `将停用已选择的 ${count} 名人员。停用后，对应账号将不能继续登录或使用业务功能。`,
      confirmText: status === "active" ? "确认启用" : "确认停用",
      cancelText: "取消",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  batchSubmitting.value = status;
  try {
    await mobileApi.batchUpdateUsers({
      userIds: targetUserIds,
      patch: { status }
    });
    await load();
    selectedUserIds.value = [];
    showOperationSuccess(status === "active" ? `已启用 ${count} 人` : `已停用 ${count} 人`);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    batchSubmitting.value = "";
  }
};

const bindPolicy = async () => {
  if (batchSubmitting.value) {
    return;
  }

  const targetUsers = selectedUsers.value
    .filter((entry) => entry.role === "special")
    .map((entry) => entry.id);

  if (!targetUsers.length || !selectedPolicyId.value) {
    uni.showToast({
      title: "请选择普通用户和策略模板",
      icon: "none"
    });
    return;
  }

  const excludedCount = Math.max(0, selectedUserCount.value - targetUsers.length);
  const policyName = policies.value.find((item) => item.id === selectedPolicyId.value)?.name ?? "所选策略";
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "确认绑定策略",
      content: `将为 ${targetUsers.length} 名普通用户绑定“${policyName}”。${excludedCount ? `已排除 ${excludedCount} 名非普通用户。` : ""}`,
      confirmText: "确认绑定",
      cancelText: "取消",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  batchSubmitting.value = "policy";
  try {
    await mobileApi.batchAssignPolicies({
      userIds: targetUsers,
      policyIds: [selectedPolicyId.value],
      mode: "bind"
    });
    await load();
    selectedUserIds.value = [];
    showOperationSuccess(`已绑定 ${targetUsers.length} 人`);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    batchSubmitting.value = "";
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
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'all' }" :aria-pressed="selectedRole === 'all'" aria-label="筛选全部人员" @tap="setRoleFilter('all')">全部</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'special' }" :aria-pressed="selectedRole === 'special'" aria-label="筛选普通用户" @tap="setRoleFilter('special')">普通用户</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'merchant' }" :aria-pressed="selectedRole === 'merchant'" aria-label="筛选商家" @tap="setRoleFilter('merchant')">商家</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'restocker' }" :aria-pressed="selectedRole === 'restocker'" aria-label="筛选补货员" @tap="setRoleFilter('restocker')">补货员</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': selectedRole === 'admin' }" :aria-pressed="selectedRole === 'admin'" aria-label="筛选管理员" @tap="setRoleFilter('admin')">管理员</button>
        </view>

        <picker aria-label="选择普通用户策略模板" :disabled="Boolean(batchSubmitting)" :range="policies" range-key="name" @change="selectedPolicyId = policies[$event.detail.value]?.id ?? ''">
          <view class="vm-field__input picker-value">
            {{ policies.find((item) => item.id === selectedPolicyId)?.name ?? "选择普通用户策略模板" }}
          </view>
        </picker>

        <view
          class="selection-summary"
          :class="{ 'selection-summary--active': selectedUserCount > 0 }"
          aria-live="polite"
        >
          <text class="selection-summary__title">
            {{ selectedUserCount ? `已选择 ${selectedUserCount} 人` : "尚未选择人员" }}
          </text>
          <text class="selection-summary__meta">
            批量启用和停用仅作用于{{ selectedScopeLabel }}；切换角色筛选会清空选择。
          </text>
          <text class="selection-summary__meta">当前登录账号不参与批量操作，需由其他管理员处理。</text>
          <text v-if="selectedUserCount" class="selection-summary__meta">
            当前选择中有 {{ selectedSpecialUserCount }} 名普通用户可绑定策略。
          </text>
        </view>

        <view class="action-grid">
          <button class="vm-button" :disabled="batchActionsDisabled" :loading="batchSubmitting === 'active'" @tap="batchUpdate('active')">批量启用</button>
          <button class="vm-button vm-button--ghost" :disabled="batchActionsDisabled" :loading="batchSubmitting === 'inactive'" @tap="batchUpdate('inactive')">批量停用</button>
          <button class="vm-button vm-button--soft" :disabled="policyActionDisabled" :loading="batchSubmitting === 'policy'" @tap="bindPolicy">批量绑定策略</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">人员列表</text>
        <view v-if="filteredUsers.length" class="user-list">
          <view v-for="item in filteredUsers" :key="item.id" class="user-item">
            <view class="user-item__header">
              <button
                class="select-toggle"
                :class="{ 'select-toggle--selected': selectedUserIds.includes(item.id) }"
                :disabled="Boolean(batchSubmitting) || item.id === currentUserId"
                :aria-label="
                  item.id === currentUserId
                    ? `${item.name}是当前登录账号，不可批量选择`
                    : selectedUserIds.includes(item.id)
                      ? `取消选择${item.name}`
                      : `选择${item.name}`
                "
                :aria-pressed="selectedUserIds.includes(item.id)"
                @tap="toggleUser(item.id)"
              >
                {{ item.id === currentUserId ? "本人" : selectedUserIds.includes(item.id) ? "已选" : "未选" }}
              </button>
              <view class="user-item__main">
                <text class="user-item__title">{{ item.name }}</text>
                <text class="user-item__meta">{{ item.phone }} · {{ roleLabelMap[item.role] }}</text>
                <text class="user-item__meta">{{ item.neighborhood || item.tags.join("、") || "未补充标签" }}</text>
              </view>
              <text class="vm-status" :class="item.status === 'active' ? 'vm-status--success' : 'vm-status--muted'">
                {{ item.status === "active" ? "启用" : "停用" }}
              </text>
            </view>
            <button
              class="user-item__detail vm-button vm-button--ghost"
              :disabled="Boolean(batchSubmitting)"
              :aria-label="`查看${item.name}详情`"
              @tap="openDetail(item.id)"
            >
              查看详情
            </button>
          </view>
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

.role-filter,
.action-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.action-grid .vm-button:last-child {
  grid-column: 1 / -1;
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
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
  font-size: 26rpx;
}

.filter-chip--active {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
  color: var(--vm-info);
}

.picker-value {
  display: flex;
  align-items: center;
}

.selection-summary {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  padding: 20rpx 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  border-radius: 20rpx;
  background: var(--vm-surface-soft);
}

.selection-summary--active {
  border-color: var(--vm-success-line);
  background: var(--vm-success-bg);
}

.selection-summary__title {
  color: var(--vm-text);
  font-size: 26rpx;
  font-weight: 700;
}

.selection-summary__meta {
  color: var(--vm-text-soft);
  font-size: 22rpx;
  line-height: 1.6;
}

.user-item {
  display: grid;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.user-item__header {
  display: grid;
  grid-template-columns: 104rpx minmax(0, 1fr) auto;
  gap: 16rpx;
  align-items: start;
}

.select-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 104rpx;
  min-height: 88rpx;
  margin: 0;
  padding: 0 12rpx;
  border: 1rpx solid var(--vm-info-line);
  border-radius: 16rpx;
  background: var(--vm-info-bg);
  color: var(--vm-info);
  font-size: 20rpx;
  line-height: 1.2;
}

.select-toggle--selected {
  border-color: var(--vm-success-line);
  background: var(--vm-success);
  color: #ffffff;
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

.user-item__detail {
  min-height: 72rpx;
  margin-top: 20rpx;
}
</style>

