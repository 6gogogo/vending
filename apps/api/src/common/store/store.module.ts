import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { InventoryBatchChangesService } from "../inventory/inventory-batch-changes.service";
import { InMemoryStoreService } from "./in-memory-store.service";
import { PersistenceInterceptor } from "./persistence.interceptor";
import { SystemAuditLogService } from "./system-audit-log.service";

@Global()
@Module({
  providers: [
    InMemoryStoreService,
    InventoryBatchChangesService,
    SystemAuditLogService,
    {
      provide: APP_INTERCEPTOR,
      useClass: PersistenceInterceptor
    }
  ],
  exports: [InMemoryStoreService, InventoryBatchChangesService, SystemAuditLogService]
})
export class StoreModule {}
