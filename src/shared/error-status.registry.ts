/**
 * Catalog code → HTTP status, the map `AppErrorFilter` reads (backend-nestjs §7.3).
 *
 * Each module registers its own block beside its error factories and calls
 * `registerErrorStatuses` from its module file. The catalog document
 * (`docs/handbook/docs/03-standards/error-catalog.md`) stays the registry of
 * record; this is the runtime projection of it.
 *
 * An unregistered code resolves to 500 rather than to a guessed 4xx. A missing
 * registration is a defect, and a defect that surfaces as `SYS_INTERNAL` is
 * noticed; one that surfaces as a plausible 422 is not.
 */
const statuses = new Map<string, number>();

export function registerErrorStatuses(block: Readonly<Record<string, number>>): void {
  for (const [code, status] of Object.entries(block)) {
    const existing = statuses.get(code);
    if (existing !== undefined && existing !== status) {
      // Two modules claiming one code with two statuses is the error-catalog's
      // one-owner rule broken at runtime. Fail at boot, not at the first request.
      throw new Error(`error code ${code} already registered with status ${existing}`);
    }
    statuses.set(code, status);
  }
}

export function statusForCode(code: string): number | undefined {
  return statuses.get(code);
}
