import { readFileSync } from "node:fs";

const MAINTENANCE_SERVICE_CGROUP_PATTERN =
  /(?:^|\/)vending-api-candidate\.service(?:\/|$)/mu;

export const isBackofficePasswordMaintenanceServiceCgroup = (
  cgroup: string
) => MAINTENANCE_SERVICE_CGROUP_PATTERN.test(cgroup);

export const assertBackofficePasswordMaintenanceServiceContext = () => {
  if (process.platform !== "linux") {
    throw new Error("后台密码维护只能在 Spark Linux 维护服务中运行。");
  }

  const cgroup = readFileSync("/proc/self/cgroup", "utf8");

  if (!isBackofficePasswordMaintenanceServiceCgroup(cgroup)) {
    throw new Error(
      "后台密码维护只能由受控维护运行器在 vending-api-candidate.service 中调用。"
    );
  }
};

// 保留历史导出名，避免首次初始化路径与既有回归测试发生行为变化。
export const isFirstBackofficePasswordMaintenanceServiceCgroup =
  isBackofficePasswordMaintenanceServiceCgroup;
export const assertFirstBackofficePasswordMaintenanceServiceContext =
  assertBackofficePasswordMaintenanceServiceContext;
