<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { GoodsCatalogItem, SpecialAccessPolicy, UserRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";

type DrawerMode = "" | "create-user" | "edit-user" | "create-policy" | "edit-policy";

interface UserFormState {
  role: UserRecord["role"];
  phone: string;
  name: string;
  status: UserRecord["status"];
  neighborhood: string;
  tagsText: string;
}

interface PolicyFormState {
  name: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
  status: SpecialAccessPolicy["status"];
  goodsLimits: Array<{
    goodsId: string;
    quantity: number;
  }>;
}

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

const users = ref<UserRecord[]>([]);
const policies = ref<SpecialAccessPolicy[]>([]);
const goodsCatalog = ref<GoodsCatalogItem[]>([]);
const loading = ref(false);
const saving = ref(false);
const drawerMode = ref<DrawerMode>("");
const editingUserId = ref("");
const editingPolicyId = ref("");

const keyword = ref("");
const roleFilter = ref<"all" | UserRecord["role"]>("all");
const selectedUserIds = ref<string[]>([]);
const batchPolicyIds = ref<string[]>([]);
const batchMode = ref<"bind" | "unbind" | "replace">("bind");

const userForm = ref<UserFormState>({
  role: "special",
  phone: "",
  name: "",
  status: "active",
  neighborhood: "",
  tagsText: ""
});

const policyForm = ref<PolicyFormState>({
  name: "",
  weekdays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 12,
  status: "active",
  goodsLimits: [
    {
      goodsId: "",
      quantity: 1
    }
  ]
});

const filteredUsers = computed(() => {
  const query = keyword.value.trim();

  return users.value.filter((user) => {
    if (roleFilter.value !== "all" && user.role !== roleFilter.value) {
      return false;
    }

    if (!query) {
      return true;
    }

    return [user.name, user.phone, user.tags.join(" "), user.neighborhood ?? ""]
      .join(" ")
      .includes(query);
  });
});

const selectedUsers = computed(() =>
  users.value.filter((user) => selectedUserIds.value.includes(user.id))
);

const selectedSpecialUsers = computed(() =>
  selectedUsers.value.filter((user) => user.role === "special")
);

const allFilteredSelected = computed(
  () =>
    filteredUsers.value.length > 0 &&
    filteredUsers.value.every((user) => selectedUserIds.value.includes(user.id))
);

const currentDrawerTitle = computed(() => {
  if (drawerMode.value === "create-user") {
    return "新增人员";
  }

  if (drawerMode.value === "edit-user") {
    return "编辑人员";
  }

  if (drawerMode.value === "create-policy") {
    return "新增策略模板";
  }

  if (drawerMode.value === "edit-policy") {
    return "编辑策略模板";
  }

  return "";
});

const formatRole = (role: UserRecord["role"]) =>
  role === "special" ? "特殊群体" : role === "merchant" ? "商户" : "管理员";

const formatWeekdays = (weekdays: number[]) => {
  const labelMap = new Map(weekdayOptions.map((item) => [item.value, item.label]));
  return weekdays
    .slice()
    .sort((left, right) => {
      const normalizedLeft = left === 0 ? 7 : left;
      const normalizedRight = right === 0 ? 7 : right;
      return normalizedLeft - normalizedRight;
    })
    .map((value) => labelMap.get(value) ?? String(value))
    .join("、");
};

const parseTags = (value: string) =>
  value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const goodsCatalogMap = computed(
  () => new Map(goodsCatalog.value.map((item) => [item.goodsId, item]))
);

const policySummary = (userId: string) => {
  const names = policies.value
    .filter((policy) => policy.applicableUserIds.includes(userId) && policy.status === "active")
    .map((policy) => policy.name);

  return names.length ? names.join("、") : "未绑定策略";
};

const resetUserForm = () => {
  userForm.value = {
    role: "special",
    phone: "",
    name: "",
    status: "active",
    neighborhood: "",
    tagsText: ""
  };
};

const resetPolicyForm = () => {
  policyForm.value = {
    name: "",
    weekdays: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 12,
    status: "active",
    goodsLimits: [
      {
        goodsId: goodsCatalog.value[0]?.goodsId ?? "",
        quantity: 1
      }
    ]
  };
};

const load = async () => {
  loading.value = true;
  try {
    const [usersResponse, policiesResponse, goodsCatalogResponse] = await Promise.all([
      adminApi.users(),
      adminApi.policies(),
      adminApi.goodsCatalog()
    ]);
    users.value = usersResponse;
    policies.value = policiesResponse;
    goodsCatalog.value = goodsCatalogResponse;

    if (!policyForm.value.goodsLimits[0]?.goodsId && goodsCatalogResponse[0]) {
      policyForm.value.goodsLimits[0].goodsId = goodsCatalogResponse[0].goodsId;
    }
  } finally {
    loading.value = false;
  }
};

const toggleSelectAll = () => {
  if (allFilteredSelected.value) {
    selectedUserIds.value = selectedUserIds.value.filter(
      (id) => !filteredUsers.value.some((user) => user.id === id)
    );
    return;
  }

  selectedUserIds.value = Array.from(
    new Set([...selectedUserIds.value, ...filteredUsers.value.map((user) => user.id)])
  );
};

const toggleUser = (userId: string) => {
  selectedUserIds.value = selectedUserIds.value.includes(userId)
    ? selectedUserIds.value.filter((id) => id !== userId)
    : [...selectedUserIds.value, userId];
};

const openCreateUser = () => {
  editingUserId.value = "";
  resetUserForm();
  drawerMode.value = "create-user";
};

const openEditUser = (user: UserRecord) => {
  editingUserId.value = user.id;
  userForm.value = {
    role: user.role,
    phone: user.phone,
    name: user.name,
    status: user.status,
    neighborhood: user.neighborhood ?? "",
    tagsText: user.tags.join("，")
  };
  drawerMode.value = "edit-user";
};

const openCreatePolicy = () => {
  editingPolicyId.value = "";
  resetPolicyForm();
  drawerMode.value = "create-policy";
};

const openEditPolicy = (policy: SpecialAccessPolicy) => {
  editingPolicyId.value = policy.id;
  policyForm.value = {
    name: policy.name,
    weekdays: [...policy.weekdays],
    startHour: policy.startHour,
    endHour: policy.endHour,
    status: policy.status,
    goodsLimits: policy.goodsLimits.map((limit) => ({
      goodsId: limit.goodsId,
      quantity: limit.quantity
    }))
  };
  drawerMode.value = "edit-policy";
};

const closeDrawer = () => {
  drawerMode.value = "";
  editingUserId.value = "";
  editingPolicyId.value = "";
};

const submitUserForm = async () => {
  saving.value = true;
  try {
    const payload = {
      role: userForm.value.role,
      phone: userForm.value.phone.trim(),
      name: userForm.value.name.trim(),
      status: userForm.value.status,
      neighborhood: userForm.value.neighborhood.trim() || undefined,
      tags: parseTags(userForm.value.tagsText)
    };

    if (drawerMode.value === "create-user") {
      await adminApi.createUser(payload);
    } else if (drawerMode.value === "edit-user" && editingUserId.value) {
      await adminApi.updateUser(editingUserId.value, {
        phone: payload.phone,
        name: payload.name,
        status: payload.status,
        neighborhood: payload.neighborhood,
        tags: payload.tags
      });
    }

    closeDrawer();
    await load();
  } finally {
    saving.value = false;
  }
};

const addPolicyGoodsLimit = () => {
  policyForm.value.goodsLimits.push({
    goodsId: goodsCatalog.value[0]?.goodsId ?? "",
    quantity: 1
  });
};

const removePolicyGoodsLimit = (index: number) => {
  policyForm.value.goodsLimits.splice(index, 1);
  if (!policyForm.value.goodsLimits.length) {
    addPolicyGoodsLimit();
  }
};

const submitPolicyForm = async () => {
  const normalizedWeekdays = Array.from(new Set(policyForm.value.weekdays)).sort((left, right) => left - right);
  const goodsLimits = policyForm.value.goodsLimits
    .filter((item) => item.goodsId && item.quantity > 0)
    .map((item) => {
      const catalogItem = goodsCatalogMap.value.get(item.goodsId);

      if (!catalogItem) {
        throw new Error(`未找到货品 ${item.goodsId}。`);
      }

      return {
        goodsId: catalogItem.goodsId,
        goodsName: catalogItem.name,
        category: catalogItem.category,
        quantity: item.quantity
      };
    });

  if (!normalizedWeekdays.length || !goodsLimits.length || policyForm.value.endHour <= policyForm.value.startHour) {
    return;
  }

  saving.value = true;
  try {
    const basePayload = {
      name: policyForm.value.name.trim(),
      weekdays: normalizedWeekdays,
      startHour: policyForm.value.startHour,
      endHour: policyForm.value.endHour,
      status: policyForm.value.status,
      goodsLimits
    };

    if (drawerMode.value === "create-policy") {
      await adminApi.createPolicy({
        ...basePayload,
        applicableUserIds: []
      });
    } else if (drawerMode.value === "edit-policy" && editingPolicyId.value) {
      const existing = policies.value.find((policy) => policy.id === editingPolicyId.value);

      await adminApi.updatePolicy(editingPolicyId.value, {
        ...basePayload,
        applicableUserIds: existing?.applicableUserIds ?? []
      });
    }

    closeDrawer();
    await load();
  } finally {
    saving.value = false;
  }
};

const applyBatchPolicies = async () => {
  if (!selectedSpecialUsers.value.length || !batchPolicyIds.value.length) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.batchAssignPolicies({
      userIds: selectedSpecialUsers.value.map((user) => user.id),
      policyIds: batchPolicyIds.value,
      mode: batchMode.value
    });
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
          <p class="admin-kicker">人员检索</p>
          <h3 class="admin-page__section-title">新增、编辑人员，并批量绑定特殊群体策略模板</h3>
        </div>
        <button class="admin-button" @click="openCreateUser">新增人员</button>
      </div>

      <div class="users-filters admin-panel admin-panel-block">
        <label class="admin-field">
          <span class="admin-field__label">分类</span>
          <select v-model="roleFilter" class="admin-select">
            <option value="all">全部</option>
            <option value="special">特殊群体</option>
            <option value="merchant">商户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">搜索</span>
          <input v-model="keyword" class="admin-input" placeholder="输入姓名、手机号、标签或片区" />
        </label>
        <div class="users-filters__summary admin-note">
          当前结果 {{ filteredUsers.length }} 人，已选 {{ selectedUserIds.length }} 人，其中特殊群体 {{ selectedSpecialUsers.length }} 人。
        </div>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">人员台账</span>
            <h3 class="admin-panel__title">姓名可进入详情，编辑可修改基础信息</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="toggleSelectAll">
            {{ allFilteredSelected ? "取消全选" : "全选当前结果" }}
          </button>
        </div>

        <table v-if="filteredUsers.length" class="admin-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>姓名</th>
              <th>角色</th>
              <th>手机号</th>
              <th>状态</th>
              <th>片区 / 标签</th>
              <th>策略模板</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in filteredUsers" :key="user.id">
              <td>
                <input type="checkbox" :checked="selectedUserIds.includes(user.id)" @change="toggleUser(user.id)" />
              </td>
              <td>
                <RouterLink class="admin-link" :to="`/users/${user.id}`">{{ user.name }}</RouterLink>
                <span class="admin-table__subtext">{{ user.id }}</span>
              </td>
              <td>{{ formatRole(user.role) }}</td>
              <td class="admin-code">{{ user.phone }}</td>
              <td>
                <span class="admin-pill" :class="user.status === 'active' ? 'admin-pill--success' : 'admin-pill--warning'">
                  {{ user.status === "active" ? "可操作" : "已暂停" }}
                </span>
              </td>
              <td>
                <span class="admin-table__strong">{{ user.neighborhood || "未分片区" }}</span>
                <span class="admin-table__subtext">{{ user.tags.join("、") || "无标签" }}</span>
              </td>
              <td>
                <span class="admin-table__strong">
                  {{ user.role === "special" ? policySummary(user.id) : "不适用" }}
                </span>
              </td>
              <td>
                <div class="admin-inline-links">
                  <RouterLink class="admin-link" :to="`/users/${user.id}`">详情</RouterLink>
                  <button class="admin-text-button" @click="openEditUser(user)">编辑</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
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
              <h3 class="admin-panel__title">只对已选特殊群体生效</h3>
            </div>
          </div>

          <div class="users-side-block">
            <div class="admin-note">
              已选特殊群体 {{ selectedSpecialUsers.length }} 人。绑定后会按策略模板的星期、时段和货品数量生效。
            </div>
            <label class="admin-field">
              <span class="admin-field__label">操作方式</span>
              <select v-model="batchMode" class="admin-select">
                <option value="bind">追加绑定</option>
                <option value="replace">替换为以下模板</option>
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
            <button class="admin-button" :disabled="saving || !selectedSpecialUsers.length || !batchPolicyIds.length" @click="applyBatchPolicies">
              {{ saving ? "保存中" : "应用批量策略设置" }}
            </button>
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
                <span class="admin-list__meta">
                  {{ formatWeekdays(policy.weekdays) }} · {{ String(policy.startHour).padStart(2, "0") }}:00-{{ String(policy.endHour).padStart(2, "0") }}:00 · {{ policy.applicableUserIds.length }} 人
                </span>
                <span class="admin-table__subtext">
                  {{ policy.goodsLimits.map((limit) => `${limit.goodsName} x${limit.quantity}`).join("，") }}
                </span>
              </div>
              <div class="admin-inline-links">
                <span class="admin-pill" :class="policy.status === 'active' ? 'admin-pill--success' : 'admin-pill--warning'">
                  {{ policy.status === "active" ? "启用中" : "已停用" }}
                </span>
                <button class="admin-text-button" @click="openEditPolicy(policy)">编辑</button>
              </div>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前还没有策略模板</div>
            <div class="admin-empty__body">请先新增模板，再批量绑定到特殊群体。</div>
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
              <option value="special">特殊群体</option>
              <option value="merchant">商户</option>
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
            <span class="admin-field__label">片区</span>
            <input v-model="userForm.neighborhood" class="admin-input" placeholder="例如扬名街道" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">标签</span>
            <input v-model="userForm.tagsText" class="admin-input" placeholder="多个标签请用中文逗号分隔" />
          </label>
          <button class="admin-button" :disabled="saving || !userForm.name || !userForm.phone" @click="submitUserForm">
            {{ saving ? "保存中" : "保存人员信息" }}
          </button>
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
                <option v-for="hour in hourOptions" :key="hour" :value="hour">
                  {{ String(hour).padStart(2, "0") }}:00
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">结束小时</span>
              <select v-model="policyForm.endHour" class="admin-select">
                <option v-for="hour in hourEndOptions" :key="hour" :value="hour">
                  {{ String(hour).padStart(2, "0") }}:00
                </option>
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
                  <option v-for="goods in goodsCatalog" :key="goods.goodsId" :value="goods.goodsId">
                    {{ goods.name }} / {{ goods.goodsId }}
                  </option>
                </select>
                <input v-model.number="limit.quantity" class="admin-input" type="number" min="1" />
                <button class="admin-button admin-button--ghost" @click="removePolicyGoodsLimit(index)">删除</button>
              </div>
            </div>
            <button class="admin-text-button" @click="addPolicyGoodsLimit">继续添加货品</button>
          </div>
          <div class="admin-note">
            时间段采用整点小时制，保存格式为 [开始小时, 结束小时)，例如 08:00-12:00。
          </div>
          <button
            class="admin-button"
            :disabled="saving || !policyForm.name || !policyForm.weekdays.length || policyForm.endHour <= policyForm.startHour"
            @click="submitPolicyForm"
          >
            {{ saving ? "保存中" : "保存策略模板" }}
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.users-filters,
.users-side-block,
.users-drawer__body,
.users-policy-limits {
  display: grid;
  gap: 10px;
}

.users-filters {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.users-filters__summary {
  align-self: end;
}

.users-policy-checklist,
.users-weekdays {
  display: grid;
  gap: 8px;
}

.users-policy-check,
.users-weekdays__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.users-policy-row {
  align-items: flex-start;
}

.users-policy-limit-row,
.users-hours {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px auto;
  gap: 8px;
}

.users-hours {
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
  .users-filters {
    grid-template-columns: 1fr;
  }

  .users-policy-limit-row,
  .users-hours {
    grid-template-columns: 1fr;
  }
}
</style>
