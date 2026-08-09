import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { DeviceOperationCoordinator } from "./device-operation-coordinator";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { SmartVmGateway } from "./smartvm.gateway";

@Module({
  imports: [GuardsModule, AlertsModule],
  controllers: [DevicesController],
  providers: [DevicesService, SmartVmGateway, DeviceOperationCoordinator],
  exports: [DevicesService, SmartVmGateway, DeviceOperationCoordinator]
})
export class DevicesModule {}
