import type { AppError as AppErrorContract } from './result';

/**
 * The constructible form of ADR-0006's `AppError`.
 *
 * The ADR declares `AppError` as an interface inside the frozen region of
 * `result.ts`, and coding-standards-nestjs §3 writes `new AppError(code, params)`
 * in every error factory. Both are satisfied by keeping the interface where the
 * ADR put it and the class here: a class instance is structurally assignable to
 * the interface, so `Result<T>` accepts it with no cast and no widening.
 *
 * `messageKey` is derived rather than passed. ADR-0006 rule 3 says it is always
 * `errors.<code>`, and a value that is always a function of another value is a
 * value that can be typed wrong exactly once.
 */
export class AppError implements AppErrorContract {
  readonly messageKey: string;

  constructor(
    readonly code: string,
    readonly details?: Record<string, unknown>,
    readonly cause?: unknown,
  ) {
    this.messageKey = `errors.${code}`;
  }
}
