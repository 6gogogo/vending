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
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { OperationLogsService } from "./operation-logs.service";

@Controller("operation-logs")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
@AllowedBackofficePermissions("operation-logs:view")
export class OperationLogsController {
  constructor(@Inject(OperationLogsService) private readonly operationLogsService: OperationLogsService) {}

  @Get()
  list(
    @Query("category") category?: OperationLogCategory,
    @Query("status") status?: OperationLogStatus,
    @Query("subjectType") subjectType?: OperationLogSubject["type"],
    @Query("subjectId") subjectId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Req() request?: { authUser?: { backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.operationLogsService.list({
        category,
        status,
        subjectType,
        subjectId,
        dateFrom,
        dateTo
      }, request?.authUser?.backofficeRole)
    );
  }

  @Get("export/file")
  @AllowedBackofficePermissions("operation-logs:export")
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
    @Req() request?: { authUser?: { backofficeRole?: BackofficeRole } }
  ) {
    const file = this.operationLogsService.buildExport({
      category,
      status,
      subjectType,
      subjectId,
      dateFrom,
      dateTo
    }, request?.authUser?.backofficeRole);
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
  detail(
    @Param("id") id: string,
    @Req() request: { authUser?: { backofficeRole?: BackofficeRole } }
  ) {
    return ok(this.operationLogsService.detail(id, request.authUser?.backofficeRole));
  }

  @Post(":id/undo")
  undo(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.operationLogsService.undo(id, request.authUser?.id, request.authUser?.backofficeRole),
      "撤销已记录。"
    );
  }
}
