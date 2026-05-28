import { Module } from "@nestjs/common";

import { StoreModule } from "../../common/store/store.module";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({
  imports: [StoreModule],
  controllers: [PlatformController],
  providers: [PlatformService]
})
export class PlatformModule {}
