import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { UploadsController } from "./uploads.controller";

@Module({
  imports: [GuardsModule],
  controllers: [UploadsController]
})
export class UploadsModule {}
