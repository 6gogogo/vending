import { Module } from "@nestjs/common";

import { FinancialOperationCoordinator } from "./financial-operation-coordinator";
import { FinancialSingleWriterService } from "./financial-single-writer.service";

@Module({
  providers: [FinancialOperationCoordinator, FinancialSingleWriterService],
  exports: [FinancialOperationCoordinator, FinancialSingleWriterService]
})
export class FinancialOperationCoordinatorModule {}
