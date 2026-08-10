import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { currentRequestContext, currentTenantContext } from './shared/context';

import { RedisModule } from './cache/redis.module';
import { validateEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { CryptoModule } from './shared/crypto/crypto.module';
import { TransactionInterceptor } from './database/transaction.interceptor';
import { ApprovalModule } from './modules/approval';
import { AuditModule } from './modules/audit';
import { AuthModule, JwtAuthGuard, TenantStatusGuard } from './modules/auth';
import { DocumentModule } from './modules/document';
import { EmployeeModule } from './modules/employee';
import { ImportExportModule } from './modules/import-export';
import { InboxModule } from './modules/inbox';
import { NotificationModule } from './modules/notification';
import { OrganizationModule } from './modules/organization';
import { SettingsModule } from './modules/settings';
import { AuthzModule, PermissionGuard } from './modules/authz';
import { HealthModule } from './modules/health/health.module';
import { ScratchModule } from './modules/scratch/scratch.module';
import { AllExceptionsFilter } from './shared/http/all-exceptions.filter';
import { AppErrorFilter } from './shared/http/app-error.filter';
import { EnvelopeInterceptor } from './shared/http/envelope.interceptor';
import { RateLimitGuard } from './shared/http/rate-limit';
import { RequestContextMiddleware } from './shared/http/request-context.middleware';
import { registerErrorStatuses } from './shared/error-status.registry';
import { sharedErrorStatus } from './shared/shared.errors';

registerErrorStatuses(sharedErrorStatus);

/**
 * The composition root, and the one place the backend-nestjs §5 chain order is
 * expressed. Nest applies same-kind globals in registration order, so this list
 * *is* the ordering — read top to bottom against that table.
 *
 * Filters are the exception: Nest applies them last-registered-first, so
 * `AllExceptionsFilter` is registered before `AppErrorFilter` in order to run
 * after it. That inversion is a framework fact and is called out here because it
 * is invisible and wrong-by-default.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL') ?? 'info',
          // ADR-0011's base fields. `service` and `env` are stamped on every
          // line so one aggregated stream stays separable; the correlation
          // fields come from the request scope, which is why they are a mixin
          // rather than per-call arguments.
          base: { service: 'hris-api', env: config.get<string>('APP_ENV') },
          mixin: () => {
            const request = currentRequestContext();
            const tenant = currentTenantContext();
            return {
              requestId: request?.requestId,
              userId: request?.userId,
              // The only tenant-identifying value telemetry may carry, and
              // never as a metric label — ADR-0011's own cardinality warning.
              tenantId: tenant?.tenantId,
            };
          },
          // The backstop, not the permission (coding-standards-nestjs §8). The
          // rule is that PII never reaches a log field in the first place; the
          // registry lives in security-standards §10.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.newPassword',
              'req.body.currentPassword',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
          transport:
            config.get<string>('APP_ENV') === 'local' ? { target: 'pino-pretty' } : undefined,
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    // ADR-0016's key path. Global: the `encryptedText` column type is reachable
    // from any schema file, so its precondition must be satisfiable anywhere.
    CryptoModule,
    AuthzModule,
    AuthModule,
    AuditModule,
    SettingsModule,
    OrganizationModule,
    DocumentModule,
    EmployeeModule,
    ApprovalModule,
    NotificationModule,
    InboxModule,
    ImportExportModule,
    HealthModule,
    // Deleted with the walking skeleton (roadmap §4.1).
    ScratchModule,
  ],
  providers: [
    // 2 — rate limit, before any authentication work
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // 3, 4, 5 — `useExisting`, not `useClass`. A `useClass` global is built in
    // *this* injector, where the auth and authz port tokens are not provided;
    // `useExisting` reuses the instance the owning module already built with its
    // own bindings. The symptom of getting this wrong is a boot-time
    // "can't resolve Symbol(...)" that reads as a missing provider rather than
    // as a misplaced one.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: TenantStatusGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },

    // 6 — IdempotencyInterceptor. Still absent, and the reason changed on
    // 2026-08-10: `POST /inbox/{id}/acknowledge` is the first queue-reachable
    // endpoint in the repository (BR-INB-007 — the platform's single offline
    // write), so "nothing here is queue-reachable" stopped being true.
    //
    // It stays absent because inbox.md §7 declares that endpoint
    // `Idempotency: accepted`, not required, and because BR-INB-008 already
    // makes a replay a 200 returning the existing `doneAt` — durable state
    // rather than a cached response, which offline-sync §5 names as *the*
    // mechanism for a state-transition op replayed past any store's window. A
    // Redis fast path would save a round trip and could not add correctness.
    //
    // It arrives with the first endpoint whose §7 block says **required** —
    // attendance's punch, or a payment-affecting payroll action — because those
    // are creates, where `op_id` uniqueness and a stored response are the only
    // things standing between a retry and a duplicate (A-199).

    // 7 — transaction + set_config('app.tenant_id')
    { provide: APP_INTERCEPTOR, useClass: TransactionInterceptor },
    // 10 — success envelope
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: AppErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 1 — X-Request-Id and the context scope everything downstream writes to.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
