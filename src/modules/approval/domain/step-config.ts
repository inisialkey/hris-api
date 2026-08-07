import type { ErrorDetailEntry } from '../../../shared/envelope';
import { fieldCodes } from '../../../shared/shared.errors';
import {
  CONDITION_OPS,
  RESOLVER_TYPES,
  SELF_APPROVAL_POLICIES,
  type Condition,
  type Resolver,
  type StepConfig,
} from './approval.types';
import { contextFieldsOf } from './request-types';

/**
 * §8's config rows, as one pure pass over an unvalidated jsonb payload.
 *
 * **Why this is not class-validator.** `steps` and `conditions` are open jsonb
 * whose legal shape depends on a sibling field (`requestType` decides which
 * condition fields exist) and on a tenant setting (`approval.max_chain_depth`).
 * A DTO can say "an array of objects"; it cannot say "resolver 2 of step 1 names
 * a position this tenant does not have". So the DTO checks the wire shape and
 * this checks the contract, and every failure comes back as a §8 field entry
 * addressed to the exact path — `steps[1].resolvers[0].positionId` — because an
 * editor with a step builder needs to know which control to mark red.
 *
 * Everything here is synchronous. Resolver **reference existence** is the one
 * §8 row that needs a database, and it lives in the service that has the ports.
 */
export function validateSteps(steps: unknown, maxDepth: number): ErrorDetailEntry[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    return [entry('steps', fieldCodes.required)];
  }
  if (steps.length > maxDepth) {
    return [entry('steps', fieldCodes.outOfRange, { max: maxDepth, actual: steps.length })];
  }

  const entries: ErrorDetailEntry[] = [];
  for (const [index, raw] of steps.entries()) {
    entries.push(...validateStep(raw, `steps[${index}]`));
  }
  return entries;
}

function validateStep(raw: unknown, path: string): ErrorDetailEntry[] {
  if (!isRecord(raw)) return [entry(path, fieldCodes.invalidFormat)];
  const entries: ErrorDetailEntry[] = [];

  if (raw.quorum !== 'all' && raw.quorum !== 'any') {
    entries.push(entry(`${path}.quorum`, fieldCodes.invalidEnum));
  }

  // §8: "SLA ≥ 1 h when present". `null` and absent both mean no SLA — the
  // column is nullable and an editor that clears the field sends one of the two.
  if (raw.slaHours !== undefined && raw.slaHours !== null) {
    if (!Number.isInteger(raw.slaHours) || (raw.slaHours as number) < 1) {
      entries.push(entry(`${path}.slaHours`, fieldCodes.outOfRange, { min: 1 }));
    }
  }

  if (!Array.isArray(raw.resolvers) || raw.resolvers.length === 0) {
    entries.push(entry(`${path}.resolvers`, fieldCodes.required));
  } else {
    for (const [index, resolver] of raw.resolvers.entries()) {
      entries.push(...validateResolver(resolver, `${path}.resolvers[${index}]`));
    }
  }

  entries.push(...validateVacancy(raw.onVacancy, `${path}.onVacancy`));

  if (!SELF_APPROVAL_POLICIES.includes(raw.onSelfApproval as never)) {
    entries.push(entry(`${path}.onSelfApproval`, fieldCodes.invalidEnum));
  }

  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') {
    entries.push(entry(`${path}.name`, fieldCodes.invalidFormat));
  }

  return entries;
}

function validateResolver(raw: unknown, path: string): ErrorDetailEntry[] {
  if (!isRecord(raw)) return [entry(path, fieldCodes.invalidFormat)];
  if (!RESOLVER_TYPES.includes(raw.type as never)) {
    return [entry(`${path}.type`, fieldCodes.invalidEnum)];
  }

  switch (raw.type) {
    case 'direct_manager':
      // Level 0 is the requester, which is the one approver BR-APRV-007 exists
      // to remove — so it is a configuration error rather than a self-approval.
      return Number.isInteger(raw.levels) && (raw.levels as number) >= 1
        ? []
        : [entry(`${path}.levels`, fieldCodes.outOfRange, { min: 1 })];
    case 'position_holder':
      return uuidEntry(raw.positionId, `${path}.positionId`);
    case 'role_holders':
      return uuidEntry(raw.roleId, `${path}.roleId`);
    default:
      return uuidEntry(raw.userId, `${path}.userId`);
  }
}

function validateVacancy(raw: unknown, path: string): ErrorDetailEntry[] {
  // §4 gives every step an `onVacancy`; BR-APRV-006 gives the ladder a default
  // rung, so an absent block is read as `fallback_role` rather than refused.
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) return [entry(path, fieldCodes.invalidFormat)];

  if (raw.policy === 'skip' || raw.policy === 'fallback_role') return [];
  if (raw.policy === 'fallback_resolver') {
    return validateResolver(raw.resolver, `${path}.resolver`);
  }
  return [entry(`${path}.policy`, fieldCodes.invalidEnum)];
}

/**
 * §8's two condition rows. `field` is checked against the request type's
 * declared context (§13) — the reason a chain is bound to one request type.
 */
export function validateConditions(conditions: unknown, requestType: string): ErrorDetailEntry[] {
  if (conditions === undefined || conditions === null) return [];
  if (!Array.isArray(conditions)) return [entry('conditions', fieldCodes.invalidFormat)];

  const declared = contextFieldsOf(requestType);
  const entries: ErrorDetailEntry[] = [];
  for (const [index, raw] of conditions.entries()) {
    const path = `conditions[${index}]`;
    if (!isRecord(raw)) {
      entries.push(entry(path, fieldCodes.invalidFormat));
      continue;
    }
    if (typeof raw.field !== 'string' || !declared.includes(raw.field)) {
      entries.push(entry(`${path}.field`, fieldCodes.invalidEnum, { requestType }));
    }
    if (!CONDITION_OPS.includes(raw.op as never)) {
      entries.push(entry(`${path}.op`, fieldCodes.invalidEnum));
    }
    if (raw.op === 'in' && !Array.isArray(raw.value)) {
      entries.push(entry(`${path}.value`, fieldCodes.invalidFormat));
    }
    if (raw.value === undefined) {
      entries.push(entry(`${path}.value`, fieldCodes.required));
    }
  }
  return entries;
}

/**
 * Every resolver reference a validated chain names, flattened for the one async
 * §8 row: *"position/role/user exist and live in tenant"*. Fallback resolvers
 * count — a vacancy policy that names a deleted position is a stuck instance
 * waiting to happen, and the write is where it is cheap to catch.
 */
export function resolverRefs(steps: readonly StepConfig[]): { resolver: Resolver; path: string }[] {
  const refs: { resolver: Resolver; path: string }[] = [];
  for (const [index, step] of steps.entries()) {
    for (const [position, resolver] of step.resolvers.entries()) {
      refs.push({ resolver, path: `steps[${index}].resolvers[${position}]` });
    }
    if (step.onVacancy.policy === 'fallback_resolver') {
      refs.push({
        resolver: step.onVacancy.resolver,
        path: `steps[${index}].onVacancy.resolver`,
      });
    }
  }
  return refs;
}

/** The reference's own field name, so a field entry points at the input control. */
export function refField(resolver: Resolver): string {
  switch (resolver.type) {
    case 'position_holder':
      return 'positionId';
    case 'role_holders':
      return 'roleId';
    case 'specific_user':
      return 'userId';
    default:
      return 'levels';
  }
}

/**
 * Normalises a validated payload into the shape the snapshot stores. Defaults
 * are applied **here rather than at read time**, because a snapshot is frozen
 * and a default that lives in the reader would change under an in-flight
 * instance the day it moved.
 */
export function normaliseSteps(steps: readonly unknown[]): StepConfig[] {
  return steps.map((raw) => {
    const step = raw as Record<string, unknown>;
    return {
      ...(typeof step.name === 'string' ? { name: step.name } : {}),
      quorum: step.quorum as StepConfig['quorum'],
      ...(typeof step.slaHours === 'number' ? { slaHours: step.slaHours } : {}),
      resolvers: step.resolvers as Resolver[],
      onVacancy: (step.onVacancy ?? { policy: 'fallback_role' }) as StepConfig['onVacancy'],
      onSelfApproval: step.onSelfApproval as StepConfig['onSelfApproval'],
    };
  });
}

export function normaliseConditions(conditions: unknown): Condition[] | null {
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  return conditions as Condition[];
}

function uuidEntry(value: unknown, path: string): ErrorDetailEntry[] {
  return typeof value === 'string' && UUID.test(value)
    ? []
    : [entry(path, fieldCodes.invalidFormat)];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entry(field: string, code: string, params?: Record<string, unknown>): ErrorDetailEntry {
  return { field, code, messageKey: `errors.${code}`, params: { field, ...params } };
}
