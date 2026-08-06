import type {
  SettingDefinition,
  SettingLevel,
  SettingOrigin,
  SettingScope,
  SettingValueRow,
} from './setting.types';

/**
 * UC-SET-001, as a pure function over rows the repository already fetched.
 *
 * Two rules meet here and are deliberately one pass: **most specific wins**
 * (BR-SET-002) and **as-of the asked date** (BR-SET-004). Splitting them invites
 * the bug where a caller filters by date, finds nothing at branch level, and
 * concludes the branch has no value — when what it has is a value that had not
 * started yet.
 *
 * `asOf` is a `YYYY-MM-DD` string compared against `date` columns, never a
 * timestamp: an ISO date sorts lexicographically in calendar order, and the
 * alternative — parsing both sides into `Date` — reintroduces the timezone drift
 * database-conventions §5 uses `date` columns to avoid.
 */
export function resolveValue(
  definition: SettingDefinition,
  rows: readonly SettingValueRow[],
  scope: SettingScope,
  asOf: string,
): { value: unknown; origin: SettingOrigin } {
  for (const level of specificityOrder(definition, scope)) {
    const match = rows.find(
      (row) => row.level === level && inScope(row, level, scope) && covers(row, asOf),
    );
    if (match) return { value: match.value, origin: level };
  }
  return { value: definition.defaultValue, origin: 'default' };
}

/**
 * Most specific first, and only levels that are *both* declared by the
 * definition and reachable by the caller. A caller with no branch has no branch
 * to inherit from — UC-SET-005's pure admin user is that case, and it resolves
 * at tenant scope rather than picking up an arbitrary company's row.
 */
function specificityOrder(definition: SettingDefinition, scope: SettingScope): SettingLevel[] {
  const reachable: SettingLevel[] = ['branch', 'company', 'tenant'];
  return reachable.filter(
    (level) =>
      definition.allowedLevels.includes(level) &&
      (level !== 'branch' || scope.branchId !== undefined) &&
      (level !== 'company' || scope.companyId !== undefined),
  );
}

function inScope(row: SettingValueRow, level: SettingLevel, scope: SettingScope): boolean {
  if (level === 'branch') return row.branchId === scope.branchId;
  if (level === 'company') return row.companyId === scope.companyId;
  return true;
}

/** `[effectiveFrom, effectiveTo)` — database-conventions §5 rule 1. */
function covers(row: SettingValueRow, asOf: string): boolean {
  return row.effectiveFrom <= asOf && (row.effectiveTo === null || row.effectiveTo > asOf);
}
