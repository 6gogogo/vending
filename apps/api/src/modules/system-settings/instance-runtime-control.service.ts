import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  BackofficeRole,
  InstanceRuntimeControlStatus,
  InstanceRuntimeRestartPayload,
  InstanceRuntimeRestartResult,
  UserRole
} from "@vm/shared-types";

import { SystemAuditLogService } from "../../common/store/system-audit-log.service";

export interface InstanceRestartRuntimeAdapter {
  isAvailable: () => boolean;
  scheduleRestart: (operationId: string) => void;
}

export const INSTANCE_RESTART_RUNTIME_ADAPTER = Symbol(
  "INSTANCE_RESTART_RUNTIME_ADAPTER"
);

export interface InstanceRuntimeActor {
  id: string;
  role: UserRole;
  backofficeRole?: BackofficeRole;
  tenantId?: string;
}

const systemdRunPath = "/usr/bin/systemd-run";
const systemctlPath = "/usr/bin/systemctl";
const apiServiceUnit = "vending-api-candidate.service";
const restartDelaySeconds = 3;
const expectedReadyWithinSeconds = 30;

export const createSystemdInstanceRestartRuntimeAdapter = (): InstanceRestartRuntimeAdapter => {
  const isAvailable = () => {
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR?.trim();

    return (
      process.platform === "linux" &&
      existsSync(systemdRunPath) &&
      existsSync(systemctlPath) &&
      Boolean(runtimeDirectory && existsSync(join(runtimeDirectory, "bus")))
    );
  };

  return {
    isAvailable,
    scheduleRestart(operationId) {
      if (!isAvailable()) {
        throw new Error("instance restart runtime unavailable");
      }

      const safeOperationId = operationId.replace(/[^a-f0-9]/giu, "").slice(0, 32);
      const result = spawnSync(
        systemdRunPath,
        [
          "--user",
          `--unit=vending-api-restart-${safeOperationId}`,
          `--on-active=${restartDelaySeconds}s`,
          "--collect",
          "--",
          systemctlPath,
          "--user",
          "restart",
          apiServiceUnit
        ],
        {
          env: process.env,
          stdio: "ignore",
          timeout: 5_000,
          windowsHide: true
        }
      );

      if (result.error || result.status !== 0) {
        throw new Error("instance restart scheduling failed");
      }
    }
  };
};

@Injectable()
export class InstanceRuntimeControlService {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(SystemAuditLogService) private readonly auditLog: SystemAuditLogService,
    @Optional()
    @Inject(INSTANCE_RESTART_RUNTIME_ADAPTER)
    private readonly runtimeAdapter?: InstanceRestartRuntimeAdapter
  ) {}

  getStatus(actor?: InstanceRuntimeActor): InstanceRuntimeControlStatus {
    this.assertProviderTenantActor(actor);
    this.assertLiveDataPlane();

    return {
      available: this.runtimeAdapter?.isAvailable() ?? false,
      tenantName: this.resolveTenantName(),
      scope: "current-instance",
      activeService: "API 应用"
    };
  }

  scheduleRestart(
    payload: InstanceRuntimeRestartPayload,
    actor?: InstanceRuntimeActor
  ): InstanceRuntimeRestartResult {
    const status = this.getStatus(actor);

    if (!status.available || !this.runtimeAdapter) {
      throw new ServiceUnavailableException("当前部署未启用快捷重启。");
    }

    if (payload?.tenantNameConfirmation?.trim() !== status.tenantName) {
      throw new BadRequestException("实例名称确认不一致，未安排重启。");
    }

    const reason = payload?.reason?.trim() ?? "";

    if ([...reason].length < 4 || [...reason].length > 200 || /[\r\n]/u.test(reason)) {
      throw new BadRequestException("请填写 4 至 200 个字符的单行重启原因。");
    }

    const operationId = randomUUID();
    const scheduledAt = new Date().toISOString();
    const auditOperation = this.auditLog.beginCriticalIntent({
      method: "POST",
      path: "/api/system-settings/runtime-control/restart",
      actorUserId: actor?.id,
      actorRole: actor?.role,
      metadata: {
        action: "schedule-instance-application-restart",
        tenantId: actor?.tenantId,
        target: "current-instance-api",
        reasonLength: [...reason].length
      }
    });

    try {
      this.runtimeAdapter.scheduleRestart(operationId);
      this.auditLog.completeCriticalOperation(auditOperation, {
        method: "POST",
        path: "/api/system-settings/runtime-control/restart",
        statusCode: 202,
        durationMs: Date.now() - auditOperation.startedAt,
        outcome: "completed",
        actorUserId: actor?.id,
        actorRole: actor?.role,
        metadata: {
          action: "schedule-instance-application-restart",
          tenantId: actor?.tenantId,
          target: "current-instance-api"
        }
      });
    } catch {
      this.auditLog.completeCriticalOperation(auditOperation, {
        method: "POST",
        path: "/api/system-settings/runtime-control/restart",
        statusCode: 503,
        durationMs: Date.now() - auditOperation.startedAt,
        outcome: "failed",
        actorUserId: actor?.id,
        actorRole: actor?.role,
        metadata: {
          action: "schedule-instance-application-restart",
          tenantId: actor?.tenantId,
          target: "current-instance-api"
        }
      });
      throw new ServiceUnavailableException("快捷重启安排失败，请稍后重试。");
    }

    return {
      operationId,
      status: "scheduled",
      scheduledAt,
      expectedReadyWithinSeconds
    };
  }

  private assertProviderTenantActor(actor?: InstanceRuntimeActor) {
    if (actor?.backofficeRole !== "super_admin" || !actor.tenantId) {
      throw new ForbiddenException(
        "只有服务提供商进入当前实例后才能使用快捷重启。"
      );
    }
  }

  private assertLiveDataPlane() {
    if (this.configService.get<string>("VM_DATA_PLANE")?.trim() !== "live") {
      throw new BadRequestException("仅正式实例支持快捷重启。");
    }
  }

  private resolveTenantName() {
    const tenantName = this.configService
      .get<string>("VM_PLATFORM_TENANT_NAME")
      ?.trim();

    if (!tenantName) {
      throw new ServiceUnavailableException("当前实例身份配置不完整，不能快捷重启。");
    }

    return tenantName;
  }
}
