import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { SystemSettingsController } from "./system-settings.controller";
import { SystemSettingsService } from "./system-settings.service";

@Module({
  imports: [GuardsModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService]
})
export class SystemSettingsModule {}
