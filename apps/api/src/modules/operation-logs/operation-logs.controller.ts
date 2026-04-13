import { Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";

import type { OperationLogCategory, OperationLogStatus, OperationLogSubject } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { OperationLogsService } from "./operation-logs.service";

@Controller("operation-logs")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class OperationLogsController {
  constructor(@Inject(OperationLogsService) private readonly operationLogsService: OperationLogsService) {}

  @Get()
  list(
    @Query("category") category?: OperationLogCategory,
    @Query("status") status?: OperationLogStatus,
    @Query("subjectType") subjectType?: OperationLogSubject["type"],
    @Query("subjectId") subjectId?: string
  ) {
    return ok(
      this.operationLogsService.list({
        category,
        status,
        subjectType,
        subjectId
      })
    );
  }

  @Get("export/file")
  export(
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (body: string) => void;
    },
    @Query("category") category?: OperationLogCategory,
    @Query("status") status?: OperationLogStatus,
    @Query("subjectType") subjectType?: OperationLogSubject["type"],
    @Query("subjectId") subjectId?: string
  ) {
    const file = this.operationLogsService.buildExport({
      category,
      status,
      subjectType,
      subjectId
    });
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    response.send(file.body);
  }

  @Get("export/system-file")
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

  @Get(":id")
  detail(@Param("id") id: string) {
    return ok(this.operationLogsService.detail(id));
  }

  @Post(":id/undo")
  undo(@Param("id") id: string, @Req() request: { authUser?: { id: string } }) {
    return ok(this.operationLogsService.undo(id, request.authUser?.id), "撤销已记录。");
  }
}
