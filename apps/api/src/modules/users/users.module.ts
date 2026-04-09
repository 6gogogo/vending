import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { DevicesModule } from "../devices/devices.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [GuardsModule, DevicesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService]
})
export class UsersModule {}
