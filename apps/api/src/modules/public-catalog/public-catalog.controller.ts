import { Controller, Get, Header, Inject, Req } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { RegistrationApplicationsService } from "../registration-applications/registration-applications.service";
import { PublicCatalogService } from "./public-catalog.service";

@Controller("public/products")
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
}
