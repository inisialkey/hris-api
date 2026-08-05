import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

import type { SuccessEnvelope } from '../envelope';

/** Marks a handler's return value as already carrying `meta` (ADR-0007). */
export interface WithMeta<T> {
  data: T;
  meta: Record<string, unknown>;
}

function isWithMeta(value: unknown): value is WithMeta<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'meta' in value &&
    Object.keys(value).length === 2
  );
}

/**
 * Chain position 10: wraps every success value in the ADR-0007 envelope.
 *
 * `meta` is emitted only when a handler supplied one — the ADR says absent when
 * empty, and a `"meta": {}` on every response is a key three clients would have
 * to learn to ignore.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<SuccessEnvelope<unknown>> {
    return next
      .handle()
      .pipe(
        map((value: unknown) =>
          isWithMeta(value)
            ? { success: true as const, data: value.data, meta: value.meta }
            : { success: true as const, data: value },
        ),
      );
  }
}
