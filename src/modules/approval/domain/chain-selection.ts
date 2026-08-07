import type { ChainRow, Condition, RequestContext } from './approval.types';

/**
 * BR-APRV-002, and nothing else.
 *
 * *"Evaluate the requester-company-scoped chains by `priority` (ascending, first
 * match wins), then tenant-wide chains (`company_id NULL`) the same way."*
 *
 * The two-pass shape is the rule, not an optimisation: a company chain at
 * priority 900 beats a tenant chain at priority 1, because a tenant that
 * configured something for *this* company said something more specific than the
 * default it left in place for everyone.
 */
export function selectChain(
  chains: readonly ChainRow[],
  companyId: string,
  context: RequestContext,
): ChainRow | null {
  const active = chains.filter((chain) => chain.isActive);
  return (
    firstMatch(
      active.filter((chain) => chain.companyId === companyId),
      context,
    ) ??
    firstMatch(
      active.filter((chain) => chain.companyId === null),
      context,
    )
  );
}

function firstMatch(chains: readonly ChainRow[], context: RequestContext): ChainRow | null {
  return (
    [...chains].sort(byPriorityThenId).find((chain) => matches(chain.conditions, context)) ?? null
  );
}

/**
 * Two chains at the same priority is a configuration the editor allows and the
 * rule does not resolve, so id order decides it. Deterministic beats
 * insertion-ordered: uuidv7 makes it "the one configured first", and a chain
 * selection that changes when the planner changes its mind is the worst kind of
 * approval bug to reproduce.
 */
function byPriorityThenId(a: ChainRow, b: ChainRow): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}

/** NULL or `[]` conditions = the catch-all chain (BR-APRV-002). */
export function matches(conditions: Condition[] | null, context: RequestContext): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => evaluate(condition, context));
}

/**
 * A condition over a field the context did not carry evaluates **false**, which
 * ADR-0008 accepted as a tradeoff and §9 restates: selection falls through to
 * the default chain rather than throwing. A module that forgot a field gets the
 * safe chain, not a failed submit.
 */
export function evaluate(condition: Condition, context: RequestContext): boolean {
  const actual = context[condition.field];
  if (actual === undefined || actual === null) return false;

  if (condition.op === 'in') {
    return Array.isArray(condition.value) && condition.value.some((item) => equals(item, actual));
  }
  if (condition.op === 'eq') return equals(condition.value, actual);
  if (condition.op === 'neq') return !equals(condition.value, actual);

  const order = compare(actual, condition.value);
  if (order === null) return false;
  switch (condition.op) {
    case 'gt':
      return order > 0;
    case 'gte':
      return order >= 0;
    case 'lt':
      return order < 0;
    default:
      return order <= 0;
  }
}

/**
 * `5` and `'5'` are the same condition value.
 *
 * A condition arrives as jsonb and a context arrives as jsonb, but they are
 * written by different authors — an admin types `5` in the editor while a module
 * passes a `numeric` column that Postgres returns as `'5.00'`. Comparing
 * loosely here is the difference between a chain that routes and a chain that
 * silently never matches.
 */
function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const order = compare(a, b);
  return order === 0;
}

/** `null` = not comparable, which every ordering op reads as "does not match". */
function compare(a: unknown, b: unknown): number | null {
  const left = numeric(a);
  const right = numeric(b);
  if (left !== null && right !== null) return left - right;

  // Only two strings order lexically. Booleans, objects and arrays have no
  // ordering an admin would recognise, and stringifying them to invent one is
  // how `[object Object]` ends up deciding who approves a payroll run.
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  // ISO dates and plain strings both sort correctly this way, which is why the
  // registry declares no field types (`request-types.ts`).
  return a.localeCompare(b);
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
