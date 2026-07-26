import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { InventoryOrdersService } from "./inventory-orders.service";

@Controller("inventory-orders")
@TenantScopedBackofficeRoute()
export class InventoryOrdersController {
  constructor(
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService
  ) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("operation-logs:view")
  list(
    @Query("userId") userId?: string,
    @Query("role") role?: "special" | "merchant" | "restocker" | "admin",
    @Req()
    request?: {
      authUser?: {
        id: string;
        role: "admin" | "merchant" | "restocker" | "special";
        tenantId?: string;
      };
    }
  ) {
    const actor = request?.authUser;
    const resolvedUserId = actor && actor.role !== "admin" ? actor.id : userId;
    const resolvedRole = actor && actor.role !== "admin" ? actor.role : role;
    return ok(
      this.inventoryOrdersService.list(
        resolvedUserId,
        resolvedRole,
        actor?.tenantId
      )
    );
  }

  @Get("merchant-summary")
  @UseGuards(RoleGuard)
  @AllowedRoles("merchant", "restocker", "admin")
  @AllowedBackofficeSessionPermissions("operation-logs:view")
  merchantSummary(
    @Query("userId") userId: string,
    @Req()
    request?: {
      authUser?: {
        id: string;
        role: "admin" | "merchant" | "restocker";
        tenantId?: string;
      };
    }
  ) {
    const actor = request?.authUser;
    return ok(
      this.inventoryOrdersService.getMerchantSummary(
        actor && actor.role !== "admin" ? actor.id : userId,
        actor?.tenantId
      )
    );
  }
}
