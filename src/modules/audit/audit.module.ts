import { Module } from '@nestjs/common';

import { AnchorService } from './application/anchor.service';
import { AuditQueryUseCase } from './application/audit-query.use-case';
import { AuditService } from './application/audit.service';
import { AUDIT_ANCHOR_REPOSITORY, AUDIT_PORT, AUDIT_REPOSITORY } from './domain/audit.ports';
import { AuditAnchorRepository } from './infrastructure/audit-anchor.repository';
import { AuditRepository } from './infrastructure/audit.repository';
import { AuditController } from './presentation/audit.controller';

/**
 * No `registerErrorStatuses` call: `AUD_` owns zero codes on purpose (§11). A
 * read-only surface fails in platform ways — `VAL_`, `AUTHZ_`, 404 — and minting
 * a module code for one of those would split a branch clients already write.
 *
 * `AUDIT_PORT` is exported so other modules can file sensitive reads without
 * reaching for the repository (ADR-0001 §1). It is `useExisting` rather than a
 * second binding: the port and the internal caller must be the same instance, or
 * "one insert per access" quietly becomes two objects with one job.
 */
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditQueryUseCase,
    AnchorService,
    { provide: AUDIT_PORT, useExisting: AuditService },
    { provide: AUDIT_REPOSITORY, useClass: AuditRepository },
    { provide: AUDIT_ANCHOR_REPOSITORY, useClass: AuditAnchorRepository },
  ],
  exports: [AUDIT_PORT],
})
export class AuditModule {}
