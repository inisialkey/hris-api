import type { Config } from 'drizzle-kit';

// drizzle-kit needs one schema root (backend-nestjs §2 rule 2): the files are
// centralised here and owned per module.
export default {
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_MIGRATOR_URL ?? '' },
  casing: 'snake_case',
} satisfies Config;
