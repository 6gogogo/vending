import type {
  BackofficeScope,
  PlatformTenantServiceMode,
  PlatformTenantStatus
} from "@vm/shared-types";

export const resolveWorkspaceServiceLabel = (input: {
  scope?: BackofficeScope;
  tenantServiceMode?: PlatformTenantServiceMode;
}) => {
  if (input.scope === "provider") {
    return "正式服务商平台";
  }

  if (input.tenantServiceMode === "production") {
    return "正式服务";
  }

  if (input.tenantServiceMode === "simulation") {
    return "模拟服务";
  }

  return "实例服务状态待确认";
};

export const resolveTenantLifecycleLabel = (input: {
  serviceMode: PlatformTenantServiceMode;
  status: PlatformTenantStatus;
}) => {
  if (input.status === "active") {
    return "运行中";
  }

  if (input.status === "paused") {
    return "已暂停";
  }

  return input.serviceMode === "production" ? "待开通" : "演练中";
};

export const resolveTenantEntryAction = (input: {
  serviceMode: PlatformTenantServiceMode;
  status: PlatformTenantStatus;
}) => {
  if (input.status === "paused") {
    return {
      disabled: true,
      label: "实例已暂停"
    } as const;
  }

  if (input.serviceMode === "production" && input.status !== "active") {
    return {
      disabled: true,
      label: "待生产开通"
    } as const;
  }

  return {
    disabled: false,
    label: "进入实例"
  } as const;
};
