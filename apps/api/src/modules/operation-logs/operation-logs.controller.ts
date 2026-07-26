import { Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";

import type {
  BackofficeRole,
  OperationLogCategory,
  OperationLogStatus,
  OperationLogSubject
} from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { OperationLogsService } from "./operation-logs.service";

@Controller("operation-logs")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class OperationLogsController {
  constructor(@Inject(OperationLogsService) private readonly operationLogsService: OperationLogsService) {}

  @Get()
  @AllowedBackofficeSessionPermissions("operation-logs:view")
  @TenantScopedBackofficeRoute()
  list(
    @Query("category") category?: OperationLogCategory,
    @Query("status") status?: OperationLogStatus,
    @Query("subjectType") subjectType?: OperationLogSubject["type"],
    @Query("subjectId") subjectId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Req()
    request?: {
      authUser?: { backofficeRole?: BackofficeRole; tenantId?: string };
    }
  ) {
    return ok(
      this.operationLogsService.list({
        category,
        status,
        subjectType,
        subjectId,
        dateFrom,
        dateTo
      }, request?.authUser?.backofficeRole, request?.authUser?.tenantId)
    );
  }

  @Get("export/file")
  @AllowedBackofficePermissions("operation-logs:export")
  @TenantScopedBackofficeRoute()
  export(
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (body: string) => void;
    },
    @Query("category") category?: OperationLogCategory,
    @Query("status") status?: OperationLogStatus,
    @Query("subjectType") subjectType?: OperationLogSubject["type"],
    @Query("subjectId") subjectId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Req()
    request?: {
      authUser?: { backofficeRole?: BackofficeRole; tenantId?: string };
    }
  ) {
    const file = this.operationLogsService.buildExport({
      category,
      status,
      subjectType,
      subjectId,
      dateFrom,
      dateTo
    }, request?.authUser?.backofficeRole, request?.authUser?.tenantId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    response.send(file.body);
  }

  @Get("export/system-file")
  @AllowedBackofficePermissions("system-audit:export")
  exportSystemFile(
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (body: string) => void;
    }
  ) {
    const file = this.operationLogsService.buildSystemAuditExport();
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    response.send(file.body);
  }

  @Get("system-audit")
  @AllowedBackofficePermissions("system-audit:view")
  systemAudit(
    @Query("pathContains") pathContains?: string,
    @Query("deviceCode") deviceCode?: string,
    @Query("limit") limit?: string
  ) {
    const resolvedLimit = Number(limit ?? 50);
    return ok(
      this.operationLogsService.listSystemAudit({
        pathContains,
        deviceCode,
        limit: Number.isNaN(resolvedLimit) ? 50 : resolvedLimit
      })
    );
  }

  @Get(":id")
  @AllowedBackofficeSessionPermissions("operation-logs:view")
  @TenantScopedBackofficeRoute()
  detail(
    @Param("id") id: string,
    @Req()
    request: {
      authUser?: { backofficeRole?: BackofficeRole; tenantId?: string };
    }
  ) {
    return ok(
      this.operationLogsService.detail(
        id,
        request.authUser?.backofficeRole,
        request.authUser?.tenantId
      )
    );
  }

  @Post(":id/undo")
  @AllowedBackofficeSessionPermissions("operation-logs:undo")
  @TenantScopedBackofficeRoute()
  undo(
    @Param("id") id: string,
    @Req()
    request: {
      authUser?: {
        id: string;
        backofficeRole?: BackofficeRole;
        tenantId?: string;
      };
    }
  ) {
    return ok(
      this.operationLogsService.undo(
        id,
        request.authUser?.id,
        request.authUser?.backofficeRole,
        request.authUser?.tenantId
      ),
      "撤销已记录。"
    );
  }
}
