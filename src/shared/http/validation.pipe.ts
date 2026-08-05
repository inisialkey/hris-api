import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import type { ErrorDetailEntry } from '../envelope';
import { fieldCodes, sharedErrors } from '../shared.errors';
import { AppErrorException } from '../unwrap';

/**
 * class-validator constraint → field-level catalog code (error-catalog §4).
 *
 * Unmapped constraints fall to `VAL_INVALID_FORMAT`. That is the honest default:
 * every entry in the table below is a *shape* complaint, and a client branching
 * on the field code wants to know which input to point at, not which decorator
 * fired. A constraint that genuinely needs its own code registers one.
 */
const FIELD_CODES: Readonly<Record<string, string>> = {
  isNotEmpty: fieldCodes.required,
  isDefined: fieldCodes.required,
  minLength: fieldCodes.tooShort,
  maxLength: fieldCodes.tooLong,
  min: fieldCodes.outOfRange,
  max: fieldCodes.outOfRange,
  isIn: fieldCodes.invalidEnum,
  isEnum: fieldCodes.invalidEnum,
  whitelistValidation: fieldCodes.invalidFormat,
};

function flatten(errors: readonly ValidationError[], prefix = ''): ErrorDetailEntry[] {
  const entries: ErrorDetailEntry[] = [];

  for (const error of errors) {
    // JSON dot-path, per ADR-0007 — `device.installId`, not `installId`.
    const field = prefix ? `${prefix}.${error.property}` : error.property;

    for (const constraint of Object.keys(error.constraints ?? {})) {
      const code = FIELD_CODES[constraint] ?? fieldCodes.invalidFormat;
      entries.push({ field, code, messageKey: `errors.${code}` });
    }

    if (error.children && error.children.length > 0) {
      entries.push(...flatten(error.children, field));
    }
  }

  return entries;
}

/**
 * Chain position 8. Rejects **garbage**; rule violations belong to the use case
 * (backend-nestjs §6, restated there once because everyone gets it wrong).
 *
 * `forbidNonWhitelisted` is api-standards §3: a typo'd optional field must fail
 * loudly rather than silently no-op.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new AppErrorException(sharedErrors.validationFailed(flatten(errors))),
  });
}
