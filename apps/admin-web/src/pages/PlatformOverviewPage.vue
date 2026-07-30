<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import type {
  PlatformOverviewSnapshot,
  PlatformTenantCreatePayload,
  PlatformTenantProvisioningResult,
  PlatformTenantUpdatePayload,
  PlatformTenantUsageSummary
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/datetime";
import {
  validatePlatformTenantDraft,
  validatePlatformTenantUpdateDraft
} from "../utils/backoffice-provisioning";

const router = useRouter();
const sessionStore = useAdminSessionStore();
const loading = ref(false);
const creating = ref(false);
const updating = ref(false);
const enteringTenantId = ref("");
const editingTenantId = ref("");
const errorMessage = ref("");
const actionMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const overview = ref<PlatformOverviewSnapshot>();
const provisioned = ref<PlatformTenantProvisioningResult>();

const createForm = reactive<PlatformTenantCreatePayload>({
  code: "",
  name: "",
  status: "trial",
  instanceUrl: "",
  contactName: "",
  contactPhone: "",
  planName: "",
  firstAdmin: {
    name: "",
    phone: "",
    username: "",
    password: ""
  }
});
const editForm = reactive<PlatformTenantUpdatePayload>({
  name: "",
  status: "trial",
  instanceUrl: "",
  contactName: "",
  contactPhone: "",
  planName: ""
});

const tenants = computed(() => overview.value?.tenants ?? []);
const totals = computed(() => overview.value?.totals);
const canCreateTenant = computed(() => sessionStore.can("platform-tenants:manage"));
const editingTenant = computed(() =>
  tenants.value.find((entry) => entry.tenant.id === editingTenantId.value)
);

const statusLabel = (status: "active" | "trial" | "paused") => {
  if (status === "active") return "运行中";
  if (status === "trial") return "试运行";
  return "已暂停";
};

const resetCreateForm = () => {
  createForm.code = "";
  createForm.name = "";
  createForm.status = "trial";
  createForm.instanceUrl = "";
  createForm.contactName = "";
  createForm.contactPhone = "";
  createForm.planName = "";
  createForm.firstAdmin.name = "";
  createForm.firstAdmin.phone = "";
  createForm.firstAdmin.username = "";
  createForm.firstAdmin.password = "";
};

const resetEditForm = () => {
  editingTenantId.value = "";
  editForm.name = "";
  editForm.status = "trial";
  editForm.instanceUrl = "";
  editForm.contactName = "";
  editForm.contactPhone = "";
  editForm.planName = "";
};

const startEdit = (entry: PlatformTenantUsageSummary) => {
  actionMessage.value = null;
  editingTenantId.value = entry.tenant.id;
  editForm.name = entry.tenant.name;
  editForm.status = entry.tenant.status;
  editForm.instanceUrl = entry.tenant.instanceUrl ?? "";
  editForm.contactName = entry.tenant.contactName ?? "";
  editForm.contactPhone = entry.tenant.contactPhone ?? "";
  editForm.planName = entry.tenant.planName ?? "";
};

const updateTenant = async () => {
  if (!editingTenantId.value || updating.value) {
    return;
  }

  actionMessage.value = null;
  const validationMessage = validatePlatformTenantUpdateDraft(editForm);
  if (validationMessage) {
    actionMessage.value = { type: "error", text: validationMessage };
    return;
  }

  updating.value = true;
  try {
    const tenant = await adminApi.updatePlatformTenant(editingTenantId.value, {
      name: editForm.name.trim(),
      status: editForm.status,
      instanceUrl: editForm.instanceUrl.trim() || undefined,
      contactName: editForm.contactName.trim() || undefined,
      contactPhone: editForm.contactPhone.trim() || undefined,
      planName: editForm.planName.trim() || undefined
    });
    resetEditForm();
    actionMessage.value = { type: "success", text: `实例“${tenant.name}”资料已更新。` };
    await load();
  } catch (error) {
    actionMessage.value = {
      type: "error",
      text: error instanceof Error ? error.message : "客户实例资料更新失败。"
    };
  } finally {
    updating.value = false;
  }
};

const load = async () => {
  loading.value = true;
  errorMessage.value = "";

  try {
    overview.value = await adminApi.platformOverview();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "服务商总览加载失败。";
  } finally {
    loading.value = false;
  }
};

const createTenant = async () => {
  actionMessage.value = null;
  provisioned.value = undefined;
  const validationMessage = validatePlatformTenantDraft(createForm);

  if (validationMessage) {
    actionMessage.value = { type: "error", text: validationMessage };
    return;
  }

  creating.value = true;
  try {
    const result = await adminApi.createPlatformTenant({
      code: createForm.code.trim().toLowerCase(),
      name: createForm.name.trim(),
      status: createForm.status,
      instanceUrl: createForm.instanceUrl.trim() || undefined,
      contactName: createForm.contactName.trim() || undefined,
      contactPhone: createForm.contactPhone.trim() || undefined,
      planName: createForm.planName.trim() || undefined,
      firstAdmin: {
        name: createForm.firstAdmin.name.trim(),
        phone: createForm.firstAdmin.phone.trim(),
        username: createForm.firstAdmin.username.trim().toLowerCase(),
        password: createForm.firstAdmin.password
      }
    });
    provisioned.value = result;
    actionMessage.value = {
      type: "success",
      text: `实例“${result.tenant.name}”及首管理员已原子创建。密码不会在页面再次显示。`
    };
    resetCreateForm();
    await load();
  } catch (error) {
    actionMessage.value = {
      type: "error",
      text: error instanceof Error ? error.message : "客户实例创建失败。"
    };
  } finally {
    creating.value = false;
  }
};

const enterTenant = async (tenantId: string, tenantName: string) => {
  if (enteringTenantId.value) {
    return;
  }

  actionMessage.value = null;
  enteringTenantId.value = tenantId;
  try {
    const session = await adminApi.enterPlatformTenant(tenantId);
    sessionStore.setSession(session);
    await router.replace(sessionStore.can("users:view") ? "/users" : sessionStore.defaultPath);
  } catch (error) {
    actionMessage.value = {
      type: "error",
      text: error instanceof Error ? error.message : `进入实例“${tenantName}”失败。`
    };
  } finally {
    enteringTenantId.value = "";
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-grid admin-grid--four">
      <article class="admin-panel stat-card">
        <span class="admin-kicker">客户实例</span>
        <strong>{{ totals?.tenants ?? 0 }}</strong>
        <span class="admin-copy">运行中 {{ totals?.activeTenants ?? 0 }}</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">柜机总数</span>
        <strong>{{ totals?.devices ?? 0 }}</strong>
        <span class="admin-copy">在线 {{ totals?.onlineDevices ?? 0 }}</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">服务对象</span>
        <strong>{{ totals?.users ?? 0 }}</strong>
        <span class="admin-copy">商家 {{ totals?.merchants ?? 0 }}</span>
      </article>
      <article class="admin-panel stat-card">
        <span class="admin-kicker">待处理事项</span>
        <strong>{{ totals?.pendingTasks ?? 0 }}</strong>
        <span class="admin-copy">跨实例汇总</span>
      </article>
    </section>

    <section v-if="canCreateTenant" class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">实例开通</p>
          <h3 class="admin-page__section-title">一次创建客户实例与首管理员</h3>
        </div>
      </div>

      <form class="admin-panel admin-panel-block platform-create" @submit.prevent="createTenant">
        <div class="admin-note">
          实例、首管理员人员记录和后台凭据会在同一事务边界内保存；任何一步失败都不会留下半成品。
        </div>
        <div class="platform-create__grid">
          <label class="admin-field">
            <span class="admin-field__label">实例编码</span>
            <input
              v-model.trim="createForm.code"
              class="admin-input"
              maxlength="50"
              autocomplete="off"
              placeholder="例如 wuxi-community"
              required
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">实例名称</span>
            <input
              v-model.trim="createForm.name"
              class="admin-input"
              maxlength="100"
              placeholder="客户或运营单位名称"
              required
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">运行状态</span>
            <select v-model="createForm.status" class="admin-select">
              <option value="trial">试运行</option>
              <option value="active">运行中</option>
              <option value="paused">暂停</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">实例地址（选填）</span>
            <input
              v-model.trim="createForm.instanceUrl"
              class="admin-input"
              type="url"
              placeholder="https://example.com"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">联系人（选填）</span>
            <input v-model.trim="createForm.contactName" class="admin-input" maxlength="100" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">联系人手机号（选填）</span>
            <input
              v-model.trim="createForm.contactPhone"
              class="admin-input"
              inputmode="numeric"
              maxlength="11"
              autocomplete="off"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">服务方案（选填）</span>
            <input v-model.trim="createForm.planName" class="admin-input" maxlength="100" />
          </label>
        </div>

        <div class="platform-create__admin">
          <div>
            <span class="admin-kicker">首管理员</span>
            <p class="admin-copy">创建后可由该管理员继续建立商户、补货员、柜机及其授权关系。</p>
          </div>
          <div class="platform-create__grid">
            <label class="admin-field">
              <span class="admin-field__label">姓名</span>
              <input
                v-model.trim="createForm.firstAdmin.name"
                class="admin-input"
                maxlength="100"
                required
              />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">手机号</span>
              <input
                v-model.trim="createForm.firstAdmin.phone"
                class="admin-input"
                inputmode="numeric"
                maxlength="11"
                autocomplete="off"
                required
              />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">后台登录账号</span>
              <input
                v-model.trim="createForm.firstAdmin.username"
                class="admin-input"
                maxlength="100"
                autocomplete="off"
                required
              />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">首次密码</span>
              <input
                v-model="createForm.firstAdmin.password"
                class="admin-input"
                type="password"
                minlength="12"
                autocomplete="new-password"
                placeholder="至少 12 位"
                required
              />
            </label>
          </div>
        </div>

        <div
          v-if="actionMessage"
          class="admin-alert"
          :class="{ 'admin-alert--danger': actionMessage.type === 'error' }"
          :role="actionMessage.type === 'error' ? 'alert' : 'status'"
          aria-live="polite"
        >
          {{ actionMessage.text }}
        </div>
        <div v-if="provisioned" class="admin-note">
          首管理员账号：{{ provisioned.firstAdmin.username }} ·
          实例：{{ provisioned.tenant.name }}。请通过安全渠道交付首次密码。
        </div>
        <button class="admin-button platform-create__submit" type="submit" :disabled="creating">
          {{ creating ? "创建中..." : "创建实例与首管理员" }}
        </button>
      </form>
    </section>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">客户实例</p>
          <h3 class="admin-page__section-title">选择实例后进入其独立管理范围</h3>
        </div>
        <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
          {{ loading ? "刷新中" : "刷新" }}
        </button>
      </div>

      <div v-if="errorMessage" class="admin-note platform-overview__error">{{ errorMessage }}</div>
      <div
        v-if="actionMessage && actionMessage.type === 'error' && !canCreateTenant"
        class="admin-alert admin-alert--danger"
        role="alert"
      >
        {{ actionMessage.text }}
      </div>

      <article class="admin-panel admin-panel-block platform-table-wrap">
        <table v-if="tenants.length" class="admin-table">
          <thead>
            <tr>
              <th>公司实例</th>
              <th>状态</th>
              <th>柜机</th>
              <th>人员</th>
              <th>库存/领取</th>
              <th>最后活动</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in tenants" :key="entry.tenant.id">
              <td>
                <span class="admin-table__strong">{{ entry.tenant.name }}</span>
                <span class="admin-table__subtext">{{ entry.tenant.code }} · {{ entry.tenant.instanceUrl ?? "未配置实例地址" }}</span>
              </td>
              <td>
                <span class="admin-pill" :class="entry.tenant.status === 'active' ? 'admin-pill--success' : entry.tenant.status === 'trial' ? 'admin-pill--warning' : 'admin-pill--neutral'">
                  {{ statusLabel(entry.tenant.status) }}
                </span>
              </td>
              <td>{{ entry.metrics.onlineDevices }}/{{ entry.metrics.devices }}</td>
              <td>{{ entry.metrics.users }} 人 / 商家 {{ entry.metrics.merchants }}</td>
              <td>{{ entry.metrics.inventoryUnits }} 件 / 领取 {{ entry.metrics.pickupCount }}</td>
              <td class="admin-code">{{ entry.lastActivityAt ? formatDateTime(entry.lastActivityAt) : "-" }}</td>
              <td>
                <div class="platform-row-actions">
                  <button
                    class="admin-button admin-button--ghost"
                    :disabled="!canCreateTenant || updating"
                    @click="startEdit(entry)"
                  >
                    维护实例
                  </button>
                  <button
                    class="admin-button admin-button--ghost"
                    :disabled="Boolean(enteringTenantId) || entry.tenant.status === 'paused'"
                    @click="enterTenant(entry.tenant.id, entry.tenant.name)"
                  >
                    {{ enteringTenantId === entry.tenant.id ? "进入中..." : entry.tenant.status === "paused" ? "实例已暂停" : "进入实例" }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载客户实例" : "暂无客户实例" }}</div>
          <div class="admin-empty__body">请先创建客户实例与首管理员，再进入实例配置角色、柜机和权限。</div>
        </div>
      </article>
    </section>

    <section v-if="editingTenant" class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">实例维护</p>
          <h3 class="admin-page__section-title">维护 {{ editingTenant.tenant.name }}</h3>
        </div>
      </div>
      <form class="admin-panel admin-panel-block platform-create" @submit.prevent="updateTenant">
        <div class="admin-note">
          实例编码和首管理员保持不变。暂停实例会阻止服务商再次进入该实例，现有业务记录不会删除。
        </div>
        <div class="platform-create__grid">
          <label class="admin-field">
            <span class="admin-field__label">实例编码</span>
            <input class="admin-input" :value="editingTenant.tenant.code" readonly aria-readonly="true" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">实例名称</span>
            <input v-model="editForm.name" class="admin-input" maxlength="100" required />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">运行状态</span>
            <select v-model="editForm.status" class="admin-select">
              <option value="trial">试运行</option>
              <option value="active">运行中</option>
              <option value="paused">暂停</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">实例地址（选填）</span>
            <input v-model="editForm.instanceUrl" class="admin-input" type="url" placeholder="https://example.com" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">联系人（选填）</span>
            <input v-model="editForm.contactName" class="admin-input" maxlength="100" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">联系人手机号（选填）</span>
            <input v-model="editForm.contactPhone" class="admin-input" inputmode="numeric" maxlength="11" autocomplete="off" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">服务方案（选填）</span>
            <input v-model="editForm.planName" class="admin-input" maxlength="100" />
          </label>
        </div>
        <div v-if="actionMessage?.type === 'error'" class="admin-alert admin-alert--danger" role="alert">
          {{ actionMessage.text }}
        </div>
        <div class="platform-row-actions">
          <button class="admin-button" type="submit" :disabled="updating">
            {{ updating ? "保存中..." : "保存实例资料" }}
          </button>
          <button class="admin-button admin-button--ghost" type="button" :disabled="updating" @click="resetEditForm">
            取消
          </button>
        </div>
      </form>
    </section>
  </section>
</template>

<style scoped>
.stat-card {
  display: grid;
  gap: 8px;
}

.stat-card strong {
  font-size: 2rem;
  line-height: 1;
  color: var(--admin-text);
}

.platform-create,
.platform-create__admin {
  display: grid;
  gap: 14px;
}

.platform-create__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.platform-create__admin {
  padding-top: 14px;
  border-top: 1px solid var(--admin-line);
}

.platform-create__admin p {
  margin: 4px 0 0;
}

.platform-create__submit {
  justify-self: start;
}

.platform-table-wrap {
  overflow-x: auto;
}

.platform-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.platform-overview__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}

@media (max-width: 760px) {
  .platform-create__grid {
    grid-template-columns: 1fr;
  }

  .platform-create__submit {
    width: 100%;
  }
}
</style>
