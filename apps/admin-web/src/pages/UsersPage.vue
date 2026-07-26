<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import {
  BACKOFFICE_PERMISSIONS,
  BACKOFFICE_ROLE_ALLOWED_PERMISSIONS,
  BACKOFFICE_ROLE_DEFAULT_PERMISSIONS,
  type BackofficeCredentialSnapshot,
  type BackofficePermission,
  type BackofficeRole,
  type GoodsCatalogItem,
  type RegionRecord,
  type RegistrationApplication,
  type ReservationSettings,
  type SpecialAccessPolicy,
  type UserLedgerStatus,
  type UserRecord
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import AmapLocationPicker from "../components/AmapLocationPicker.vue";
import { adminCopy } from "../constants/copy";
import { useAdminSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";

type DrawerMode = "" | "create-user" | "edit-user" | "create-policy" | "edit-policy" | "backoffice-account";
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

interface BackofficeFormState {
  userId: string;
  userName: string;
  role: BackofficeRole;
  username: string;
  password: string;
  permissions: BackofficePermission[];
  hasExistingCredential: boolean;
}

interface ReservationFormState {
  enabled: boolean;
  holdMinutes: number;
  maxTimeouts: number;
}

const backofficeRoleLabels: Record<BackofficeRole, string> = {
  super_admin: "程序提供商",
  admin: "管理员",
  merchant: "商家"
};

const permissionLabels: Record<BackofficePermission, string> = {
  "platform-overview:view": "全局工作台",
  "platform-tenants:view": "客户实例列表",
  "merchant-workbench:view": "商家工作台",
  "merchant-workbench:manage": "商家补货管理",
  "dashboard:view": "运营主控台",
  "goods:view": "货品与批次",
  "goods:manage": "货品资料管理",
  "goods:stock-adjust": "货品库存调整",
  "goods:export": "导出货品数据",
  "warehouse:view": "本地仓库",
  "warehouse:transfer": "仓库调拨",
  "warehouse:stocktake": "仓库盘点",
  "warehouse:dispose-expired": "过期库存处置",
  "warehouse:export": "导出仓库盘点",
  "devices:view": "柜机监控",
  "devices:manage": "柜机资料管理",
  "devices:operate": "柜机操作",
  "users:view": "人员与取货规则",
  "users:manage": "人员台账管理",
  "users:review": "注册审核",
  "users:rules:manage": "取货规则管理",
  "reservations:manage": "预约规则管理",
  "alerts:manage": "预警处理",
  "payments:refund": "退款与支付处理",
  "operation-logs:view": "操作日志",
  "operation-logs:export": "导出操作日志",
  "operation-logs:undo": "撤销操作日志",
  "system-audit:view": "系统审计",
  "system-audit:export": "导出系统审计",
  "analytics:data-monitor:view": "数据监控",
  "ai-insights:view": "AI 工作台",
  "ai-insights:manage": "AI 配置",
  "system-settings:view": "系统设置查看",
  "system-settings:secret:view": "查看敏感配置",
  "system-settings:update": "系统设置修改",
  "uploads:images": "图片上传",
  "backoffice-credentials:manage": "后台账号权限配置"
};

const permissionGroups: Array<{ title: string; permissions: BackofficePermission[] }> = [
  {
    title: "工作台",
    permissions: [
      "platform-overview:view",
      "platform-tenants:view",
      "dashboard:view",
      "merchant-workbench:view",
      "merchant-workbench:manage"
    ]
  },
  {
    title: "日常业务",
    permissions: [
      "goods:view",
      "goods:manage",
      "goods:stock-adjust",
      "goods:export",
      "warehouse:view",
      "warehouse:transfer",
      "warehouse:stocktake",
      "warehouse:dispose-expired",
      "warehouse:export",
      "devices:view",
      "devices:manage",
      "devices:operate",
      "users:view",
      "users:manage",
      "users:review",
      "users:rules:manage",
      "reservations:manage",
      "alerts:manage",
      "payments:refund",
      "operation-logs:view",
      "operation-logs:export",
      "operation-logs:undo"
    ]
  },
  {
    title: "数据与智能",
    permissions: ["analytics:data-monitor:view", "ai-insights:view", "ai-insights:manage"]
  },
  {
    title: "配置与审计",
    permissions: [
      "system-settings:view",
      "system-settings:update",
      "system-settings:secret:view",
      "uploads:images",
      "system-audit:view",
      "system-audit:export",
      "backoffice-credentials:manage"
    ]
  }
];

const createEmptyBackofficeForm = (): BackofficeFormState => ({
  userId: "",
  userName: "",
  role: "admin",
  username: "",
  password: "",
  permissions: [],
  hasExistingCredential: false
});

const sessionStore = useAdminSessionStore();
const router = useRouter();
const users = ref<UserRecord[]>([]);
const registrationApplications = ref<RegistrationApplication[]>([]);
const policies = ref<SpecialAccessPolicy[]>([]);
const goodsCatalog = ref<GoodsCatalogItem[]>([]);
const regions = ref<RegionRecord[]>([]);
const backofficeCredentials = ref<BackofficeCredentialSnapshot[]>([]);
const reservationSettings = ref<ReservationSettings | null>(null);
const loading = ref(false);
const registrationApplicationsError = ref("");
const saving = ref(false);
const reservationSaving = ref(false);
const reviewingApplicationId = ref("");
const removingUserId = ref("");
const removingSelectedUsers = ref(false);
const creatingRegion = ref(false);
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
const regionDraftName = ref("");
const regionDraftSortOrder = ref<number | undefined>(undefined);
const regionDraftLongitude = ref<number | undefined>(undefined);
const regionDraftLatitude = ref<number | undefined>(undefined);
const regionDraftLocation = ref("");
const regionDraftAddress = ref("");
const regionMapPickerVisible = ref(false);
const rejectReasons = ref<Record<string, string>>({});
const userForm = ref<UserFormState>({ role: "special", phone: "", name: "", status: "active", regionId: "", regionName: "", tagsText: "" });
const policyForm = ref<PolicyFormState>({ name: "", weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 12, status: "active", goodsLimits: [{ goodsId: "", quantity: 1 }] });
const backofficeForm = ref<BackofficeFormState>(createEmptyBackofficeForm());
const reservationForm = ref<ReservationFormState>({ enabled: false, holdMinutes: 15, maxTimeouts: 3 });
const reservationMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const actionMessage = ref<{ type: "success" | "error"; text: string } | null>(null);

const showActionMessage = (type: "success" | "error", text: string) => {
  actionMessage.value = { type, text };
};

const regionOptions = computed(() => regions.value.filter((item) => item.status === "active"));
const goodsCatalogMap = computed(() => new Map(goodsCatalog.value.map((item) => [item.goodsId, item])));
const pendingRegistrationCount = computed(() => registrationApplications.value.filter((item) => item.status === "pending").length);
const specialUserCount = computed(() => users.value.filter((user) => user.role === "special").length);
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
const editingUser = computed(() => users.value.find((user) => user.id === editingUserId.value));
const editingCurrentUser = computed(
  () =>
    drawerMode.value === "edit-user" &&
    Boolean(editingUserId.value) &&
    editingUserId.value === sessionStore.user?.id
);
const currentDrawerTitle = computed(() =>
  drawerMode.value === "create-user"
    ? "新增人员"
    : drawerMode.value === "edit-user"
      ? "编辑人员"
      : drawerMode.value === "create-policy"
        ? "新增每日物资模板"
        : drawerMode.value === "edit-policy"
          ? "编辑每日物资模板"
          : drawerMode.value === "backoffice-account"
            ? "后台账号权限"
            : ""
);
const isUserMutating = computed(() => saving.value || Boolean(removingUserId.value));
const canManageBackofficeCredentials = computed(() => sessionStore.can("backoffice-credentials:manage"));
const canUpdateReservationSettings = computed(() => sessionStore.user?.role === "admin" && sessionStore.can("reservations:manage"));
const canManageUsers = computed(() => sessionStore.can("users:manage"));
const canManageUserRules = computed(() => sessionStore.can("users:rules:manage"));
const canReviewRegistrations = computed(() => sessionStore.can("users:review"));
const isProviderBackoffice = computed(() => sessionStore.user?.backofficeRole === "super_admin");
const allowedBackofficePermissions = computed(
  () => {
    if (backofficeForm.value.role === "super_admin") {
      return new Set(BACKOFFICE_ROLE_ALLOWED_PERMISSIONS.super_admin);
    }

    const actorPermissions = new Set(sessionStore.permissions);
    return new Set(
      BACKOFFICE_ROLE_ALLOWED_PERMISSIONS[backofficeForm.value.role].filter((permission) =>
        actorPermissions.has(permission)
      )
    );
  }
);
const visiblePermissionGroups = computed(() =>
  permissionGroups
    .map((group) => ({
      ...group,
      permissions: group.permissions.filter((permission) => allowedBackofficePermissions.value.has(permission))
    }))
    .filter((group) => group.permissions.length > 0)
);
const visibleRegionNames = computed(() => {
  const names = new Set<string>();
  users.value.forEach((user) => names.add(user.regionName || "未分配区域"));
  return Array.from(names).sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
});
const backofficeTargetUser = computed(() =>
  users.value.find((user) => user.id === backofficeForm.value.userId)
);
const availableBackofficeRoles = computed(() =>
  backofficeTargetUser.value ? backofficeRolesForUser(backofficeTargetUser.value) : []
);
const canChooseBackofficeRole = computed(() => availableBackofficeRoles.value.length > 1);
const regionDraftPositionSummary = computed(() => {
  if (regionDraftLongitude.value === undefined || regionDraftLatitude.value === undefined) {
    return "尚未在地图上设置位置";
  }

  const coordinates = `${regionDraftLongitude.value.toFixed(6)}, ${regionDraftLatitude.value.toFixed(6)}`;
  return regionDraftLocation.value.trim()
    ? `${regionDraftLocation.value.trim()} · ${coordinates}`
    : coordinates;
});
const configuredSpecialUserCount = computed(() =>
  users.value.filter((user) => user.role === "special" && policySummary(user.id) !== "未设置").length
);
const reservationStatusLabel = computed(() =>
  reservationForm.value.enabled
    ? `已开启，预约保留 ${reservationForm.value.holdMinutes} 分钟`
    : "未开启，小程序只能现场开柜"
);
const firstConfigTargetUser = computed(() =>
  users.value.find((user) => user.role === "special" && policySummary(user.id) === "未设置") ??
  users.value.find((user) => user.role === "special")
);

const formatRole = (role: UserRecord["role"]) => role === "special" ? "特殊群体" : role === "merchant" ? "商家" : "管理员";
const formatLedgerStatus = (status?: UserLedgerStatus) => status === "unregistered" ? "未注册" : status === "quota_unclaimed" ? "物资未领取" : status === "quota_partial" ? "部分领取" : status === "quota_complete" ? "全部领取" : "已注册";
const ledgerStatusTone = (status?: UserLedgerStatus) => status === "quota_complete" ? "admin-pill--success" : status === "quota_partial" || status === "unregistered" ? "admin-pill--warning" : "admin-pill--neutral";
const registrationLabel = (user: UserRecord) => (user.ledgerStatus === "unregistered" ? "未注册" : "已注册");
const parseTags = (value: string) => value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
const formatWeekdays = (weekdays: number[]) => weekdays.slice().sort((left, right) => (left === 0 ? 7 : left) - (right === 0 ? 7 : right)).map((value) => weekdayOptions.find((item) => item.value === value)?.label ?? String(value)).join("、");
const policySummary = (userId: string) => {
  const user = users.value.find((item) => item.id === userId);
  const directCount = user?.accessPolicies?.filter((policy) => policy.status === "active").length ?? 0;
  if (directCount > 0) {
    return `每日物资 ${directCount} 条`;
  }

  const inheritedNames = policies.value
    .filter((policy) => policy.applicableUserIds.includes(userId) && policy.status === "active")
    .map((policy) => policy.name);
  return inheritedNames.length ? `模板：${inheritedNames.join("、")}` : "未设置";
};

function backofficeRolesForUser(user: UserRecord): BackofficeRole[] {
  if (user.role === "merchant") {
    return ["merchant"];
  }

  if (user.role !== "admin") {
    return [];
  }

  return isProviderBackoffice.value ? ["admin", "super_admin"] : ["admin"];
}

const isBackofficeEligibleUser = (user: UserRecord) => backofficeRolesForUser(user).length > 0;

const defaultBackofficeRoleForUser = (user: UserRecord): BackofficeRole =>
  backofficeCredentials.value.find((credential) => credential.userId === user.id)?.role ??
  backofficeRolesForUser(user)[0] ??
  (user.role === "merchant" ? "merchant" : "admin");

const backofficeCredentialsForUser = (user: UserRecord) =>
  backofficeCredentials.value.filter((credential) => credential.userId === user.id);

const backofficeCredentialForUser = (user: UserRecord, role = defaultBackofficeRoleForUser(user)) =>
  backofficeCredentials.value.find(
    (credential) => credential.userId === user.id && credential.role === role
  );

const backofficeStatusLabel = (user: UserRecord) => {
  if (!isBackofficeEligibleUser(user)) {
    return "不适用";
  }

  const credentials = backofficeCredentialsForUser(user);
  return credentials.length
    ? credentials
      .map((credential) => `${backofficeRoleLabels[credential.role]} ${credential.permissions.length} 项`)
      .join(" / ")
    : "未开通";
};

const defaultBackofficeUsername = (user: UserRecord, role: BackofficeRole) =>
  role === "super_admin" ? `${user.phone}-provider` : user.phone;

const defaultPermissionsForRole = (role: BackofficeRole) =>
  role === "super_admin"
    ? [...BACKOFFICE_ROLE_DEFAULT_PERMISSIONS.super_admin]
    : BACKOFFICE_ROLE_DEFAULT_PERMISSIONS[role].filter((permission) =>
      sessionStore.permissions.includes(permission)
    );

const fillBackofficeFormForRole = (user: UserRecord, role: BackofficeRole) => {
  const credential = backofficeCredentialForUser(user, role);
  backofficeForm.value = {
    userId: user.id,
    userName: user.name,
    role,
    username: credential?.username ?? defaultBackofficeUsername(user, role),
    password: "",
    permissions: credential?.permissions.length
      ? [...credential.permissions]
      : defaultPermissionsForRole(role),
    hasExistingCredential: Boolean(credential)
  };
  normalizeBackofficeFormPermissions();
};

const normalizeBackofficeFormPermissions = () => {
  if (backofficeForm.value.role === "super_admin") {
    backofficeForm.value.permissions = [...BACKOFFICE_ROLE_DEFAULT_PERMISSIONS.super_admin];
    return;
  }

  const allowed = allowedBackofficePermissions.value;
  backofficeForm.value.permissions = Array.from(
    new Set(backofficeForm.value.permissions.filter((permission) => allowed.has(permission)))
  );
};

const toggleAllBackofficePermissions = (checked: boolean) => {
  if (backofficeForm.value.role === "super_admin") {
    backofficeForm.value.permissions = [...BACKOFFICE_ROLE_DEFAULT_PERMISSIONS.super_admin];
    return;
  }

  backofficeForm.value.permissions = checked
    ? BACKOFFICE_PERMISSIONS.filter((permission) => allowedBackofficePermissions.value.has(permission))
    : [];
};

const resetUserForm = () => {
  userForm.value = { role: "special", phone: "", name: "", status: "active", regionId: "", regionName: "", tagsText: "" };
};
const fillUserForm = (user: UserRecord) => {
  const matchedRegion =
    regions.value.find((item) => item.id === user.regionId) ??
    regions.value.find((item) => item.name === (user.regionName ?? user.neighborhood));
  userForm.value = {
    role: user.role,
    phone: user.phone,
    name: user.name,
    status: user.status,
    regionId: matchedRegion?.id ?? "",
    regionName: matchedRegion?.name ?? "",
    tagsText: user.tags.join("，")
  };
};
const resetPolicyForm = () => {
  policyForm.value = { name: "", weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 12, status: "active", goodsLimits: [{ goodsId: goodsCatalog.value[0]?.goodsId ?? "", quantity: 1 }] };
};
const resetRegionDraft = () => {
  regionDraftName.value = "";
  regionDraftSortOrder.value = undefined;
  regionDraftLongitude.value = undefined;
  regionDraftLatitude.value = undefined;
  regionDraftLocation.value = "";
  regionDraftAddress.value = "";
};
const resolveRegionPayload = (state: UserFormState) => {
  if (!state.regionId) return { regionId: undefined, regionName: undefined };
  const region = regions.value.find((item) => item.id === state.regionId);
  return { regionId: region?.id, regionName: region?.name };
};

const applyReservationSettings = (settings: ReservationSettings) => {
  reservationSettings.value = settings;
  reservationForm.value = {
    enabled: settings.enabled,
    holdMinutes: settings.holdMinutes,
    maxTimeouts: settings.maxTimeouts
  };
};

const loadReservationSettings = async () => {
  try {
    const settings = await adminApi.reservationSettings();
    applyReservationSettings(settings);
    if (reservationMessage.value?.type === "error") {
      reservationMessage.value = null;
    }
  } catch (error) {
    reservationMessage.value = {
      type: "error",
      text: error instanceof Error ? `预约设置加载失败：${error.message}` : "预约设置加载失败"
    };
  }
};

const saveReservationSettings = async () => {
  if (reservationForm.value.holdMinutes < 1 || reservationForm.value.maxTimeouts < 1) {
    reservationMessage.value = { type: "error", text: "预约保留分钟数和连续超时限制都必须大于 0。" };
    return;
  }

  reservationSaving.value = true;
  try {
    const settings = await adminApi.saveReservationSettings({
      enabled: reservationForm.value.enabled,
      holdMinutes: reservationForm.value.holdMinutes,
      maxTimeouts: reservationForm.value.maxTimeouts
    });
    applyReservationSettings(settings);
    reservationMessage.value = { type: "success", text: "预约规则已保存。" };
  } catch (error) {
    reservationMessage.value = {
      type: "error",
      text: error instanceof Error ? `预约规则保存失败：${error.message}` : "预约规则保存失败"
    };
  } finally {
    reservationSaving.value = false;
  }
};

const load = async () => {
  loading.value = true;
  try {
    const [
      usersResponse,
      applicationResponse,
      policiesResponse,
      goodsCatalogResponse,
      regionsResponse,
      backofficeCredentialsResponse,
      reservationSettingsResponse
    ] = await Promise.all([
      adminApi.users(),
      loadRegistrationApplications(),
      adminApi.policies(),
      adminApi.goodsCatalog(),
      adminApi.regions(),
      canManageBackofficeCredentials.value ? adminApi.backofficeCredentials() : Promise.resolve([]),
      adminApi.reservationSettings().catch((error) => {
        reservationMessage.value = {
          type: "error",
          text: error instanceof Error ? `预约设置加载失败：${error.message}` : "预约设置加载失败"
        };
        return null;
      })
    ]);
    users.value = usersResponse;
    if (applicationResponse) {
      registrationApplications.value = applicationResponse;
    }
    policies.value = policiesResponse;
    goodsCatalog.value = goodsCatalogResponse;
    regions.value = regionsResponse;
    backofficeCredentials.value = backofficeCredentialsResponse;
    if (reservationSettingsResponse) applyReservationSettings(reservationSettingsResponse);
    if (!policyForm.value.goodsLimits[0]?.goodsId && goodsCatalogResponse[0]) policyForm.value.goodsLimits[0].goodsId = goodsCatalogResponse[0].goodsId;
  } catch (error) {
    showActionMessage("error", `人员与规则数据加载失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    loading.value = false;
  }
};

async function loadRegistrationApplications() {
  registrationApplicationsError.value = "";
  try {
    const response = await adminApi.registrationApplications();
    registrationApplications.value = response;
    return response;
  } catch (error) {
    registrationApplicationsError.value = readErrorMessage(error, "审核数据加载失败，请稍后重试");
    return null;
  }
}

const reviewApplication = async (applicationId: string, decision: "approved" | "rejected") => {
  if (reviewingApplicationId.value) {
    return;
  }

  const application = registrationApplications.value.find((entry) => entry.id === applicationId);
  const applicantName = application?.profile.merchantName || application?.profile.name || application?.phone || applicationId;
  const roleName = application?.requestedRole === "special" ? "用户" : application?.requestedRole === "merchant" ? "商家" : "管理员";
  const confirmed = window.confirm(
    [
      decision === "approved" ? "请确认通过注册申请：" : "请确认驳回注册申请：",
      `申请人：${applicantName}`,
      `申请角色：${roleName}`,
      decision === "rejected" ? `驳回原因：${rejectReasons.value[applicationId]?.trim() || "未填写"}` : "通过后将立即生效。"
    ].join("\n")
  );

  if (!confirmed) {
    return;
  }

  reviewingApplicationId.value = applicationId;
  saving.value = true;
  actionMessage.value = null;
  try {
    const reviewed = await adminApi.reviewRegistration(applicationId, { decision, reason: decision === "rejected" ? rejectReasons.value[applicationId] : undefined });
    registrationApplications.value = registrationApplications.value.map((item) => item.id === reviewed.id ? reviewed : item);
    delete rejectReasons.value[applicationId];
    await load();
    showActionMessage(
      "success",
      decision === "approved"
        ? `已通过 ${application?.profile.name || application?.phone || "该申请"}，人员已进入已登记列表。`
        : `已驳回 ${application?.profile.name || application?.phone || "该申请"}，申请人可按原因修改后重新提交。`
    );
  } catch (error) {
    showActionMessage("error", `审核失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    reviewingApplicationId.value = "";
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
const openBackofficeAccount = (user: UserRecord) => {
  if (!isBackofficeEligibleUser(user)) {
    return;
  }

  const role = defaultBackofficeRoleForUser(user);
  fillBackofficeFormForRole(user, role);
  drawerMode.value = "backoffice-account";
};

const changeBackofficeRole = (role: BackofficeRole) => {
  const user = backofficeTargetUser.value;
  if (!user) {
    return;
  }

  fillBackofficeFormForRole(user, role);
};
const closeDrawer = () => {
  drawerMode.value = "";
  editingUserId.value = "";
  editingPolicyId.value = "";
  backofficeForm.value = createEmptyBackofficeForm();
};

const submitUserForm = async (configureAccess = false) => {
  const regionPayload = resolveRegionPayload(userForm.value);
  const isCreate = drawerMode.value === "create-user";
  if (
    editingCurrentUser.value &&
    editingUser.value &&
    (
      userForm.value.role !== editingUser.value.role ||
      userForm.value.status !== "active"
    )
  ) {
    showActionMessage("error", "不能修改当前登录账号的角色或停用当前账号，请由其他管理员处理。");
    return;
  }
  saving.value = true;
  actionMessage.value = null;
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
    let savedUser: UserRecord | undefined;
    if (drawerMode.value === "create-user") {
      savedUser = await adminApi.createUser(payload);
    } else if (drawerMode.value === "edit-user" && editingUserId.value) {
      savedUser = await adminApi.updateUser(editingUserId.value, payload);
    }
    closeDrawer();
    await load();
    showActionMessage("success", isCreate ? `已新增人员 ${payload.name}。` : `已保存人员 ${payload.name}。`);
    if (configureAccess && savedUser?.role === "special") {
      await router.push(`/users/${savedUser.id}`);
    }
  } catch (error) {
    showActionMessage("error", `人员保存失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};

const submitBackofficeAccount = async () => {
  const username = backofficeForm.value.username.trim();
  const password = backofficeForm.value.password.trim();
  const hadExistingCredential = backofficeForm.value.hasExistingCredential;

  if (!username) {
    showActionMessage("error", "后台账号保存失败：请填写后台登录账号。");
    return;
  }

  if ((!backofficeForm.value.hasExistingCredential || password) && password.length < 8) {
    showActionMessage(
      "error",
      `后台账号保存失败：${backofficeForm.value.hasExistingCredential ? "重置" : "首次"}密码至少需要 8 位。`
    );
    return;
  }

  normalizeBackofficeFormPermissions();
  saving.value = true;
  actionMessage.value = null;

  try {
    await adminApi.createBackofficeCredential({
      userId: backofficeForm.value.userId,
      username,
      password: password || undefined,
      role: backofficeForm.value.role,
      permissions: backofficeForm.value.permissions
    });
    closeDrawer();
    await load();
    showActionMessage(
      "success",
      hadExistingCredential && !password
        ? `后台账号 ${username} 的角色与权限已保存，密码未变更。`
        : `后台账号 ${username} 已保存，可使用对应身份登录后台。`
    );
  } catch (error) {
    showActionMessage("error", `后台账号保存失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};

const removeUser = async (user: UserRecord) => {
  if (!window.confirm(`确认从当前人员台账中删除 ${user.name}（${user.phone}）吗？`)) {
    return;
  }

  removingUserId.value = user.id;
  try {
    await adminApi.removeUser(user.id);
    selectedUserIds.value = selectedUserIds.value.filter((id) => id !== user.id);
    if (editingUserId.value === user.id) {
      closeDrawer();
    }
    await load();
    showActionMessage("success", `已从人员台账中删除 ${user.name}，历史记录仍保留用于追溯。`);
  } catch (error) {
    showActionMessage("error", `删除人员失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    removingUserId.value = "";
  }
};

const removeEditingUser = async () => {
  const user = users.value.find((item) => item.id === editingUserId.value);

  if (!user) {
    showActionMessage("error", "未找到当前编辑的人员，请刷新后重新选择。");
    return;
  }

  await removeUser(user);
};

const removeSelectedUsers = async () => {
  const targets = selectedUsers.value;
  const count = targets.length;

  if (!count) {
    showActionMessage("error", adminCopy.users.batchRemoveNoSelection);
    return;
  }
  if (targets.some((user) => user.id === sessionStore.user?.id)) {
    showActionMessage("error", adminCopy.users.batchRemoveIncludesCurrent);
    return;
  }
  if (!window.confirm(adminCopy.users.batchRemoveFirstConfirmation(count))) {
    return;
  }
  if (!window.confirm(adminCopy.users.batchRemoveSecondConfirmation(count))) {
    return;
  }

  removingSelectedUsers.value = true;
  actionMessage.value = null;
  try {
    const result = await adminApi.batchRemoveUsers({
      userIds: targets.map((user) => user.id),
      confirmedCount: count
    });
    selectedUserIds.value = [];
    await load();
    showActionMessage("success", adminCopy.users.batchRemoveSuccess(result.count));
  } catch (error) {
    showActionMessage(
      "error",
      adminCopy.users.batchRemoveFailed(readErrorMessage(error, "请稍后重试"))
    );
  } finally {
    removingSelectedUsers.value = false;
  }
};

const createRegionDirect = async () => {
  const name = regionDraftName.value.trim();

  if (!name) {
    showActionMessage("error", "新增地区前请先填写地区名称。");
    return;
  }

  if (
    regionDraftLongitude.value === undefined ||
    Number.isNaN(regionDraftLongitude.value) ||
    regionDraftLatitude.value === undefined ||
    Number.isNaN(regionDraftLatitude.value)
  ) {
    showActionMessage("error", "新增地区前请填写有效的经纬度；可先通过地图设置位置。");
    return;
  }

  creatingRegion.value = true;
  try {
    const region = await adminApi.createRegion({
      name,
      sortOrder: regionDraftSortOrder.value,
      longitude: regionDraftLongitude.value,
      latitude: regionDraftLatitude.value
    });
    resetRegionDraft();
    await load();
    userForm.value.regionId = region.id;
    userForm.value.regionName = "";
    showActionMessage("success", `地区“${region.name}”已新增，可用于人员分组和小程序距离排序。`);
  } catch (error) {
    showActionMessage("error", `新增地区失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    creatingRegion.value = false;
  }
};

const saveRegionLocation = (payload: {
  longitude: number;
  latitude: number;
  location: string;
  address: string;
}) => {
  regionDraftLongitude.value = payload.longitude;
  regionDraftLatitude.value = payload.latitude;
  regionDraftLocation.value = payload.location;
  regionDraftAddress.value = payload.address;
  regionMapPickerVisible.value = false;
};

const addPolicyGoodsLimit = () => {
  policyForm.value.goodsLimits.push({ goodsId: goodsCatalog.value[0]?.goodsId ?? "", quantity: 1 });
};
const removePolicyGoodsLimit = (index: number) => {
  policyForm.value.goodsLimits.splice(index, 1);
  if (!policyForm.value.goodsLimits.length) addPolicyGoodsLimit();
};
const submitPolicyForm = async () => {
  actionMessage.value = null;
  let normalizedWeekdays: number[] = [];
  let goodsLimits: Array<{ goodsId: string; goodsName: string; category: GoodsCatalogItem["category"]; quantity: number }> = [];

  try {
    normalizedWeekdays = Array.from(new Set(policyForm.value.weekdays)).sort((left, right) => left - right);
    goodsLimits = policyForm.value.goodsLimits.filter((item) => item.goodsId && item.quantity > 0).map((item) => {
      const catalogItem = goodsCatalogMap.value.get(item.goodsId);
      if (!catalogItem) throw new Error(`未找到货品 ${item.goodsId}。`);
      return { goodsId: catalogItem.goodsId, goodsName: catalogItem.name, category: catalogItem.category, quantity: item.quantity };
    });
  } catch (error) {
    showActionMessage("error", `规则模板保存失败：${readErrorMessage(error, "请检查货品配置")}`);
    return;
  }

  if (!normalizedWeekdays.length || !goodsLimits.length || policyForm.value.endHour <= policyForm.value.startHour) {
    showActionMessage("error", "规则模板保存失败：请选择开放星期、至少一个货品额度，并确保结束时间晚于开始时间。");
    return;
  }

  const isCreate = drawerMode.value === "create-policy";
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
    showActionMessage("success", isCreate ? `已新增规则模板 ${basePayload.name}。` : `已保存规则模板 ${basePayload.name}。`);
  } catch (error) {
    showActionMessage("error", `规则模板保存失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};
const applyBatchPolicies = async () => {
  if (!selectedSpecialUsers.value.length || !batchPolicyIds.value.length) {
    showActionMessage("error", "批量规则操作失败：请先选择特殊群体人员和至少一个规则模板。");
    return;
  }

  if (
    batchMode.value === "replace" &&
    !window.confirm("覆盖会在下一个业务日替换所选特殊群体人员的每日可领取物资设定，确认继续吗？")
  ) {
    return;
  }
  const count = selectedSpecialUsers.value.length;
  saving.value = true;
  actionMessage.value = null;
  try {
    await adminApi.batchAssignPolicies({ userIds: selectedSpecialUsers.value.map((user) => user.id), policyIds: batchPolicyIds.value, mode: batchMode.value });
    await load();
    selectedUserIds.value = selectedUserIds.value.filter((id) => !selectedSpecialUsers.value.some((user) => user.id === id));
    showActionMessage("success", `已${batchMode.value === "replace" ? "覆盖" : batchMode.value === "unbind" ? "解绑" : "绑定"} ${count} 名特殊群体人员的每日可领取规则。`);
  } catch (error) {
    showActionMessage("error", `批量规则操作失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    saving.value = false;
  }
};

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section users-setup-section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">业务配置</p>
          <h3 class="admin-page__section-title">先建人员，再配置每日可领取物资和预约规则</h3>
        </div>
        <button v-if="canManageUsers" class="admin-button" @click="openCreateUser">新增人员</button>
      </div>

      <div class="users-setup-grid">
        <article class="admin-panel admin-panel-block users-setup-flow">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">配置顺序</span>
              <h3 class="admin-panel__title">按姓名、电话和物资清单完成上线配置</h3>
            </div>
          </div>
          <div class="users-setup-steps">
            <div class="users-setup-step">
              <span class="users-setup-step__index">1</span>
              <div>
                <span class="admin-table__strong">录入人员</span>
                <span class="admin-table__subtext">特殊群体 {{ specialUserCount }} 人，待审核 {{ pendingRegistrationCount }} 条</span>
              </div>
              <button v-if="canManageUsers" class="admin-button admin-button--ghost" @click="openCreateUser">新增</button>
            </div>
            <div class="users-setup-step">
              <span class="users-setup-step__index">2</span>
              <div>
                <span class="admin-table__strong">维护每日可领取物资</span>
                <span class="admin-table__subtext">已配置 {{ configuredSpecialUserCount }} / {{ specialUserCount }} 人</span>
              </div>
              <RouterLink v-if="canManageUserRules" class="admin-button admin-button--ghost" :to="firstConfigTargetUser ? `/users/${firstConfigTargetUser.id}` : '/users'">
                配置个人
              </RouterLink>
            </div>
            <div class="users-setup-step">
              <span class="users-setup-step__index">3</span>
              <div>
                <span class="admin-table__strong">创建批量模板</span>
                <span class="admin-table__subtext">模板 {{ policies.length }} 个，可批量套用到特殊群体人员</span>
              </div>
              <button v-if="canManageUserRules" class="admin-button admin-button--ghost" @click="openCreatePolicy">新增模板</button>
            </div>
            <div class="users-setup-step">
              <span class="users-setup-step__index">4</span>
              <div>
                <span class="admin-table__strong">提前预约</span>
                <span class="admin-table__subtext">{{ reservationStatusLabel }}</span>
              </div>
              <button class="admin-button admin-button--ghost" @click="loadReservationSettings">刷新</button>
            </div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block users-reservation-card">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">小程序提前预约</span>
              <h3 class="admin-panel__title">预约开关与保留规则</h3>
            </div>
            <span class="admin-pill" :class="reservationForm.enabled ? 'admin-pill--success' : 'admin-pill--neutral'">
              {{ reservationForm.enabled ? "已开启" : "未开启" }}
            </span>
          </div>

          <label class="users-reservation-toggle">
            <input v-model="reservationForm.enabled" type="checkbox" :disabled="!canUpdateReservationSettings || reservationSaving" />
            <span>允许小程序提前预约柜门物资</span>
          </label>

          <div class="users-reservation-fields">
            <label class="admin-field">
              <span class="admin-field__label">预约保留分钟数</span>
              <input
                v-model.number="reservationForm.holdMinutes"
                class="admin-input"
                type="number"
                min="1"
                :disabled="!canUpdateReservationSettings || reservationSaving"
              />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">连续超时限制</span>
              <input
                v-model.number="reservationForm.maxTimeouts"
                class="admin-input"
                type="number"
                min="1"
                :disabled="!canUpdateReservationSettings || reservationSaving"
              />
            </label>
          </div>

          <div class="admin-note">
            {{ canUpdateReservationSettings ? "保存后，小程序预约流程会按这里的规则执行。" : "当前账号只有查看权限，修改预约规则需要“预约规则管理”权限。" }}
            <span v-if="reservationSettings?.updatedAt">最近更新：{{ formatDateTime(reservationSettings.updatedAt) }}</span>
          </div>

          <div
            v-if="reservationMessage"
            class="admin-note"
            :class="{ 'users-reservation-message--error': reservationMessage.type === 'error', 'users-reservation-message--success': reservationMessage.type === 'success' }"
            :role="reservationMessage.type === 'error' ? 'alert' : 'status'"
            :aria-live="reservationMessage.type === 'error' ? 'assertive' : 'polite'"
            aria-atomic="true"
          >
            {{ reservationMessage.text }}
          </div>

          <button
            class="admin-button"
            :disabled="reservationSaving || !canUpdateReservationSettings"
            @click="saveReservationSettings"
          >
            {{ reservationSaving ? "保存中" : "保存预约规则" }}
          </button>
        </article>
      </div>
    </section>

    <div
      v-if="actionMessage"
      class="admin-alert users-action-message"
      :class="{ 'admin-alert--danger': actionMessage.type === 'error' }"
      :role="actionMessage.type === 'error' ? 'alert' : 'status'"
      :aria-live="actionMessage.type === 'error' ? 'assertive' : 'polite'"
      aria-atomic="true"
    >
      {{ actionMessage.text }}
    </div>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">注册审核</p>
          <h3 class="admin-page__section-title">同页处理待审核、已驳回和已登记人员</h3>
        </div>
      </div>

      <div class="admin-panel admin-panel-block users-review-block">
        <div
          v-if="registrationApplicationsError"
          class="admin-alert admin-alert--danger"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          审核数据加载失败：{{ registrationApplicationsError }}
          <button class="admin-text-button" type="button" @click="loadRegistrationApplications">重试审核数据</button>
        </div>
        <div class="users-review-tabs">
          <button class="admin-button" :class="{ 'admin-button--ghost': reviewFilter !== 'pending' }" @click="reviewFilter = 'pending'">待审核 {{ registrationApplications.filter((item) => item.status === "pending").length }}</button>
          <button class="admin-button" :class="{ 'admin-button--ghost': reviewFilter !== 'rejected' }" @click="reviewFilter = 'rejected'">已驳回 {{ registrationApplications.filter((item) => item.status === "rejected").length }}</button>
          <button class="admin-button" :class="{ 'admin-button--ghost': reviewFilter !== 'approved' }" @click="reviewFilter = 'approved'">已登记 {{ registrationApplications.filter((item) => item.status === "approved").length }}</button>
        </div>

        <div v-if="!registrationApplicationsError && filteredApplications.length" class="admin-list users-contained-list">
          <div v-for="item in filteredApplications" :key="item.id" class="admin-list__row users-review-row">
            <div class="admin-list__main">
              <span class="admin-list__title">{{ item.profile.merchantName || item.profile.name || item.phone }}</span>
              <span class="admin-list__meta">{{ item.phone }} · {{ item.requestedRole === "special" ? "用户" : item.requestedRole === "merchant" ? "商家" : "管理员" }} · 更新于 {{ formatDateTime(item.updatedAt) }}</span>
              <span class="admin-table__subtext">{{ item.requestedRole === "special" ? `${item.profile.regionName || "待补充区域"}${item.profile.note ? ` · ${item.profile.note}` : ""}` : item.requestedRole === "merchant" ? `${item.profile.contactName || "待补充联系人"} · ${item.profile.address || "待补充地址"}` : `${item.profile.organization || "待补充单位"} · ${item.profile.title || "待补充职务"}` }}</span>
              <span v-if="item.reviewReason" class="users-review-row__reason">驳回原因：{{ item.reviewReason }}</span>
            </div>
            <div class="users-review-row__actions">
              <span class="admin-pill" :class="item.status === 'approved' ? 'admin-pill--success' : item.status === 'pending' ? 'admin-pill--warning' : 'admin-pill--neutral'">{{ item.status === "pending" ? "待审核" : item.status === "approved" ? "已通过" : "已驳回" }}</span>
              <template v-if="item.status === 'pending'">
                <input v-if="canReviewRegistrations" v-model="rejectReasons[item.id]" class="admin-input" placeholder="驳回时填写原因（选填）" />
                <div v-if="canReviewRegistrations" class="admin-inline-links">
                  <button class="admin-button" :disabled="saving || Boolean(reviewingApplicationId)" @click="reviewApplication(item.id, 'approved')">{{ reviewingApplicationId === item.id ? "处理中" : "通过" }}</button>
                  <button class="admin-button admin-button--ghost" :disabled="saving || Boolean(reviewingApplicationId)" @click="reviewApplication(item.id, 'rejected')">{{ reviewingApplicationId === item.id ? "处理中" : "驳回" }}</button>
                </div>
                <span v-else class="admin-table__subtext">审核申请需要“注册审核”权限。</span>
              </template>
              <RouterLink v-if="item.linkedUserId" class="admin-link" :to="`/users/${item.linkedUserId}`">查看已登记详情</RouterLink>
            </div>
          </div>
        </div>
        <div v-else-if="!registrationApplicationsError" class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载审核列表" : "当前分类下没有注册申请" }}</div>
          <div class="admin-empty__body">新的注册申请会在这里出现，审核通过后会自动进入已登记人员列表。</div>
        </div>
      </div>
    </section>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">人员检索</p>
          <h3 class="admin-page__section-title">按区域分组查看人员台账并批量绑定特殊群体策略</h3>
        </div>
        <button v-if="canManageUsers" class="admin-button" @click="openCreateUser">新增人员</button>
      </div>

      <div class="users-filters admin-panel admin-panel-block">
        <label class="admin-field">
          <span class="admin-field__label">分类</span>
          <select v-model="roleFilter" class="admin-select">
            <option value="all">全部</option>
            <option value="special">特殊群体</option>
            <option value="merchant">商家</option>
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
        <div v-if="canManageUsers" class="admin-field users-region-create-field">
          <span class="admin-field__label">新增地区</span>
          <div class="users-region-create-card">
            <div class="users-region-form-grid">
              <input v-model="regionDraftName" class="admin-input" placeholder="输入新的地区名称" />
              <input
                v-model.number="regionDraftSortOrder"
                class="admin-input"
                type="number"
                min="1"
                placeholder="排序"
              />
            </div>
            <div class="users-region-create">
              <div class="admin-note users-region-location-summary">
                {{ regionDraftPositionSummary }}
              </div>
              <div class="admin-toolbar users-region-create-actions">
                <button
                  class="admin-button admin-button--ghost"
                  :disabled="creatingRegion"
                  @click="regionMapPickerVisible = true"
                >
                  {{ regionDraftLongitude !== undefined && regionDraftLatitude !== undefined ? "重新设置位置" : "地图设置位置" }}
                </button>
                <button
                  class="admin-button"
                  :disabled="creatingRegion || !regionDraftName.trim() || regionDraftLongitude === undefined || regionDraftLatitude === undefined"
                  @click="createRegionDirect"
                >
                  {{ creatingRegion ? "新增中" : "新增地区" }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="users-filters__summary admin-note">
          当前结果 {{ filteredUsers.length }} 人，已选 {{ selectedUserIds.length }} 人。人员台账默认按地区分组，特殊群体领取状态单独显示。
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
          <div class="admin-inline-links">
            <button class="admin-button admin-button--ghost" @click="toggleSelectAll">{{ allFilteredSelected ? "取消全选" : "全选当前结果" }}</button>
            <button
              v-if="canManageUsers"
              class="admin-button admin-button--danger"
              :disabled="removingSelectedUsers || !selectedUsers.length"
              @click="removeSelectedUsers"
            >
              {{
                removingSelectedUsers
                  ? adminCopy.users.batchRemovingButton
                  : adminCopy.users.batchRemoveButton(selectedUsers.length)
              }}
            </button>
          </div>
        </div>

        <div v-if="groupedUsers.length" class="users-region-groups users-contained-list users-contained-list--large">
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
                  <th>后台权限</th>
                  <th>手机号</th>
                  <th>台账状态</th>
                  <th>区域 / 标签</th>
                  <th>每日物资</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="user in group.users" :key="user.id">
                  <td><input type="checkbox" :checked="selectedUserIds.includes(user.id)" :aria-label="`选择人员 ${user.name}`" @change="toggleUser(user.id)" /></td>
                  <td>
                    <RouterLink class="admin-link" :to="`/users/${user.id}`">{{ user.name }}</RouterLink>
                    <span class="admin-table__subtext">{{ user.id }}</span>
                  </td>
                  <td>
                    <span class="admin-table__strong">{{ formatRole(user.role) }}</span>
                    <span class="admin-table__subtext">{{ user.status === "active" ? "账号已启用" : "账号已停用" }}</span>
                  </td>
                  <td>
                    <span class="admin-table__strong">{{ backofficeStatusLabel(user) }}</span>
                    <button
                      v-if="canManageBackofficeCredentials && isBackofficeEligibleUser(user)"
                      class="admin-text-button"
                      type="button"
                      @click="openBackofficeAccount(user)"
                    >
                      {{ backofficeCredentialForUser(user) ? "配置权限" : "开通后台" }}
                    </button>
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
                      <button v-if="canManageUsers" class="admin-text-button" @click="openEditUser(user)">编辑</button>
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
              <h3 class="admin-panel__title">模板用于批量生成每日可领取物资</h3>
            </div>
          </div>
          <div class="users-side-block">
            <div class="admin-note">
              {{ canManageUserRules ? `已选特殊群体 ${selectedSpecialUsers.length} 人。绑定后会按模板的星期、时段和货品数量生效。` : "当前账号只能查看每日物资模板，批量绑定或覆盖需要“取货规则管理”权限。" }}
            </div>
            <label class="admin-field">
              <span class="admin-field__label">操作方式</span>
              <select v-model="batchMode" class="admin-select" :disabled="!canManageUserRules">
                <option value="bind">新增为个人设定</option>
                <option value="replace">覆盖个人设定</option>
                <option value="unbind">解绑以下模板</option>
              </select>
            </label>
            <div class="admin-field">
              <span class="admin-field__label">模板选择</span>
              <div class="users-policy-checklist">
                <label v-for="policy in policies" :key="policy.id" class="users-policy-check">
                  <input v-model="batchPolicyIds" type="checkbox" :value="policy.id" :disabled="!canManageUserRules" />
                  <span>{{ policy.name }}</span>
                  <span class="admin-table__subtext">{{ policy.applicableUserIds.length }} 人</span>
                </label>
              </div>
            </div>
            <div class="admin-note">
              {{
                batchMode === "replace"
                  ? "覆盖会把模板拆成按货品的每日设定，并在下一个业务日替换当前个人设置。"
                  : "新增会把模板中的每个货品最小单元追加到所选特殊群体人员的每日设定中。"
              }}
            </div>
            <button class="admin-button" :disabled="saving || !canManageUserRules || !selectedSpecialUsers.length || !batchPolicyIds.length" @click="applyBatchPolicies">{{ saving ? "保存中" : batchMode === "replace" ? "覆盖每日物资" : "新增每日物资" }}</button>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">每日物资模板库</span>
              <h3 class="admin-panel__title">管理时段、星期和货品数量</h3>
            </div>
            <button v-if="canManageUserRules" class="admin-button admin-button--ghost" @click="openCreatePolicy">新增模板</button>
          </div>
          <div v-if="policies.length" class="admin-list users-contained-list users-contained-list--side">
            <div v-for="policy in policies" :key="policy.id" class="admin-list__row users-policy-row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ policy.name }}</span>
                <span class="admin-list__meta">{{ formatWeekdays(policy.weekdays) }} · {{ String(policy.startHour).padStart(2, "0") }}:00-{{ String(policy.endHour).padStart(2, "0") }}:00 · {{ policy.applicableUserIds.length }} 人</span>
                <span class="admin-table__subtext">{{ policy.goodsLimits.map((limit) => `${limit.goodsName} x${limit.quantity}`).join("，") }}</span>
              </div>
              <div class="admin-inline-links">
                <span class="admin-pill" :class="policy.status === 'active' ? 'admin-pill--success' : 'admin-pill--warning'">{{ policy.status === "active" ? "启用中" : "已停用" }}</span>
                <button v-if="canManageUserRules" class="admin-text-button" @click="openEditPolicy(policy)">编辑</button>
              </div>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前还没有每日物资模板</div>
            <div class="admin-empty__body">请先新增模板，再批量绑定到特殊群体人员。</div>
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
          <button class="admin-button admin-button--ghost" :disabled="isUserMutating" @click="closeDrawer">关闭</button>
        </div>

        <div v-if="drawerMode === 'create-user' || drawerMode === 'edit-user'" class="users-drawer__body">
          <label class="admin-field">
            <span class="admin-field__label">角色</span>
            <select v-model="userForm.role" class="admin-select" :disabled="editingCurrentUser">
              <option value="special">特殊群体</option>
              <option value="merchant">商家</option>
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
            <select v-model="userForm.status" class="admin-select" :disabled="editingCurrentUser">
              <option value="active">启用</option>
              <option value="inactive">暂停</option>
            </select>
            <span v-if="editingCurrentUser" class="admin-table__subtext">
              当前登录账号的角色和启用状态需由其他管理员修改。
            </span>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">区域</span>
            <select v-model="userForm.regionId" class="admin-select">
              <option value="">未分配区域</option>
              <option v-for="region in regionOptions" :key="region.id" :value="region.id">
                {{ region.name }}
              </option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">标签</span>
            <input v-model="userForm.tagsText" class="admin-input" placeholder="多个标签请用中文逗号分隔" />
          </label>
          <button
            class="admin-button"
            :disabled="saving || !canManageUsers || !userForm.name || !userForm.phone"
            @click="submitUserForm()"
          >
            {{ saving ? "保存中" : "保存人员信息" }}
          </button>
          <button
            v-if="userForm.role === 'special'"
            class="admin-button admin-button--ghost"
            :disabled="saving || !canManageUsers || !userForm.name || !userForm.phone"
            @click="submitUserForm(true)"
          >
            {{ saving ? "保存中" : "保存并配置每日物资" }}
          </button>
          <div v-if="userForm.role === 'special'" class="admin-note">
            每日可领取物资保存到人员详情页，适合按个人的姓名、电话和物资清单逐个维护。
          </div>

          <div v-if="drawerMode === 'edit-user' && canManageUsers && !editingCurrentUser" class="users-danger-zone">
            <div>
              <strong>删除人员</strong>
              <p>删除人员会移出当前人员台账，并清理取货模板绑定、待处理预警和登录会话；历史日志、库存记录和柜机事件保留，便于后续追溯。</p>
            </div>
            <button class="admin-button admin-button--danger" :disabled="saving || removingUserId === editingUserId" @click="removeEditingUser">
              {{ removingUserId === editingUserId ? "删除中" : "删除当前人员" }}
            </button>
          </div>
          <div v-else-if="editingCurrentUser" class="admin-note">
            当前登录账号不能删除；如需调整，请由其他管理员处理。
          </div>
        </div>

        <div v-else-if="drawerMode === 'create-policy' || drawerMode === 'edit-policy'" class="users-drawer__body">
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
          <button class="admin-button" :disabled="saving || !canManageUserRules || !policyForm.name || !policyForm.weekdays.length || policyForm.endHour <= policyForm.startHour" @click="submitPolicyForm">{{ saving ? "保存中" : "保存每日物资模板" }}</button>
        </div>

        <div v-else class="users-drawer__body">
          <div class="admin-note">
            正在为 {{ backofficeForm.userName }} 配置 PC 后台登录权限。权限只能从当前账号已拥有的范围内下发，程序提供商账号默认拥有全部权限。
          </div>
          <label class="admin-field">
            <span class="admin-field__label">后台身份</span>
            <select
              v-model="backofficeForm.role"
              class="admin-select"
              :disabled="!canChooseBackofficeRole"
              @change="changeBackofficeRole(backofficeForm.role)"
            >
              <option v-for="role in availableBackofficeRoles" :key="role" :value="role">
                {{ backofficeRoleLabels[role] }}
              </option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">登录账号</span>
            <input v-model="backofficeForm.username" class="admin-input" placeholder="建议使用手机号或工号" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">{{ backofficeForm.hasExistingCredential ? "重置密码（选填）" : "首次密码" }}</span>
            <input
              v-model="backofficeForm.password"
              class="admin-input"
              type="password"
              :placeholder="backofficeForm.hasExistingCredential ? '留空则不修改当前密码' : '至少 8 位'"
            />
          </label>
          <div class="admin-field">
            <span class="admin-field__label">权限配置</span>
            <div class="admin-toolbar users-permission-toolbar">
              <button class="admin-button admin-button--ghost" type="button" :disabled="backofficeForm.role === 'super_admin'" @click="toggleAllBackofficePermissions(true)">
                选择全部业务权限
              </button>
              <button class="admin-button admin-button--ghost" type="button" :disabled="backofficeForm.role === 'super_admin'" @click="toggleAllBackofficePermissions(false)">
                清空
              </button>
            </div>
            <div v-if="backofficeForm.role === 'super_admin'" class="admin-note">
              程序提供商账号固定拥有全局与实例内全部权限，不需要单独增减。
            </div>
            <div class="users-permission-groups">
              <section v-for="group in visiblePermissionGroups" :key="group.title" class="users-permission-group">
                <span class="admin-kicker">{{ group.title }}</span>
                <label v-for="permission in group.permissions" :key="permission" class="users-permission-check">
                  <input v-model="backofficeForm.permissions" type="checkbox" :value="permission" :disabled="backofficeForm.role === 'super_admin'" />
                  <span>{{ permissionLabels[permission] }}</span>
                </label>
              </section>
            </div>
          </div>
          <button class="admin-button" :disabled="saving || !backofficeForm.username" @click="submitBackofficeAccount">
            {{ saving ? "保存中" : "保存后台权限" }}
          </button>
        </div>
      </aside>
    </div>

    <div v-if="regionMapPickerVisible" class="users-map-backdrop" @click.self="regionMapPickerVisible = false">
      <section class="users-map-panel admin-panel">
        <AmapLocationPicker
          :initial-longitude="regionDraftLongitude"
          :initial-latitude="regionDraftLatitude"
          :initial-location="regionDraftLocation"
          :initial-address="regionDraftAddress"
          subject-label="地区"
          description="地区选点"
          location-placeholder="例如 扬名街道中心位置"
          @close="regionMapPickerVisible = false"
          @confirm="saveRegionLocation"
        />
      </section>
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

.users-setup-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
  gap: 12px;
}

.users-setup-steps,
.users-reservation-card {
  display: grid;
  gap: 12px;
}

.users-setup-step {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 8px 0;
  border-bottom: 1px solid var(--admin-line);
}

.users-setup-step:last-child {
  border-bottom: 0;
}

.users-setup-step__index {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid #c6d7e6;
  border-radius: 8px;
  background: #f1f7fb;
  color: #0f5f87;
  font-weight: 700;
}

.users-reservation-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  color: var(--admin-text);
}

.users-reservation-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.users-reservation-message--error {
  border-color: #efc0ba;
  background: #fff4f2;
  color: #8c2f29;
}

.users-reservation-message--success {
  border-color: #b6dfc4;
  background: #f0fbf4;
  color: #25673b;
}

.users-filters {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.users-filters__summary {
  grid-column: 1 / -1;
  align-self: end;
}

.users-policy-check,
.users-permission-check,
.users-weekdays__item,
.users-region-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.users-region-group__head {
  justify-content: space-between;
}

.users-contained-list {
  max-height: 420px;
  overflow: auto;
  padding-right: 4px;
}

.users-contained-list--large {
  max-height: 460px;
}

.users-contained-list--side,
.users-policy-checklist {
  max-height: 260px;
  overflow: auto;
  padding-right: 4px;
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
.users-region-form-grid,
.users-region-create,
.users-permission-groups,
.users-permission-group {
  display: grid;
  gap: 8px;
}

.users-region-create-field {
  grid-column: 1 / -1;
}

.users-policy-limit-row {
  grid-template-columns: minmax(0, 1fr) 120px auto;
}

.users-hours,
.users-region-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.users-region-create-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel-muted);
}

.users-region-create {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.users-region-location-summary {
  min-height: 42px;
  display: flex;
  align-items: center;
}

.users-permission-toolbar {
  justify-content: flex-start;
}

.users-permission-group {
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel-muted);
}

.users-region-create-actions {
  justify-content: flex-end;
}

.users-map-backdrop {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.users-map-panel {
  width: min(960px, 100%);
  padding: 14px;
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

.users-danger-zone {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid #efc0ba;
  border-radius: 12px;
  background: #fff4f2;
  color: #8c2f29;
}

.users-danger-zone p {
  margin: 4px 0 0;
  color: #9a514b;
  line-height: 1.6;
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
  .users-setup-grid,
  .users-filters,
  .users-policy-limit-row,
  .users-hours,
  .users-region-form-grid {
    grid-template-columns: 1fr;
  }

  .users-setup-step {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .users-setup-step .admin-button {
    grid-column: 2;
    width: 100%;
  }

  .users-region-create {
    grid-template-columns: 1fr;
  }

  .users-danger-zone {
    grid-template-columns: 1fr;
  }

  .users-region-create-actions {
    justify-content: stretch;
  }
}
</style>
