// shared/result.ts — the ADR-0006 canonical Result.
//
// The region above the marker is copied verbatim from ADR-0006 and is compared
// for byte equality by ai-development-guide.md §8 gate 5. Do not edit it here:
// edit the ADR, open a handbook pull request, bump the submodule pin.

export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface AppError {
  readonly code: string;                    // catalog code: LVE_INSUFFICIENT_BALANCE
  readonly messageKey: string;              // always `errors.<code>`
  readonly details?: Record<string, unknown>; // safe-to-serialize context
  readonly cause?: unknown;                 // infra diagnostics — never serialized
}

// ---- ADR-0006 canonical, nothing above this line ----

// Sanctioned combinators live below the marker. ADR-0006 permits `map` and
// `andThen` and nothing else; anything more is an edit to the ADR.
