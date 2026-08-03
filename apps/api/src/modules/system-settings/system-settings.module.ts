import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { resolveApiEnvFile } from "../../common/store/persistence";
import {
  createSystemdInstanceRestartRuntimeAdapter,
  INSTANCE_RESTART_RUNTIME_ADAPTER,
  InstanceRuntimeControlService
} from "./instance-runtime-control.service";
import { SystemSettingsController } from "./system-settings.controller";
import {
  SYSTEM_SETTINGS_RUNTIME_ADAPTER,
  SystemSettingsService
} from "./system-settings.service";

@Module({
  imports: [GuardsModule],
  controllers: [SystemSettingsController],
  providers: [
    {
      provide: SYSTEM_SETTINGS_RUNTIME_ADAPTER,
      useFactory: () => ({ envFilePath: resolveApiEnvFile() })
    },
    {
      provide: INSTANCE_RESTART_RUNTIME_ADAPTER,
      useFactory: createSystemdInstanceRestartRuntimeAdapter
    },
    SystemSettingsService,
    InstanceRuntimeControlService
  ],
  exports: [SystemSettingsService]
})
export class SystemSettingsModule {}
