import { Module } from "@nestjs/common";

import { StoreModule } from "../../common/store/store.module";
import { AuthModule } from "../auth/auth.module";
import { DevicesModule } from "../devices/devices.module";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({
  imports: [StoreModule, DevicesModule, AuthModule],
  controllers: [PlatformController],
  providers: [PlatformService]
})
export class PlatformModule {}
