import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';

import { REDIS } from '../../cache/redis.module';
import { DRIZZLE, type Database } from '../../database/connection.provider';
import { Public } from '../authz';

/**
 * The small health module backend-nestjs §9 requires.
 *
 * Liveness is "the process is up" and nothing more — a liveness probe that
 * checks the database restarts every pod when the database blinks, which turns
 * one outage into two.
 *
 * Readiness is database plus Redis, because a pod that cannot reach either
 * serves nothing useful and should leave the load-balancer rotation.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async ready(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1`);
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly config: ConfigService,
  ) {}

  @Get('health/live')
  @Public()
  @ApiOperation({ operationId: 'live', summary: 'Liveness — the process is up' })
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  @ApiOperation({ operationId: 'ready', summary: 'Readiness — PostgreSQL and Redis reachable' })
  async ready() {
    return { status: (await this.health.ready()) ? 'ok' : 'degraded' };
  }

  /** The version endpoint ci-cd's S1 smoke journey asserts (environments.md §6.1). */
  @Get('version')
  @Public()
  @ApiOperation({ operationId: 'version', summary: 'Promoted image tag and build SHA' })
  version() {
    return {
      version: this.config.get<string>('APP_VERSION') ?? 'dev',
      gitSha: this.config.get<string>('GIT_SHA') ?? 'unknown',
    };
  }
}

@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}
