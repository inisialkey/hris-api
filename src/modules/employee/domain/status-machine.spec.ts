import type { EmployeeStatus } from './employee.types';
import { canTransition, isTerminal } from './status-machine';

const ALL: readonly EmployeeStatus[] = ['active', 'on_leave', 'resigned', 'terminated'];

describe('BR-EMP-005 status machine (§4.2)', () => {
  it.each([
    ['active', 'on_leave'],
    ['on_leave', 'active'],
    ['active', 'resigned'],
    ['on_leave', 'resigned'],
    ['active', 'terminated'],
    ['on_leave', 'terminated'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('has no arrow out of a terminal state — rehire is a new row, not a revival', () => {
    // BR-EMP-001 depends on this: the NIK unique index is scoped to
    // non-terminal rows precisely because a terminal row never comes back.
    for (const to of ALL) {
      expect(canTransition('resigned', to)).toBe(false);
      expect(canTransition('terminated', to)).toBe(false);
    }
  });

  it('refuses a self-transition', () => {
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });

  it('refuses resigned → terminated, which is two terminal verdicts on one employment', () => {
    expect(canTransition('resigned', 'terminated')).toBe(false);
    expect(canTransition('terminated', 'resigned')).toBe(false);
  });

  it('names exactly the two terminal states', () => {
    expect(ALL.filter(isTerminal)).toEqual(['resigned', 'terminated']);
  });
});
