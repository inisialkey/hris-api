import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { computeDigest } from '../domain/audit-digest';
import {
  AUDIT_ANCHOR_REPOSITORY,
  AUDIT_REPOSITORY,
  type AnchorRecord,
  type AuditAnchorRepositoryPort,
  type AuditRepositoryPort,
} from '../domain/audit.ports';

export interface VerifyResult {
  day: string;
  verified: boolean;
  rowCount: number;
  digest: string;
}

/**
 * UC-AUD-005 — the daily anchor and its verification.
 *
 * `write` is the body of `cron.audit.anchor` with the schedule taken off: the
 * job scans tenants and calls this once per tenant per day, back-filling gap
 * days **in order** so the chain stays continuous. Everything about the
 * computation is here; only the trigger is missing, and it arrives with the
 * worker bootstrap.
 *
 * Not yet here either: the Cloud Logging emit BR-AUD-009 amended in on
 * 2026-08-04. Its whole point is a witness that outlives the evidence and sits
 * outside the database — a sink this repository has no GCP wiring to reach, so
 * writing half of it (the row) and calling the property satisfied would be worse
 * than the gap being visible.
 */
@Injectable()
export class AnchorService {
  private readonly logger = new Logger(AnchorService.name);

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly logs: AuditRepositoryPort,
    @Inject(AUDIT_ANCHOR_REPOSITORY) private readonly anchors: AuditAnchorRepositoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Idempotent: an already-anchored day returns its anchor and writes nothing. */
  async write(day: string): Promise<AnchorRecord> {
    const existing = await this.anchors.findByDay(day);
    if (existing) return existing;

    const tenant = requireTenantContext();
    // The newest anchor *before* this day, not "yesterday's" — that is what lets
    // a back-fill land after a skipped day without breaking the chain (§9).
    const prevDigest = await this.anchors.findPreviousDigest(day);
    const rows = await this.logs.listForAnchorDay(day);

    const anchor: AnchorRecord = {
      day,
      rowCount: rows.length,
      digest: computeDigest(rows, prevDigest),
      prevDigest,
    };
    await this.anchors.insert(tenant.tenantId, anchor);
    return anchor;
  }

  /**
   * Recompute-and-compare (§7). Chains against the digest **stored on the
   * anchor**, not against a freshly resolved predecessor: the question this
   * endpoint answers is whether *this day's rows* still hash to what was
   * certified, and re-deriving the link would smear a neighbouring day's result
   * into the verdict.
   */
  async verify(day: string): Promise<Result<VerifyResult>> {
    const invalid = this.rejectBadDay(day);
    if (invalid) return invalid;

    const anchor = await this.anchors.findByDay(day);
    // Future days and days before the tenant existed have no anchor, and both
    // are a 404 rather than a manufactured "unverifiable" verdict (§7).
    if (!anchor) return fail(sharedErrors.notFound());

    const rows = await this.logs.listForAnchorDay(day);
    const digest = computeDigest(rows, anchor.prevDigest);
    const verified = digest === anchor.digest && rows.length === anchor.rowCount;

    if (!verified) {
      // Sentry's event is observability.md's, and this logger line is what feeds
      // it once the SDK is initialised. Investigation is a runbook matter — the
      // endpoint's job ends at reporting the mismatch honestly.
      this.logger.error(
        `audit anchor mismatch: day=${day} storedRows=${anchor.rowCount} recomputedRows=${rows.length}`,
      );
    }

    return ok({ day, verified, rowCount: rows.length, digest });
  }

  /**
   * §8: `day` is an ISO date, ≤ yesterday. Today is still accumulating rows, so
   * it has no anchor and never will until the day closes.
   *
   * The format check is not decoration: the range test below is a **string**
   * comparison, which is exactly right for `YYYY-MM-DD` and quietly wrong for
   * anything else — `'banana' <= '2026-08-05'` is false, so a typo would come
   * back as "out of range" and send the caller looking for a date problem they
   * do not have.
   */
  private rejectBadDay(day: string): Result<never> | null {
    if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
      return fail(fieldFailure(fieldCodes.invalidFormat, { expected: 'YYYY-MM-DD' }));
    }
    const yesterday = new Date(this.clock.now().getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    if (day <= yesterday) return null;
    return fail(fieldFailure(fieldCodes.outOfRange, { max: yesterday }));
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function fieldFailure(code: string, params: Record<string, unknown>) {
  return sharedErrors.validationFailed([
    { field: 'day', code, messageKey: `errors.${code}`, params },
  ]);
}
