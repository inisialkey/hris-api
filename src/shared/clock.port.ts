/**
 * `new Date()` in domain or application code is a lint error
 * (coding-standards-nestjs §6). Everything that depends on *now* — token expiry,
 * session liveness, attendance windows, accrual runs — injects this instead, so
 * the test can move time without moving the machine's.
 */
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
