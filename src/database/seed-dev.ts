import { randomBytes } from 'node:crypto';

import { Algorithm, hash } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  permissions,
  rolePermissions,
  roles,
  scratchNotes,
  tenantKeys,
  tenants,
  userRoles,
  users,
} from './schema';
import { LocalKeyProvider } from '../shared/crypto/local-key-provider';

/**
 * Local development seed — **temporary**.
 *
 * environments.md §4 says seeding runs through system-administration §5.3's real
 * provisioning path, on the ground that a smoke suite running on
 * differently-shaped data tests a system that does not exist. That path does not
 * exist yet: this skeleton is what it will eventually be built on. So this
 * script is a placeholder with one job, and it is deleted the day provisioning
 * lands rather than kept as a faster alternative.
 *
 * It seeds **two** tenants, which is not decoration: cross-tenant behaviour has
 * to be visible while developing, not only while testing, and a single-tenant
 * local database makes every isolation defect look like correct behaviour.
 *
 * It writes through `hris_app` with `set_config` per tenant — the same path
 * runtime code takes. There is no setup mode that bypasses isolation, so a
 * seeding bug cannot become a cross-tenant bug (multi-tenancy §8).
 */

const DEV_PASSWORD = 'skeleton-password-1';

const TENANTS = [
  { slug: 'tenant-one', name: 'Tenant One', email: 'admin@tenant-one.test' },
  { slug: 'tenant-two', name: 'Tenant Two', email: 'admin@tenant-two.test' },
];

/**
 * Only the keys the auth module's own routes ask for (authentication.md §2).
 *
 * The full catalog is code-defined and belongs to authorization-rbac
 * (ADR-0005); seeding a guess at it here would make this file the second
 * definition of a registry that has one owner.
 */
const SKELETON_PERMISSIONS = [
  { key: 'auth.session.read', module: 'auth', description: 'List sessions of any user in tenant' },
  { key: 'auth.session.revoke', module: 'auth', description: 'Revoke any session in tenant' },
  { key: 'auth.device.read', module: 'auth', description: 'List devices of any user in tenant' },
  { key: 'auth.device.revoke', module: 'auth', description: 'Revoke any device in tenant' },
  { key: 'auth.user.unlock', module: 'auth', description: 'Clear a locked account' },
  { key: 'auth.user.reset', module: 'auth', description: 'Trigger a password reset for a user' },
  { key: 'audit.log.read', module: 'audit', description: 'Query the audit log and verify anchors' },
  { key: 'settings.setting.read', module: 'settings', description: 'Read definitions and values' },
  {
    key: 'settings.setting.configure',
    module: 'settings',
    description: 'Write, schedule and cancel setting values',
  },
  {
    key: 'settings.statutory_policy.configure',
    module: 'settings',
    description: 'Definition-level override for statutory-adjacent keys (settings §2)',
  },
  {
    key: 'employee.master.read',
    module: 'employee',
    description: 'List and read employees (masked)',
  },
  { key: 'employee.master.create', module: 'employee', description: 'Hire an employee' },
  {
    key: 'employee.master.update',
    module: 'employee',
    description: 'Edit master data, contracts and family members',
  },
  {
    key: 'employee.master.delete',
    module: 'employee',
    description: 'Soft-delete a terminal-status employee',
  },
  {
    key: 'employee.termination.execute',
    module: 'employee',
    description: 'Terminate an employee',
  },
  {
    key: 'employee.sensitive.read',
    module: 'employee',
    description: 'Reveal an employee’s ADR-0016 encrypted values',
  },
  {
    key: 'employee.document.create',
    module: 'employee',
    description: 'Attach a document to an employee (document-storage §4.2 owner)',
  },
  {
    key: 'employee.document.read',
    module: 'employee',
    description: 'Read an employee’s documents; self needs no key',
  },
  {
    key: 'employee.document.delete',
    module: 'employee',
    description: 'Remove an employee document',
  },
  {
    key: 'approval.chain.read',
    module: 'approval',
    description: 'Read approval chain configuration',
  },
  {
    key: 'approval.chain.configure',
    module: 'approval',
    description: 'Create, edit and archive approval chains',
  },
  {
    key: 'approval.instance.read',
    module: 'approval',
    description: 'Oversight grid over every approval instance in scope',
  },
  {
    key: 'approval.delegation.assign',
    module: 'approval',
    description: "Manage another user's approval delegation",
  },
  {
    key: 'organization.company.read',
    module: 'organization',
    description: 'Read companies in scope',
  },
  {
    key: 'organization.company.configure',
    module: 'organization',
    description: 'Create, edit and archive companies (create/archive need tenant-wide scope)',
  },
  {
    key: 'organization.structure.read',
    module: 'organization',
    description: 'Read branches, departments, job levels and positions',
  },
  {
    key: 'organization.structure.configure',
    module: 'organization',
    description: 'Configure structure; job levels additionally need tenant-wide scope',
  },
  {
    key: 'organization.assignment.read',
    module: 'organization',
    description: 'Read employee placement history',
  },
  {
    key: 'organization.assignment.assign',
    module: 'organization',
    description: 'Move employees and cancel scheduled moves',
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (process.env.APP_ENV !== 'local')
    throw new Error('seed:dev refuses to run outside APP_ENV=local');

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  // The provider refuses to construct outside `local`, which the guard above
  // has already asserted — belt and braces, one line apart.
  const keys = new LocalKeyProvider({
    get: (name: string) => process.env[name],
  } as unknown as ConfigService);

  try {
    const passwordHash = await hash(DEV_PASSWORD, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 64 * 1024,
      timeCost: 3,
      parallelism: 4,
    });

    // Platform table, no RLS, no tenant context needed.
    await db
      .insert(permissions)
      .values(SKELETON_PERMISSIONS.map((p) => ({ id: uuidv7(), ...p })))
      .onConflictDoNothing();
    const permissionRows = await db
      .select({ id: permissions.id, key: permissions.key })
      .from(permissions);
    const permissionByKey = new Map(permissionRows.map((p) => [p.key, p.id]));

    for (const spec of TENANTS) {
      const tenantId = uuidv7();
      await db.insert(tenants).values({ id: tenantId, name: spec.name, slug: spec.slug });

      // ADR-0016 decision 4 — the per-tenant DEK and index key, wrapped under the
      // KEK, generated **before** the tenant transaction so a KMS call never
      // holds one open (system-administration.md BR-ADM-005). Provisioning owns
      // this write when it ships; until then a tenant seeded without it cannot
      // hold an employee at all, because every encrypted column would fail loud.
      // `tenant_keys` is platform-class — no RLS — so it goes on the plain handle.
      await db.insert(tenantKeys).values({
        id: uuidv7(),
        tenantId,
        wrappedDek: await keys.wrap(randomBytes(32)),
        wrappedIndexKey: await keys.wrap(randomBytes(32)),
        kekVersion: keys.activeKekVersion(),
      });

      // Everything below is tenant-class, so it goes through the same
      // transaction + set_config the request path uses.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);

        const roleId = uuidv7();
        await tx.insert(roles).values({
          id: roleId,
          tenantId,
          key: 'system_administrator',
          name: 'System Administrator',
          isSystem: true,
        });

        for (const spec2 of SKELETON_PERMISSIONS) {
          const permissionId = permissionByKey.get(spec2.key);
          if (!permissionId) throw new Error(`permission ${spec2.key} missing after insert`);
          await tx.insert(rolePermissions).values({ tenantId, roleId, permissionId });
        }

        const userId = uuidv7();
        await tx.insert(users).values({ id: userId, tenantId, email: spec.email, passwordHash });
        // `company_id` NULL = tenant-wide (ADR-0005).
        await tx.insert(userRoles).values({ id: uuidv7(), tenantId, userId, roleId });

        await tx.insert(scratchNotes).values({
          id: uuidv7(),
          tenantId,
          body: `note belonging to ${spec.slug}`,
        });
      });

      process.stdout.write(`seeded ${spec.slug} (${spec.email} / ${DEV_PASSWORD})\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${String(error)}\n`);
  process.exitCode = 1;
});
