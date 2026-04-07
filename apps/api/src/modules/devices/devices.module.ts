import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { SmartVmGateway } from "./smartvm.gateway";

@Module({
  imports: [GuardsModule],
  controllers: [DevicesController],
  providers: [DevicesService, SmartVmGateway],
  exports: [DevicesService, SmartVmGateway]
})
export class DevicesModule {}
