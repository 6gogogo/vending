import { Controller, Get, Header, Inject, Param, Req } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { RegistrationApplicationsService } from "../registration-applications/registration-applications.service";
import { PublicCatalogService } from "./public-catalog.service";

@Controller("public/devices")
export class PublicCatalogController {
  constructor(
    @Inject(PublicCatalogService) private readonly catalog: PublicCatalogService,
    @Inject(RegistrationApplicationsService) private readonly registrations: RegistrationApplicationsService
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  list(@Req() request: { hostname?: string }) {
    return ok(this.catalog.list(this.registrations.resolvePublicTenantId(request.hostname)));
  }

  @Get(":deviceCode")
  @Header("Cache-Control", "no-store")
  detail(@Param("deviceCode") deviceCode: string, @Req() request: { hostname?: string }) {
    return ok(this.catalog.detail(deviceCode, this.registrations.resolvePublicTenantId(request.hostname)));
  }
}
