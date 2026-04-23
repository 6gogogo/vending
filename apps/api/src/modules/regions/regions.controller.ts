import { Body, Controller, Get, Inject, Patch, Post, Param, Req, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { RegionsService } from "./regions.service";

@Controller("regions")
export class RegionsController {
  constructor(@Inject(RegionsService) private readonly regionsService: RegionsService) {}

  @Get()
  list() {
    return ok(this.regionsService.list());
  }

  @Post()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  create(
    @Body() body: { name: string; sortOrder?: number; longitude?: number; latitude?: number },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.regionsService.create(body, request.authUser?.id), "操作成功");
  }

  @Patch(":id")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  update(
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      status?: "active" | "inactive";
      sortOrder?: number;
      longitude?: number;
      latitude?: number;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.regionsService.update(id, body, request.authUser?.id), "操作成功");
  }
}
