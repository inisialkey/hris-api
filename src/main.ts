import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';

import { AppModule } from './app.module';
import { buildValidationPipe } from './shared/http/validation.pipe';

/**
 * One deployable, three entrypoints (ADR-0001 decision 7, backend-nestjs §1/§9).
 * `APP_ROLE` selects; the image is identical in all three cases.
 *
 * Bootstrap order is backend-nestjs §11. Sentry and the OTel SDK belong before
 * app creation and are not here yet — they arrive with the observability wiring,
 * and OTel in particular must start *before* `NestFactory.create` so that its
 * auto-instrumentation can patch `http`, `pg`, `ioredis` and `bullmq`. Adding it
 * later is a two-line change at the top of this file, which is why it is safe to
 * leave until there is something worth tracing.
 */
async function bootstrap(): Promise<void> {
  const role = process.env.APP_ROLE ?? 'both';

  if (role === 'worker') {
    // No HTTP listener. Processors, the outbox relay and the `cron.` jobs are
    // registered by the modules that own them (ADR-0010) — none exist yet, so
    // this context starts, stays idle, and answers a probe on METRICS_PORT once
    // the observability wiring lands.
    const context = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
    context.useLogger(context.get(Logger));
    context.enableShutdownHooks();
    return;
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  // URI versioning: one version for the whole surface (ADR-0007).
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(buildValidationPipe());
  app.enableShutdownHooks();

  const config = app.get(ConfigService);

  // Disabled in production builds (backend-nestjs §10). One of the exactly four
  // behaviours permitted to branch on the environment (environments.md §14).
  if (config.get<string>('SWAGGER_ENABLED') === 'true') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('HRIS API')
        .setVersion('v1')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(Number(config.get<string>('PORT') ?? '3000'));
}

void bootstrap();
