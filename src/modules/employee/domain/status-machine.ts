import type { EmployeeStatus } from './employee.types';

/**
 * BR-EMP-005 / §4.2, as a table rather than a chain of `if`s.
 *
 * The two things worth reading off it: `active` and `on_leave` are mutually
 * reachable and every other arrow is one-way, and the terminal states have no
 * outgoing arrow at all. Rehire is a **new employees row** (BR-EMP-001), never a
 * reactivation — which is why `resigned → active` is absent rather than merely
 * discouraged, and why the NIK unique index is scoped to non-terminal rows.
 */
const ARROWS: Readonly<Record<EmployeeStatus, readonly EmployeeStatus[]>> = {
  active: ['on_leave', 'resigned', 'terminated'],
  on_leave: ['active', 'resigned', 'terminated'],
  resigned: [],
  terminated: [],
};

export const TERMINAL_STATUSES: ReadonlySet<EmployeeStatus> = new Set([
  'resigned',
  'terminated',
] as const);

export function isTerminal(status: EmployeeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: EmployeeStatus, to: EmployeeStatus): boolean {
  return ARROWS[from].includes(to);
}
