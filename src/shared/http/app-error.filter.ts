import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { currentRequestContext } from '../context';
import type { ErrorDetailEntry, ErrorEnvelope } from '../envelope';
import { statusForCode } from '../error-status.registry';
import { AppErrorException } from '../unwrap';
import { FIELD_ENTRIES } from '../validation-details';

/** ADR-0007: `VAL_` failures carry the array; everything else carries the object. */
function toWireDetails(
  details: Record<string, unknown> | undefined,
): ErrorDetailEntry[] | Record<string, unknown> | undefined {
  if (!details) return undefined;
  const entries = details[FIELD_ENTRIES];
  if (Array.isArray(entries)) return entries as ErrorDetailEntry[];
  return details;
}

/**
 * Business failures (backend-nestjs §7.3). Status comes from the catalog map, so
 * a code's HTTP status is declared once beside its factory and never chosen at
 * the throw site.
 *
 * These are **not** Sentry events (ADR-0011). An insufficient leave balance is
 * the product working; routing it to an error tracker trains everyone to ignore
 * the error tracker.
 */
@Catch(AppErrorException)
export class AppErrorFilter implements ExceptionFilter<AppErrorException> {
  catch(exception: AppErrorException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { code, messageKey } = exception.error;
    const details = toWireDetails(exception.error.details);

    const body: ErrorEnvelope = {
      success: false,
      error: {
        code,
        // Developer-facing English. Clients render `messageKey` from their own
        // bundle and never parse this (ADR-0006 rule 4).
        message: code,
        messageKey,
        ...(details ? { details } : {}),
        requestId: currentRequestContext()?.requestId ?? '',
      },
    };

    res.status(statusForCode(code) ?? 500).json(body);
  }
}
