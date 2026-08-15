import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { GoodsTaxonomyService } from "./goods-taxonomy.service";

@Controller("goods-taxonomy")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class GoodsTaxonomyController {
  constructor(@Inject(GoodsTaxonomyService) private readonly taxonomy: GoodsTaxonomyService) {}

  @Get("tree")
  @AllowedBackofficeSessionPermissions("goods:view")
  tree() {
    return ok(this.taxonomy.getTree());
  }

  @Post("nodes")
  @AllowedBackofficePermissions("goods:manage")
  createNode(
    @Body() body: { name: string; parentId: string | null; sortOrder?: number },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.taxonomy.createNode(body, request.authUser?.id), "分类节点已创建。");
  }

  @Post("nodes/:id/change-preview")
  @AllowedBackofficePermissions("goods:manage")
  preview(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return ok(this.taxonomy.previewChange(id, body));
  }

  @Patch("nodes/:id")
  @AllowedBackofficePermissions("goods:manage")
  update(
    @Param("id") id: string,
    @Body() body: Record<string, unknown> & { expectedRevision: number },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.taxonomy.applyChange(id, body, request.authUser?.id), "分类节点已更新。");
  }

  @Post("nodes/:id/change")
  @AllowedBackofficePermissions("goods:manage")
  change(
    @Param("id") id: string,
    @Body() body: Record<string, unknown> & { expectedRevision: number },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.taxonomy.applyChange(id, body, request.authUser?.id), "分类变更已应用。");
  }

  @Post("goods-assignments")
  @AllowedBackofficePermissions("goods:manage")
  assignGoods(
    @Body() body: { taxonomyNodeId: string; goodsIds: string[]; expectedRevision: number },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.taxonomy.assignGoods(body, request.authUser?.id), "货品归属已更新。");
  }

  @Post("goods-assignments/change-preview")
  @AllowedBackofficePermissions("goods:manage")
  previewGoodsAssignment(@Body() body: { taxonomyNodeId: string; goodsIds: string[] }) {
    return ok(this.taxonomy.previewGoodsAssignment(body));
  }
}
