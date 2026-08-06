import Decimal from 'decimal.js';

import type { ErrorDetailEntry } from '../../../shared/envelope';
import { fieldCodes } from '../../../shared/shared.errors';
import type { SettingDefinition } from './setting.types';

const FIELD = 'value';

/**
 * §8's `value` row, as field entries rather than a thrown failure — a settings
 * write can be wrong in more than one way and ADR-0007's envelope carries them
 * all.
 *
 * **Type first, then everything else.** JavaScript compares a string to a number
 * without complaining (`'abc' < 3` is `false`), so a chain that checked bounds
 * alongside the type would call a string in-range and point the caller at the
 * wrong problem.
 *
 * BR-SET-008's `tighten_only` is *carried* on the definition and *enforced*
 * through `min`/`max`. Every registered direction-constrained key states its
 * constraint as a floor or a ceiling — `auth.password_min_length` may only rise
 * from 10, `import-export.max_rows` may only fall from 10 000 — so the bound
 * already is the rule. A second enforcement path for the same sentence is a
 * second thing to keep in agreement with the first.
 */
export function validateValue(definition: SettingDefinition, value: unknown): ErrorDetailEntry[] {
  const typeError = checkType(definition, value);
  if (typeError) return [typeError];

  const validation = definition.validation;
  if (!validation) return [];

  const entries: ErrorDetailEntry[] = [];

  const numeric = toNumber(definition, value);
  if (numeric !== null && (validation.min !== undefined || validation.max !== undefined)) {
    const belowMin = validation.min !== undefined && numeric.lessThan(validation.min);
    const aboveMax = validation.max !== undefined && numeric.greaterThan(validation.max);
    if (belowMin || aboveMax) {
      entries.push(
        entry(fieldCodes.outOfRange, {
          ...(validation.min !== undefined ? { min: validation.min } : {}),
          ...(validation.max !== undefined ? { max: validation.max } : {}),
        }),
      );
    }
  }

  if (
    validation.pattern &&
    typeof value === 'string' &&
    !new RegExp(validation.pattern).test(value)
  ) {
    entries.push(entry(fieldCodes.invalidFormat, { pattern: validation.pattern }));
  }

  return entries;
}

function checkType(definition: SettingDefinition, value: unknown): ErrorDetailEntry | null {
  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : formatError('boolean');
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? null : formatError('integer');
    case 'decimal':
      // Decimal strings, never floats (coding-standards-nestjs §5.1). A float
      // that reached jsonb would carry its binary rounding into every read.
      return typeof value === 'string' && isDecimalString(value) ? null : formatError('decimal');
    case 'string':
      return typeof value === 'string' ? null : formatError('string');
    case 'enum':
      return checkEnum(definition, value);
    case 'json':
      return null;
  }
}

function checkEnum(definition: SettingDefinition, value: unknown): ErrorDetailEntry | null {
  const allowed = definition.validation?.enum ?? [];
  if (typeof value === 'string' && allowed.includes(value)) return null;
  return entry(fieldCodes.invalidEnum, { allowed });
}

/** The comparable form of a bounded value — `null` when bounds do not apply. */
function toNumber(definition: SettingDefinition, value: unknown): Decimal | null {
  if (definition.type === 'integer' && typeof value === 'number') return new Decimal(value);
  if (definition.type === 'decimal' && typeof value === 'string') return new Decimal(value);
  return null;
}

function isDecimalString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

function formatError(expected: string): ErrorDetailEntry {
  return entry(fieldCodes.invalidFormat, { expected });
}

function entry(code: string, params: Record<string, unknown>): ErrorDetailEntry {
  return { field: FIELD, code, messageKey: `errors.${code}`, params };
}
