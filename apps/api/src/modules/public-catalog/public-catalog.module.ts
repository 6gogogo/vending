import { Module } from "@nestjs/common";

import { RegistrationApplicationsModule } from "../registration-applications/registration-applications.module";
import { PublicCatalogController } from "./public-catalog.controller";
import { PublicCatalogService } from "./public-catalog.service";

@Module({
  imports: [RegistrationApplicationsModule],
  controllers: [PublicCatalogController],
  providers: [PublicCatalogService]
})
export class PublicCatalogModule {}
