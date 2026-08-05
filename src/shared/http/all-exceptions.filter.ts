import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

import { currentRequestContext } from '../context';
import type { ErrorEnvelope } from '../envelope';
import { sharedErrors } from '../shared.errors';

/**
 * Everything `AppErrorFilter` did not catch (backend-nestjs §7.3).
 *
 * Two jobs, and the second is the one that matters: log the full stack against
 * the `requestId`, and return a body with **zero internal detail**. A stack
 * trace on the wire is a map of the system drawn for whoever asked for it.
 *
 * Nest's own `NotFoundException` for an unrouted path is the one shape mapped
 * through rather than flattened, because `SYS_ROUTE_NOT_FOUND` exists in the
 * catalog precisely so a client can tell "wrong URL" from "server broke".
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentRequestContext()?.requestId ?? '';

    const routeMiss = exception instanceof HttpException && exception.getStatus() === 404;
    const { code, messageKey } = routeMiss ? sharedErrors.routeNotFound() : sharedErrors.internal();

    if (!routeMiss) {
      this.logger.error({ requestId, err: exception }, 'unhandled exception');
    }

    const body: ErrorEnvelope = {
      success: false,
      error: { code, message: code, messageKey, requestId },
    };

    res.status(routeMiss ? 404 : 500).json(body);
  }
}
