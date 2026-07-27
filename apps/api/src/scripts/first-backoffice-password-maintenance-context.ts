import { readFileSync } from "node:fs";

const MAINTENANCE_SERVICE_CGROUP_PATTERN =
  /(?:^|\/)vending-api-candidate\.service(?:\/|$)/mu;

export const isFirstBackofficePasswordMaintenanceServiceCgroup = (
  cgroup: string
) => MAINTENANCE_SERVICE_CGROUP_PATTERN.test(cgroup);

export const assertFirstBackofficePasswordMaintenanceServiceContext = () => {
  if (process.platform !== "linux") {
    throw new Error("首次后台密码初始化只能在 Spark Linux 维护服务中运行。");
  }

  const cgroup = readFileSync("/proc/self/cgroup", "utf8");

  if (!isFirstBackofficePasswordMaintenanceServiceCgroup(cgroup)) {
    throw new Error(
      "首次后台密码初始化只能由受控维护运行器在 vending-api-candidate.service 中调用。"
    );
  }
};
