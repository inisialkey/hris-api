import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { SETTING_DEFINITIONS } from '../modules/settings/domain/definitions';
import { stableStringify } from '../shared/stable-json';
import { settingDefinitions } from './schema';

/**
 * UC-SET-006 — `settings.sync-definitions`, mirroring `authz.sync-templates`.
 *
 * A script rather than a BullMQ job, because §12 gives it one trigger and that
 * trigger is the release pipeline: it runs beside `migrate`, on the same
 * credential, before the application pods that will read what it wrote.
 *
 * **Idempotent, and idempotent in the way that matters** — re-running it must
 * not disturb a key nobody changed, or every release would look like a
 * configuration change to whoever is reading the audit log. Metadata is updated
 * in place, retired keys are stamped rather than deleted (their tenant *values*
 * stay, per §9 — resolution simply stops asking), and a key that reappears in a
 * later release un-stamps.
 */
export async function syncDefinitions(pool: Pool): Promise<{
  inserted: number;
  updated: number;
  deprecated: number;
}> {
  const db = drizzle(pool);
  const existing = await db.select().from(settingDefinitions);
  const byKey = new Map(existing.map((row) => [row.key, row]));

  let inserted = 0;
  let updated = 0;

  for (const definition of SETTING_DEFINITIONS) {
    const row = {
      key: definition.key,
      module: definition.module,
      type: definition.type,
      allowedLevels: definition.allowedLevels,
      defaultValue: definition.defaultValue,
      validation: definition.validation ?? null,
      effectiveDated: definition.effectiveDated,
      clientVisible: definition.clientVisible,
      requiredPermission: definition.requiredPermission ?? null,
      description: definition.description,
      // A key that comes back in a later release is live again — the row is the
      // registry's mirror, not a log of what has ever been declared.
      deprecatedAt: null,
    };

    const current = byKey.get(definition.key);
    if (!current) {
      await db.insert(settingDefinitions).values({ id: uuidv7(), ...row });
      inserted += 1;
      continue;
    }
    if (!isUnchanged(current, row)) {
      await db
        .update(settingDefinitions)
        .set(row)
        .where(sql`key = ${definition.key}`);
      updated += 1;
    }
  }

  const live = new Set(SETTING_DEFINITIONS.map((definition) => definition.key));
  const retired = existing.filter((row) => !live.has(row.key) && row.deprecatedAt === null);
  for (const row of retired) {
    // BR-SET-001's lifecycle, mirroring permissions: stamp, never delete. The
    // tenant's values for the key stay valid history.
    await db
      .update(settingDefinitions)
      .set({ deprecatedAt: new Date() })
      .where(sql`key = ${row.key}`);
  }

  return { inserted, updated, deprecated: retired.length };
}

type DefinitionRow = typeof settingDefinitions.$inferSelect;

function isUnchanged(current: DefinitionRow, next: Record<string, unknown>): boolean {
  return (
    current.module === next.module &&
    current.type === next.type &&
    stableStringify(current.allowedLevels) === stableStringify(next.allowedLevels) &&
    stableStringify(current.defaultValue) === stableStringify(next.defaultValue) &&
    // jsonb hands `validation` back in its own key order, so a plain stringify
    // would call every row changed on every release.
    stableStringify(current.validation ?? null) === stableStringify(next.validation) &&
    current.effectiveDated === next.effectiveDated &&
    current.clientVisible === next.clientVisible &&
    (current.requiredPermission ?? null) === next.requiredPermission &&
    current.description === next.description &&
    current.deprecatedAt === null
  );
}

async function main(): Promise<void> {
  // The migrator, like `migrate.ts`: this is release-time platform data, and the
  // application has no business writing the registry it reads (BR-SET-001).
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL is required');

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await syncDefinitions(pool);
    process.stdout.write(
      `setting definitions synced: ${result.inserted} inserted, ${result.updated} updated, ${result.deprecated} deprecated\n`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('sync-definitions.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
