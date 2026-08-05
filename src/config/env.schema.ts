import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/**
 * The boot contract (backend-nestjs §11): the process fails at boot on a missing
 * or malformed variable and never limps with a default for a secret or a URL.
 *
 * Names are the environments.md §6 registry. A variable added here is added
 * there in the same session — that table is the only place in the handbook where
 * *"what does this process need in order to start"* is answerable.
 */
export class EnvSchema {
  /**
   * ADR-0020 decision 1: a closed set, and a value outside it fails boot rather
   * than defaulting. The value that falls back is the one that deletes a tenant.
   */
  @IsIn(['local', 'test', 'staging', 'production'])
  APP_ENV!: 'local' | 'test' | 'staging' | 'production';

  @IsIn(['api', 'worker', 'both'])
  APP_ROLE!: 'api' | 'worker' | 'both';

  @IsOptional()
  @IsString()
  APP_VERSION?: string;

  @IsOptional()
  @IsString()
  GIT_SHA?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsIn(['debug', 'info', 'warn', 'error'])
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error' = 'info';

  @IsIn(['true', 'false'])
  SWAGGER_ENABLED: string = 'false';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsInt()
  @Min(1)
  DATABASE_POOL_MAX: number = 10;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  /** Ed25519 PKCS8 PEM. `api` only — a worker signs nothing (environments.md §6.3). */
  @IsString()
  @IsNotEmpty()
  JWT_PRIVATE_KEY!: string;

  /** JSON `{ "<kid>": "<SPKI PEM>" }`. Verify-only, so api and worker both hold it. */
  @IsString()
  @IsNotEmpty()
  JWT_PUBLIC_KEYS!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACTIVE_KID!: string;

  /** Seconds. ADR-0004 values, platform-fixed — not tenant-tunable. */
  @IsInt()
  @Min(1)
  ACCESS_TOKEN_TTL: number = 900;

  @IsInt()
  @Min(1)
  REFRESH_TOKEN_TTL: number = 2_592_000;
}

const NUMERIC: readonly (keyof EnvSchema)[] = [
  'PORT',
  'DATABASE_POOL_MAX',
  'ACCESS_TOKEN_TTL',
  'REFRESH_TOKEN_TTL',
];

export function validateEnv(raw: Record<string, unknown>): EnvSchema {
  const coerced: Record<string, unknown> = { ...raw };
  for (const key of NUMERIC) {
    const value = coerced[key];
    if (typeof value === 'string' && value !== '') coerced[key] = Number(value);
  }

  const config = plainToInstance(EnvSchema, coerced, { exposeDefaultValues: true });
  const errors = validateSync(config, { skipMissingProperties: false, whitelist: false });

  if (errors.length > 0) {
    const summary = errors.map(
      (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
    );
    // Every missing variable at once. Booting, failing, adding one, and booting
    // again is a loop nobody should run four times.
    throw new Error(`invalid environment:\n  ${summary.join('\n  ')}`);
  }

  return config;
}
