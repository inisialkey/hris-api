import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';

import { currentTenantContext } from '../shared/context';
import { UnitOfWork } from './unit-of-work';

/**
 * Chain position 7 (backend-nestjs §5): open the transaction and set
 * `app.tenant_id` before the handler runs.
 *
 * Public routes reach here with no tenant resolved — login has not chosen one
 * yet — and are passed through untransacted. They are not left unprotected by
 * that: a query outside a unit-of-work gets the pool handle, where RLS returns
 * zero rows. The login path opens its own narrow transaction for the pre-tenant
 * lookup and a normal tenant-scoped one for the writes that follow.
 *
 * The transaction opening *before* DTO validation is a consequence of Nest's
 * fixed ordering — interceptors precede pipes — and is accepted deliberately: a
 * 422 rolls back an empty transaction, which costs a round trip and is not worth
 * fighting the framework over (backend-nestjs §5).
 */
@Injectable()
export class TransactionInterceptor implements NestInterceptor {
  constructor(private readonly uow: UnitOfWork) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenant = currentTenantContext();
    if (!tenant) return next.handle();

    // The handler's observable is consumed inside the transaction, so the commit
    // waits for the response value rather than racing it — and a thrown
    // `AppErrorException` rolls the transaction back before the filter renders it.
    return from(
      this.uow.run(tenant, () => lastValueFrom(next.handle(), { defaultValue: undefined })),
    );
  }
}
