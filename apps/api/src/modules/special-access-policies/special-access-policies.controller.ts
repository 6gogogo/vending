import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";

import type { SpecialAccessPolicy } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { SpecialAccessPoliciesService } from "./special-access-policies.service";

@Controller("special-access-policies")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class SpecialAccessPoliciesController {
  constructor(
    @Inject(SpecialAccessPoliciesService)
    private readonly specialAccessPoliciesService: SpecialAccessPoliciesService
  ) {}

  @Get()
  list() {
    return ok(this.specialAccessPoliciesService.list());
  }

  @Post()
  create(
    @Body() body: Omit<SpecialAccessPolicy, "id">,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.specialAccessPoliciesService.create(body, request.authUser?.id),
      "策略模板已创建。"
    );
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: Partial<Omit<SpecialAccessPolicy, "id">>,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.specialAccessPoliciesService.update(
        id,
        body,
        request.authUser?.id
      ),
      "策略模板已更新。"
    );
  }

  @Post("batch-assign")
  batchAssign(
    @Body()
    body: {
      userIds: string[];
      policyIds: string[];
      mode: "bind" | "unbind" | "replace";
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.specialAccessPoliciesService.batchAssign(body, request.authUser?.id),
      "批量策略绑定已更新。"
    );
  }
}
