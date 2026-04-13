import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { tap } from "rxjs";

import { InMemoryStoreService } from "./in-memory-store.service";

@Injectable()
export class PersistenceInterceptor implements NestInterceptor {
  constructor(
    @Inject(InMemoryStoreService)
    private readonly store: InMemoryStoreService
  ) {}

  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      tap({
        next: () => {
          this.store.persist();
        }
      })
    );
  }
}
