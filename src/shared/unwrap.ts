import type { AppError as AppErrorContract, Result } from './result';

/**
 * Carries an `AppError` from a controller to `AppErrorFilter`.
 *
 * Not a `HttpException`: ADR-0006 bans those outside the filter layer, and this
 * one never leaves `shared/`. It exists because Nest's only path from a handler
 * to a filter is a throw.
 */
export class AppErrorException extends Error {
  constructor(readonly error: AppErrorContract) {
    super(error.code);
    this.name = 'AppErrorException';
  }
}

/** The only sanctioned Result → HTTP bridge (backend-nestjs §7.2). */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new AppErrorException(result.error);
}
