import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { OperationLogsController } from "./operation-logs.controller";
import { OperationLogsService } from "./operation-logs.service";

@Module({
  imports: [GuardsModule],
  controllers: [OperationLogsController],
  providers: [OperationLogsService],
  exports: [OperationLogsService]
})
export class OperationLogsModule {}
