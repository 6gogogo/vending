import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { InMemoryStoreService } from "./in-memory-store.service";
import { PersistenceInterceptor } from "./persistence.interceptor";

@Global()
@Module({
  providers: [
    InMemoryStoreService,
    {
      provide: APP_INTERCEPTOR,
      useClass: PersistenceInterceptor
    }
  ],
  exports: [InMemoryStoreService]
})
export class StoreModule {}
