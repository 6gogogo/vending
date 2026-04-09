import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";

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

  @Get(":id")
  detail(@Param("id") id: string) {
    return ok(this.operationLogsService.detail(id));
  }
}
