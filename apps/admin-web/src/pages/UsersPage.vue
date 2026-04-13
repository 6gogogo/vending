<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { GoodsCatalogItem, RegionRecord, RegistrationApplication, SpecialAccessPolicy, UserLedgerStatus, UserRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";

type DrawerMode = "" | "create-user" | "edit-user" | "create-policy" | "edit-policy";

const OTHER_REGION_VALUE = "__other__";
const weekdayOptions = [
  { label: "周一", value: 1 },
  { label: "周二", value: 2 },
  { label: "周三", value: 3 },
  { label: "周四", value: 4 },
  { label: "周五", value: 5 },
  { label: "周六", value: 6 },
  { label: "周日", value: 0 }
];
const hourOptions = Array.from({ length: 24 }, (_, index) => index);
const hourEndOptions = Array.from({ length: 24 }, (_, index) => index + 1);

interface UserFormState {
  role: UserRecord["role"];
  phone: string;
  name: string;
  status: UserRecord["status"];
  regionId: string;
  regionName: string;
  tagsText: string;
}

interface PolicyFormState {
  name: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
  status: SpecialAccessPolicy["status"];
  goodsLimits: Array<{ goodsId: string; quantity: number }>;
}

const users = ref<UserRecord[]>([]);
const registrationApplications = ref<RegistrationApplication[]>([]);
const policies = ref<SpecialAccessPolicy[]>([]);
const goodsCatalog = ref<GoodsCatalogItem[]>([]);
const regions = ref<RegionRecord[]>([]);
const loading = ref(false);
const saving = ref(false);
const drawerMode = ref<DrawerMode>("");
const editingUserId = ref("");
const editingPolicyId = ref("");
const keyword = ref("");
const roleFilter = ref<"all" | UserRecord["role"]>("all");
const regionFilter = ref<"all" | string>("all");
const reviewFilter = ref<"pending" | "rejected" | "approved">("pending");
const selectedUserIds = ref<string[]>([]);
const batchPolicyIds = ref<string[]>([]);
const batchMode = ref<"bind" | "unbind" | "replace">("bind");
const rejectReasons = ref<Record<string, string>>({});
const userForm = ref<UserFormState>({ role: "special", phone: "", name: "", status: "active", regionId: "", regionName: "", tagsText: "" });
const policyForm = ref<PolicyFormState>({ name: "", weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 12, status: "active", goodsLimits: [{ goodsId: "", quantity: 1 }] });

const regionOptions = computed(() => [...regions.value.filter((item) => item.status === "active"), { id: OTHER_REGION_VALUE, name: "其他", status: "active", sortOrder: 9999 }]);
const goodsCatalogMap = computed(() => new Map(goodsCatalog.value.map((item) => [item.goodsId, item])));
const filteredUsers = computed(() => {
  const query = keyword.value.trim();
  return users.value.filter((user) => {
    if (roleFilter.value !== "all" && user.role !== roleFilter.value) return false;
    if (regionFilter.value !== "all" && (user.regionName || "未分配区域") !== regionFilter.value) return false;
    if (!query) return true;
    return [user.name, user.phone, user.tags.join(" "), user.regionName ?? user.neighborhood ?? "", user.ledgerStatus ?? ""].join(" ").includes(query);
  });
});
const groupedUsers = computed(() => {
  const orderMap = new Map(regions.value.map((item) => [item.name, item.sortOrder]));
  const groups = new Map<string, UserRecord[]>();
  filteredUsers.value.forEach((user) => {
    const key = user.regionName || "未分配区域";
    groups.set(key, [...(groups.get(key) ?? []), user]);
  });
  return Array.from(groups.entries())
    .map(([regionName, groupUsers]) => ({ regionName, users: groupUsers, sortOrder: orderMap.get(regionName) ?? 9999 }))
    .sort((left, right) => (left.sortOrder === right.sortOrder ? left.regionName.localeCompare(right.regionName, "zh-Hans-CN") : left.sortOrder - right.sortOrder));
});
const filteredApplications = computed(() => registrationApplications.value.filter((item) => item.status === reviewFilter.value).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
const selectedUsers = computed(() => users.value.filter((user) => selectedUserIds.value.includes(user.id)));
const selectedSpecialUsers = computed(() => selectedUsers.value.filter((user) => user.role === "special"));
const allFilteredSelected = computed(() => filteredUsers.value.length > 0 && filteredUsers.value.every((user) => selectedUserIds.value.includes(user.id)));
const currentDrawerTitle = computed(() => drawerMode.value === "create-user" ? "新增人员" : drawerMode.value === "edit-user" ? "编辑人员" : drawerMode.value === "create-policy" ? "新增策略模板" : drawerMode.value === "edit-policy" ? "编辑策略模板" : "");
const visibleRegionNames = computed(() => {
  const names = new Set<string>();
  users.value.forEach((user) => names.add(user.regionName || "未分配区域"));
  return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
});

const formatRole = (role: UserRecord["role"]) => role === "special" ? "普通用户" : role === "merchant" ? "爱心商户" : "管理员";
const formatLedgerStatus = (status?: UserLedgerStatus) => status === "unregistered" ? "未注册" : status === "quota_unclaimed" ? "物资未领取" : status === "quota_partial" ? "部分领取" : status === "quota_complete" ? "全部领取" : "已注册";
const ledgerStatusTone = (status?: UserLedgerStatus) => status === "quota_complete" ? "admin-pill--success" : status === "quota_partial" || status === "unregistered" ? "admin-pill--warning" : "admin-pill--neutral";
const registrationLabel = (user: UserRecord) => (user.ledgerStatus === "unregistered" ? "未注册" : "已注册");
const parseTags = (value: string) => value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
const formatWeekdays = (weekdays: number[]) => weekdays.slice().sort((left, right) => (left === 0 ? 7 : left) - (right === 0 ? 7 : right)).map((value) => weekdayOptions.find((item) => item.value === value)?.label ?? String(value)).join("、");
const policySummary = (userId: string) => {
  const user = users.value.find((item) => item.id === userId);
  const directCount = user?.accessPolicies?.filter((policy) => policy.status === "active").length ?? 0;
  if (directCount > 0) {
    return `个人设定 ${directCount} 条`;
  }

  const inheritedNames = policies.value
    .filter((policy) => policy.applicableUserIds.includes(userId) && policy.status === "active")
    .map((policy) => policy.name);
  return inheritedNames.length ? `模板：${inheritedNames.join("、")}` : "未设置";
};

const resetUserForm = () => {
  userForm.value = { role: "special", phone: "", name: "", status: "active", regionId: "", regionName: "", tagsText: "" };
};
const fillUserForm = (user: UserRecord) => {
  userForm.value = { role: user.role, phone: user.phone, name: user.name, status: user.status, regionId: user.regionId || (user.regionName ? OTHER_REGION_VALUE : ""), regionName: user.regionId ? "" : user.regionName ?? "", tagsText: user.tags.join("，") };
};
const resetPolicyForm = () => {
  policyForm.value = { name: "", weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 12, status: "active", goodsLimits: [{ goodsId: goodsCatalog.value[0]?.goodsId ?? "", quantity: 1 }] };
};
const resolveRegionPayload = (state: UserFormState) => {
  if (state.regionId === OTHER_REGION_VALUE) return { regionId: undefined, regionName: state.regionName.trim() || undefined };
  if (!state.regionId) return { regionId: undefined, regionName: undefined };
  const region = regions.value.find((item) => item.id === state.regionId);
  return { regionId: region?.id, regionName: region?.name };
};

const load = async () => {
  loading.value = true;
  try {
    const [usersResponse, applicationResponse, policiesResponse, goodsCatalogResponse, regionsResponse] = await Promise.all([adminApi.users(), adminApi.registrationApplications(), adminApi.policies(), adminApi.goodsCatalog(), adminApi.regions()]);
    users.value = usersResponse;
    registrationApplications.value = applicationResponse;
    policies.value = policiesResponse;
    goodsCatalog.value = goodsCatalogResponse;
    regions.value = regionsResponse;
    if (!policyForm.value.goodsLimits[0]?.goodsId && goodsCatalogResponse[0]) policyForm.value.goodsLimits[0].goodsId = goodsCatalogResponse[0].goodsId;
  } finally {
    loading.value = false;
  }
};

const reviewApplication = async (applicationId: string, decision: "approved" | "rejected") => {
  saving.value = true;
  try {
    await adminApi.reviewRegistration(applicationId, { decision, reason: decision === "rejected" ? rejectReasons.value[applicationId] : undefined });
    await load();
  } finally {
    saving.value = false;
  }
};
const toggleSelectAll = () => {
  if (allFilteredSelected.value) {
    selectedUserIds.value = selectedUserIds.value.filter((id) => !filteredUsers.value.some((user) => user.id === id));
    return;
  }
  selectedUserIds.value = Array.from(new Set([...selectedUserIds.value, ...filteredUsers.value.map((user) => user.id)]));
};
const toggleUser = (userId: string) => {
  selectedUserIds.value = selectedUserIds.value.includes(userId) ? selectedUserIds.value.filter((id) => id !== userId) : [...selectedUserIds.value, userId];
};
const openCreateUser = () => {
  editingUserId.value = "";
  resetUserForm();
  drawerMode.value = "create-user";
};
const openEditUser = (user: UserRecord) => {
  editingUserId.value = user.id;
  fillUserForm(user);
  drawerMode.value = "edit-user";
};
const openCreatePolicy = () => {
  editingPolicyId.value = "";
  resetPolicyForm();
  drawerMode.value = "create-policy";
};
const openEditPolicy = (policy: SpecialAccessPolicy) => {
  editingPolicyId.value = policy.id;
  policyForm.value = { name: policy.name, weekdays: [...policy.weekdays], startHour: policy.startHour, endHour: policy.endHour, status: policy.status, goodsLimits: policy.goodsLimits.map((limit) => ({ goodsId: limit.goodsId, quantity: limit.quantity })) };
  drawerMode.value = "edit-policy";
};
const closeDrawer = () => {
  drawerMode.value = "";
  editingUserId.value = "";
  editingPolicyId.value = "";
};

const submitUserForm = async () => {
  const regionPayload = resolveRegionPayload(userForm.value);
  saving.value = true;
  try {
    const payload = {
      role: userForm.value.role,
      phone: userForm.value.phone.trim(),
      name: userForm.value.name.trim(),
      status: userForm.value.status,
      neighborhood: regionPayload.regionName,
      regionId: regionPayload.regionId,
      regionName: regionPayload.regionName,
      tags: parseTags(userForm.value.tagsText)
    };
    if (drawerMode.value === "create-user") {
      await adminApi.createUser(payload);
    } else if (drawerMode.value === "edit-user" && editingUserId.value) {
      await adminApi.updateUser(editingUserId.value, payload);
    }
    closeDrawer();
    await load();
  } finally {
    saving.value = false;
  }
};

const addPolicyGoodsLimit = () => {
  policyForm.value.goodsLimits.push({ goodsId: goodsCatalog.value[0]?.goodsId ?? "", quantity: 1 });
};
const removePolicyGoodsLimit = (index: number) => {
  policyForm.value.goodsLimits.splice(index, 1);
  if (!policyForm.value.goodsLimits.length) addPolicyGoodsLimit();
};
const submitPolicyForm = async () => {
  const normalizedWeekdays = Array.from(new Set(policyForm.value.weekdays)).sort((left, right) => left - right);
  const goodsLimits = policyForm.value.goodsLimits.filter((item) => item.goodsId && item.quantity > 0).map((item) => {
    const catalogItem = goodsCatalogMap.value.get(item.goodsId);
    if (!catalogItem) throw new Error(`未找到货品 ${item.goodsId}。`);
    return { goodsId: catalogItem.goodsId, goodsName: catalogItem.name, category: catalogItem.category, quantity: item.quantity };
  });
  if (!normalizedWeekdays.length || !goodsLimits.length || policyForm.value.endHour <= policyForm.value.startHour) return;
  saving.value = true;
  try {
    const basePayload = { name: policyForm.value.name.trim(), weekdays: normalizedWeekdays, startHour: policyForm.value.startHour, endHour: policyForm.value.endHour, status: policyForm.value.status, goodsLimits };
    if (drawerMode.value === "create-policy") {
      await adminApi.createPolicy({ ...basePayload, applicableUserIds: [] });
    } else if (drawerMode.value === "edit-policy" && editingPolicyId.value) {
      const existing = policies.value.find((policy) => policy.id === editingPolicyId.value);
      await adminApi.updatePolicy(editingPolicyId.value, { ...basePayload, applicableUserIds: existing?.applicableUserIds ?? [] });
    }
    closeDrawer();
    await load();
  } finally {
    saving.value = false;
  }
};
const applyBatchPolicies = async () => {
  if (!selectedSpecialUsers.value.length || !batchPolicyIds.value.length) return;
  if (
    batchMode.value === "replace" &&
    !window.confirm("覆盖会在下一个业务日替换所选普通用户的个人取货设定，确认继续吗？")
  ) {
    return;
  }
  saving.value = true;
  try {
    await adminApi.batchAssignPolicies({ userIds: selectedSpecialUsers.value.map((user) => user.id), policyIds: batchPolicyIds.value, mode: batchMode.value });
    await load();
  } finally {
    saving.value = false;
  }
};

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">注册审核</p>
          <h3 class="admin-page__section-title">同页处理待审核、已驳回和已登记人员</h3>
        </div>
      </div>

      <div class="admin-panel admin-panel-block users-review-block">
        <div class="users-review-tabs">
          <button class="admin-button" :class="{ 'admin-button--ghost': reviewFilter !== 'pending' }" @click="reviewFilter = 'pending'">待审核 {{ registrationApplications.filter((item) => item.status === "pending").length }}</button>
          <button class="admin-button" :class="{ 'admin-button--ghost': reviewFilter !== 'rejected' }" @click="reviewFilter = 'rejected'">已驳回 {{ registrationApplications.filter((item) => item.status === "rejected").length }}</button>
          <button class="admin-button" :class="{ 'admin-button--ghost': reviewFilter !== 'approved' }" @click="reviewFilter = 'approved'">已登记 {{ registrationApplications.filter((item) => item.status === "approved").length }}</button>
        </div>

        <div v-if="filteredApplications.length" class="admin-list">
          <div v-for="item in filteredApplications" :key="item.id" class="admin-list__row users-review-row">
            <div class="admin-list__main">
              <span class="admin-list__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</span>
              <span class="admin-list__meta">{{ item.phone }} · {{ item.requestedRole === "special" ? "普通用户" : item.requestedRole === "merchant" ? "爱心商户" : "管理员" }} · 更新于 {{ item.updatedAt.slice(0, 16).replace("T", " ") }}</span>
              <span class="admin-table__subtext">{{ item.requestedRole === "special" ? `${item.profile.regionName || "待补充区域"}${item.profile.note ? ` · ${item.profile.note}` : ""}` : item.requestedRole === "merchant" ? `${item.profile.contactName || "待补充联系人"} · ${item.profile.address || "待补充地址"}` : `${item.profile.organization || "待补充单位"} · ${item.profile.title || "待补充职务"}` }}</span>
              <span v-if="item.reviewReason" class="users-review-row__reason">驳回原因：{{ item.reviewReason }}</span>
            </div>
            <div class="users-review-row__actions">
              <span class="admin-pill" :class="item.status === 'approved' ? 'admin-pill--success' : item.status === 'pending' ? 'admin-pill--warning' : 'admin-pill--neutral'">{{ item.status === "pending" ? "待审核" : item.status === "approved" ? "已通过" : "已驳回" }}</span>
              <template v-if="item.status === 'pending'">
                <input v-model="rejectReasons[item.id]" class="admin-input" placeholder="驳回时填写原因（选填）" />
                <div class="admin-inline-links">
                  <button class="admin-button" :disabled="saving" @click="reviewApplication(item.id, 'approved')">通过</button>
                  <button class="admin-button admin-button--ghost" :disabled="saving" @click="reviewApplication(item.id, 'rejected')">驳回</button>
                </div>
              </template>
              <RouterLink v-if="item.linkedUserId" class="admin-link" :to="`/users/${item.linkedUserId}`">查看已登记详情</RouterLink>
            </div>
          </div>
        </div>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载审核列表" : "当前分类下没有注册申请" }}</div>
          <div class="admin-empty__body">新的注册申请会在这里出现，审核通过后会自动进入已登记人员列表。</div>
        </div>
      </div>
    </section>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">人员检索</p>
          <h3 class="admin-page__section-title">按区域分组查看人员台账并批量绑定普通用户策略</h3>
        </div>
        <button class="admin-button" @click="openCreateUser">新增人员</button>
      </div>

      <div class="users-filters admin-panel admin-panel-block">
        <label class="admin-field">
          <span class="admin-field__label">分类</span>
          <select v-model="roleFilter" class="admin-select">
            <option value="all">全部</option>
            <option value="special">普通用户</option>
            <option value="merchant">爱心商户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">按地区分类</span>
          <select v-model="regionFilter" class="admin-select">
            <option value="all">全部地区</option>
            <option v-for="regionName in visibleRegionNames" :key="regionName" :value="regionName">
              {{ regionName }}
            </option>
          </select>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">搜索</span>
          <input v-model="keyword" class="admin-input" placeholder="输入姓名、手机号、标签或区域" />
        </label>
        <div class="users-filters__summary admin-note">
          当前结果 {{ filteredUsers.length }} 人，已选 {{ selectedUserIds.length }} 人。人员台账默认按地区分组，普通用户领取状态单独显示。
        </div>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">人员台账</span>
            <h3 class="admin-panel__title">按区域分组，状态显示注册与领取进度</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="toggleSelectAll">{{ allFilteredSelected ? "取消全选" : "全选当前结果" }}</button>
        </div>

        <div v-if="groupedUsers.length" class="users-region-groups">
          <section v-for="group in groupedUsers" :key="group.regionName" class="users-region-group">
            <div class="users-region-group__head">
              <span class="admin-kicker">{{ group.regionName }}</span>
              <span class="admin-table__subtext">{{ group.users.length }} 人</span>
            </div>
            <table class="admin-table">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>手机号</th>
                  <th>台账状态</th>
                  <th>区域 / 标签</th>
                  <th>取货设定</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="user in group.users" :key="user.id">
                  <td><input type="checkbox" :checked="selectedUserIds.includes(user.id)" @change="toggleUser(user.id)" /></td>
                  <td>
                    <RouterLink class="admin-link" :to="`/users/${user.id}`">{{ user.name }}</RouterLink>
                    <span class="admin-table__subtext">{{ user.id }}</span>
                  </td>
                  <td>
                    <span class="admin-table__strong">{{ formatRole(user.role) }}</span>
                    <span class="admin-table__subtext">{{ user.status === "active" ? "账号已启用" : "账号已停用" }}</span>
                  </td>
                  <td>
                    <span class="admin-code">{{ user.phone }}</span>
                    <span class="admin-table__subtext">{{ registrationLabel(user) }}</span>
                  </td>
                  <td>
                    <span class="admin-pill" :class="ledgerStatusTone(user.ledgerStatus)">{{ formatLedgerStatus(user.ledgerStatus) }}</span>
                  </td>
                  <td>
                    <span class="admin-table__strong">{{ user.regionName || "未分配区域" }}</span>
                    <span class="admin-table__subtext">{{ user.tags.join("、") || "无标签" }}</span>
                  </td>
                  <td><span class="admin-table__strong">{{ user.role === "special" ? policySummary(user.id) : "不适用" }}</span></td>
                  <td>
                    <div class="admin-inline-links">
                      <RouterLink class="admin-link" :to="`/users/${user.id}`">详情</RouterLink>
                      <button class="admin-text-button" @click="openEditUser(user)">编辑</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载人员列表" : "没有匹配到任何人员" }}</div>
          <div class="admin-empty__body">请调整筛选条件，或确认后端当前是否已有人员数据。</div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">批量策略绑定</span>
              <h3 class="admin-panel__title">模板只作为批量生成用户个人取货设定的起点</h3>
            </div>
          </div>
          <div class="users-side-block">
            <div class="admin-note">已选普通用户 {{ selectedSpecialUsers.length }} 人。绑定后会按策略模板的星期、时段和货品数量生效。</div>
            <label class="admin-field">
              <span class="admin-field__label">操作方式</span>
              <select v-model="batchMode" class="admin-select">
                <option value="bind">新增为个人设定</option>
                <option value="replace">覆盖个人设定</option>
                <option value="unbind">解绑以下模板</option>
              </select>
            </label>
            <div class="admin-field">
              <span class="admin-field__label">模板选择</span>
              <div class="users-policy-checklist">
                <label v-for="policy in policies" :key="policy.id" class="users-policy-check">
                  <input v-model="batchPolicyIds" type="checkbox" :value="policy.id" />
                  <span>{{ policy.name }}</span>
                  <span class="admin-table__subtext">{{ policy.applicableUserIds.length }} 人</span>
                </label>
              </div>
            </div>
            <div class="admin-note">
              {{
                batchMode === "replace"
                  ? "覆盖会把模板拆成按货品的个人设定，并在下一个业务日替换当前个人设置。"
                  : "新增会把模板中的每个货品最小单元追加到所选普通用户的个人设定中。"
              }}
            </div>
            <button class="admin-button" :disabled="saving || !selectedSpecialUsers.length || !batchPolicyIds.length" @click="applyBatchPolicies">{{ saving ? "保存中" : batchMode === "replace" ? "覆盖个人设定" : "新增到个人设定" }}</button>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">策略模板库</span>
              <h3 class="admin-panel__title">管理时段、星期和货品数量</h3>
            </div>
            <button class="admin-button admin-button--ghost" @click="openCreatePolicy">新增模板</button>
          </div>
          <div v-if="policies.length" class="admin-list">
            <div v-for="policy in policies" :key="policy.id" class="admin-list__row users-policy-row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ policy.name }}</span>
                <span class="admin-list__meta">{{ formatWeekdays(policy.weekdays) }} · {{ String(policy.startHour).padStart(2, "0") }}:00-{{ String(policy.endHour).padStart(2, "0") }}:00 · {{ policy.applicableUserIds.length }} 人</span>
                <span class="admin-table__subtext">{{ policy.goodsLimits.map((limit) => `${limit.goodsName} x${limit.quantity}`).join("，") }}</span>
              </div>
              <div class="admin-inline-links">
                <span class="admin-pill" :class="policy.status === 'active' ? 'admin-pill--success' : 'admin-pill--warning'">{{ policy.status === "active" ? "启用中" : "已停用" }}</span>
                <button class="admin-text-button" @click="openEditPolicy(policy)">编辑</button>
              </div>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前还没有策略模板</div>
            <div class="admin-empty__body">请先新增模板，再批量绑定到普通用户。</div>
          </div>
        </article>
      </aside>
    </section>

    <div v-if="drawerMode" class="users-drawer-backdrop" @click.self="closeDrawer">
      <aside class="users-drawer admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">编辑面板</span>
            <h3 class="admin-panel__title">{{ currentDrawerTitle }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="closeDrawer">关闭</button>
        </div>

        <div v-if="drawerMode === 'create-user' || drawerMode === 'edit-user'" class="users-drawer__body">
          <label class="admin-field">
            <span class="admin-field__label">角色</span>
            <select v-model="userForm.role" class="admin-select" :disabled="drawerMode === 'edit-user'">
              <option value="special">普通用户</option>
              <option value="merchant">爱心商户</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">姓名</span>
            <input v-model="userForm.name" class="admin-input" placeholder="请输入姓名" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">手机号</span>
            <input v-model="userForm.phone" class="admin-input" placeholder="请输入手机号" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">状态</span>
            <select v-model="userForm.status" class="admin-select">
              <option value="active">启用</option>
              <option value="inactive">暂停</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">区域</span>
            <select v-model="userForm.regionId" class="admin-select">
              <option value="">未分配区域</option>
              <option v-for="region in regionOptions" :key="region.id" :value="region.id">{{ region.name }}</option>
            </select>
          </label>
          <label v-if="userForm.regionId === OTHER_REGION_VALUE" class="admin-field">
            <span class="admin-field__label">自定义区域</span>
            <input v-model="userForm.regionName" class="admin-input" placeholder="请输入区域名称" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">标签</span>
            <input v-model="userForm.tagsText" class="admin-input" placeholder="多个标签请用中文逗号分隔" />
          </label>
          <button class="admin-button" :disabled="saving || !userForm.name || !userForm.phone" @click="submitUserForm">{{ saving ? "保存中" : "保存人员信息" }}</button>
        </div>

        <div v-else class="users-drawer__body">
          <label class="admin-field">
            <span class="admin-field__label">模板名称</span>
            <input v-model="policyForm.name" class="admin-input" placeholder="例如早餐关怀" />
          </label>
          <div class="admin-field">
            <span class="admin-field__label">生效星期</span>
            <div class="users-weekdays">
              <label v-for="weekday in weekdayOptions" :key="weekday.value" class="users-weekdays__item">
                <input v-model="policyForm.weekdays" type="checkbox" :value="weekday.value" />
                <span>{{ weekday.label }}</span>
              </label>
            </div>
          </div>
          <div class="users-hours">
            <label class="admin-field">
              <span class="admin-field__label">开始小时</span>
              <select v-model="policyForm.startHour" class="admin-select">
                <option v-for="hour in hourOptions" :key="hour" :value="hour">{{ String(hour).padStart(2, "0") }}:00</option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">结束小时</span>
              <select v-model="policyForm.endHour" class="admin-select">
                <option v-for="hour in hourEndOptions" :key="hour" :value="hour">{{ String(hour).padStart(2, "0") }}:00</option>
              </select>
            </label>
          </div>
          <label class="admin-field">
            <span class="admin-field__label">状态</span>
            <select v-model="policyForm.status" class="admin-select">
              <option value="active">启用</option>
              <option value="inactive">停用</option>
            </select>
          </label>
          <div class="admin-field">
            <span class="admin-field__label">货品数量</span>
            <div class="users-policy-limits">
              <div v-for="(limit, index) in policyForm.goodsLimits" :key="`${index}-${limit.goodsId}`" class="users-policy-limit-row">
                <select v-model="limit.goodsId" class="admin-select">
                  <option v-for="goods in goodsCatalog" :key="goods.goodsId" :value="goods.goodsId">{{ goods.name }} / {{ goods.goodsId }}</option>
                </select>
                <input v-model.number="limit.quantity" class="admin-input" type="number" min="1" />
                <button class="admin-button admin-button--ghost" @click="removePolicyGoodsLimit(index)">删除</button>
              </div>
            </div>
            <button class="admin-text-button" @click="addPolicyGoodsLimit">继续添加货品</button>
          </div>
          <div class="admin-note">时间段采用整点小时制，保存格式为 [开始小时, 结束小时)，例如 08:00-12:00。</div>
          <button class="admin-button" :disabled="saving || !policyForm.name || !policyForm.weekdays.length || policyForm.endHour <= policyForm.startHour" @click="submitPolicyForm">{{ saving ? "保存中" : "保存策略模板" }}</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.users-filters,
.users-side-block,
.users-drawer__body,
.users-policy-limits,
.users-region-groups,
.users-review-block,
.users-review-tabs,
.users-review-row__actions,
.users-policy-checklist,
.users-weekdays,
.users-region-form-grid,
.users-region-group {
  display: grid;
  gap: 10px;
}

.users-filters {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.users-filters__summary {
  align-self: end;
}

.users-policy-check,
.users-weekdays__item,
.users-region-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.users-region-group__head {
  justify-content: space-between;
}

.users-policy-row,
.users-review-row {
  align-items: flex-start;
}

.users-review-row__actions {
  width: min(360px, 100%);
}

.users-review-row__reason {
  color: #a5443f;
}

.users-policy-limit-row,
.users-hours,
.users-region-form-grid {
  display: grid;
  gap: 8px;
}

.users-policy-limit-row {
  grid-template-columns: minmax(0, 1fr) 120px auto;
}

.users-hours,
.users-region-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.users-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.32);
}

.users-drawer {
  width: min(560px, 100%);
  height: 100%;
  border-radius: 0;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  overflow: auto;
}

.admin-text-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--admin-accent);
  font: inherit;
  cursor: pointer;
}

@media (max-width: 980px) {
  .users-filters,
  .users-policy-limit-row,
  .users-hours,
  .users-region-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
