import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { registerAuditedTables } from '../src/modules/audit/domain/audited-tables';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { AssignmentRepository } from '../src/modules/organization/infrastructure/assignment.repository';
import { BranchRepository } from '../src/modules/organization/infrastructure/branch.repository';
import { CompanyRepository } from '../src/modules/organization/infrastructure/company.repository';
import { DepartmentRepository } from '../src/modules/organization/infrastructure/department.repository';
import { PositionRepository } from '../src/modules/organization/infrastructure/position.repository';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The reads whose correctness is SQL rather than TypeScript: the vacancy
 * subquery, the chart's two joins, the as-of interval, and BR-ORG-003's holder
 * filter. A fake repository can assert what the service does with the rows; only
 * a database can assert that the rows are the right ones.
 */
describe('organization queries', () => {
  let db: TestDatabase;
  let drizzleDb: Database;
  let unitOfWork: UnitOfWork;
  let positions: PositionRepository;
  let assignments: AssignmentRepository;
  let companies: CompanyRepository;
  let branches: BranchRepository;
  let departments: DepartmentRepository;

  const tenantId = uuidv7();
  const companyId = uuidv7();
  const branchId = uuidv7();
  const departmentId = uuidv7();
  const jobLevelId = uuidv7();

  const cfo = uuidv7();
  const manager = uuidv7();
  const vacantSeat = uuidv7();

  const sari = uuidv7(); // active, has a login — a holder in every sense
  const budi = uuidv7(); // active, no login — holds a seat, cannot approve
  const dewi = uuidv7(); // resigned — not a holder at all

  const TODAY = '2026-08-06';
  const NOW = new Date(`${TODAY}T03:00:00Z`);

  beforeAll(async () => {
    db = await startTestDatabase();
    drizzleDb = drizzle(db.app, { schema });

    const connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);
    registerAuditedTables({
      companies: {},
      branches: {},
      departments: {},
      positions: {},
      org_assignments: {},
    });

    const audit = new AuditService(new AuditRepository(connection));
    positions = new PositionRepository(connection, audit, { now: () => NOW });
    assignments = new AssignmentRepository(connection, audit, { now: () => NOW });
    companies = new CompanyRepository(connection, audit, { now: () => NOW });
    branches = new BranchRepository(connection, audit, { now: () => NOW });
    departments = new DepartmentRepository(connection, audit, { now: () => NOW });

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'query-tenant',
    ]);

    await seed(async (raw) => {
      await raw('INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)', [
        companyId,
        tenantId,
        'C1',
        'Company One',
      ]);
      await raw(
        `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
         VALUES ($1, $2, $3, 'JKT', 'Jakarta', 'Asia/Jakarta')`,
        [branchId, tenantId, companyId],
      );
      await raw(
        `INSERT INTO departments (id, tenant_id, company_id, code, name)
         VALUES ($1, $2, $3, 'FIN', 'Finance')`,
        [departmentId, tenantId, companyId],
      );
      await raw(
        `INSERT INTO job_levels (id, tenant_id, code, name, rank)
         VALUES ($1, $2, 'L3', 'Manager', 3)`,
        [jobLevelId, tenantId],
      );

      for (const [id, code, title, reportsTo] of [
        [cfo, 'CFO', 'Chief Financial Officer', null],
        [manager, 'FIN-MGR', 'Finance Manager', cfo],
        [vacantSeat, 'FIN-ANL', 'Financial Analyst', manager],
      ] as const) {
        await raw(
          `INSERT INTO positions
             (id, tenant_id, company_id, department_id, job_level_id, code, title, reports_to_position_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, tenantId, companyId, departmentId, jobLevelId, code, title, reportsTo],
        );
      }

      const userId = uuidv7();
      await raw(
        `INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')`,
        [userId, tenantId, 'sari@example.test'],
      );

      for (const [id, number, name, status, user] of [
        [sari, 'E-001', 'Sari', 'active', userId],
        [budi, 'E-002', 'Budi', 'active', null],
        [dewi, 'E-003', 'Dewi', 'resigned', null],
      ] as const) {
        await raw(
          `INSERT INTO employees
             (id, tenant_id, company_id, user_id, employee_number, full_name, join_date, employment_type, status)
           VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01', 'pkwtt', $7)`,
          [id, tenantId, companyId, user, number, name, status],
        );
      }

      // Sari holds the manager seat from March, the CFO seat before that — so the
      // as-of read has a real boundary to land on.
      await raw(
        `INSERT INTO org_assignments
           (id, tenant_id, employee_id, position_id, branch_id, kind, effective_from, effective_to)
         VALUES ($1, $2, $3, $4, $5, 'hire', '2026-01-01', '2026-03-01')`,
        [uuidv7(), tenantId, sari, cfo, branchId],
      );
      await raw(
        `INSERT INTO org_assignments
           (id, tenant_id, employee_id, position_id, branch_id, kind, effective_from)
         VALUES ($1, $2, $3, $4, $5, 'promotion', '2026-03-01')`,
        [uuidv7(), tenantId, sari, manager, branchId],
      );
      // Budi co-holds the manager seat with no login; Dewi resigned out of the CFO seat.
      await raw(
        `INSERT INTO org_assignments
           (id, tenant_id, employee_id, position_id, branch_id, kind, effective_from)
         VALUES ($1, $2, $3, $4, $5, 'hire', '2026-01-01')`,
        [uuidv7(), tenantId, budi, manager, branchId],
      );
      await raw(
        `INSERT INTO org_assignments
           (id, tenant_id, employee_id, position_id, branch_id, kind, effective_from)
         VALUES ($1, $2, $3, $4, $5, 'hire', '2026-01-01')`,
        [uuidv7(), tenantId, dewi, cfo, branchId],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  /**
   * Seeding runs on its own tenant-scoped connection, not through `inRequest`:
   * `db.app.query` takes a *different* socket from the pool, where
   * `app.tenant_id` is unset and every insert loses to the RLS policy — which is
   * fail-closed working exactly as designed.
   */
  async function seed(
    fn: (raw: (sql: string, params: unknown[]) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await fn(async (sql, params) => {
        await client.query(sql, params);
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function inRequest<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId: 'u-1' });
      return unitOfWork.run({ tenantId, source: 'jwt' }, fn);
    });
  }

  describe('vacancy (BR-ORG-005)', () => {
    it('finds the seats nobody holds', async () => {
      const found = await inRequest(() =>
        positions.list({ companyId, vacant: true }, { limit: 20, offset: 0 }, TODAY),
      );

      // CFO has an assignment row and is still vacant: its only holder resigned,
      // and the employment filter lives *inside* the subquery rather than beside
      // it. A seat held by nobody employed is a vacancy the chart must show.
      expect(found.rows.map((row) => row.code)).toEqual(['CFO', 'FIN-ANL']);
    });

    it('finds the held seats with the same subquery negated', async () => {
      const found = await inRequest(() =>
        positions.list({ companyId, vacant: false }, { limit: 20, offset: 0 }, TODAY),
      );

      // CFO's only holder resigned, so it is vacant despite having an assignment
      // row — the employment filter is inside the subquery, not beside it.
      expect(found.rows.map((row) => row.code)).toEqual(['FIN-MGR']);
    });

    it('counts holders without counting the resigned one', async () => {
      const counts = await inRequest(() =>
        positions.holderCounts([cfo, manager, vacantSeat], TODAY),
      );

      expect([counts.get(cfo), counts.get(manager), counts.get(vacantSeat)]).toEqual([0, 2, 0]);
    });
  });

  describe('chart (UC-ORG-006)', () => {
    it('carries the department name, the rank, the edges and the vacant flag', async () => {
      const nodes = await inRequest(() => positions.chart(companyId, TODAY));

      expect(nodes).toHaveLength(3);
      const analyst = nodes.find((node) => node.code === 'FIN-ANL');
      expect(analyst).toMatchObject({
        departmentName: 'Finance',
        rank: 3,
        reportsToPositionId: manager,
        vacant: true,
        holders: [],
      });

      const mgr = nodes.find((node) => node.code === 'FIN-MGR');
      expect(mgr?.vacant).toBe(false);
      expect(mgr?.holders.map((holder) => holder.fullName)).toEqual(['Budi', 'Sari']);
    });
  });

  describe('as-of placement (BR-ORG-002, UC-ORG-001)', () => {
    it('treats effective_from as inclusive and effective_to as exclusive', async () => {
      const [before, boundary] = await inRequest(async () => [
        await assignments.placement(sari, '2026-02-28'),
        await assignments.placement(sari, '2026-03-01'),
      ]);

      expect(before?.positionId).toBe(cfo);
      expect(boundary?.positionId).toBe(manager);
    });

    it('returns null before the first placement', async () => {
      const placement = await inRequest(() => assignments.placement(sari, '2025-12-31'));
      expect(placement).toBeNull();
    });

    it('carries the branch timezone every time-math module reads', async () => {
      const placement = await inRequest(() => assignments.placement(sari, TODAY));
      expect(placement).toMatchObject({ companyId, branchId, branchTimezone: 'Asia/Jakarta' });
    });

    it('keys the batch form by employee', async () => {
      const found = await inRequest(() => assignments.placements([sari, budi, dewi], TODAY));

      expect(found.get(sari)?.positionId).toBe(manager);
      expect(found.get(budi)?.positionId).toBe(manager);
      // Dewi is still placed — resignation is a status, and BR-ORG-006's exit
      // close is employee.md's act, not a side effect of the status.
      expect(found.get(dewi)?.positionId).toBe(cfo);
    });
  });

  describe('holder filter (BR-ORG-003)', () => {
    it('returns only holders who are employed and can log in', async () => {
      const holders = await inRequest(() => assignments.holderUserIds([manager], TODAY));

      // Budi holds the seat and is excluded here but not from the chart: he has
      // no user account, so the engine could not assign him a step.
      expect(holders).toHaveLength(1);
    });

    it('excludes the subject by employee', async () => {
      const holders = await inRequest(() => assignments.holderUserIds([manager], TODAY, sari));

      expect(holders).toEqual([]);
    });

    it('returns nothing for a seat whose only holder resigned', async () => {
      expect(await inRequest(() => assignments.holderUserIds([cfo], TODAY))).toEqual([]);
    });
  });

  describe('archive guards (BR-ORG-006)', () => {
    // These run real SQL across five tables including two this module does not
    // own, which is the part no fake can stand in for.
    it('counts every blocker class on a company', async () => {
      const blockers = await inRequest(() => companies.archiveBlockers(companyId));

      expect(blockers).toEqual([
        // Dewi resigned, so two of the three employees block.
        { type: 'employee', count: 2 },
        { type: 'branch', count: 1 },
        { type: 'department', count: 1 },
        { type: 'position', count: 3 },
      ]);
    });

    it('blocks a branch on live and future assignments but not on closed history', async () => {
      // Four rows point at this branch; Sari's CFO row closed in March, so three
      // block. A branch nobody is placed at any more is archivable even though
      // the history still names it.
      expect(await inRequest(() => branches.archiveBlockers(branchId))).toEqual([
        { type: 'assignment', count: 3 },
      ]);
    });

    it('blocks a department on its positions', async () => {
      expect(await inRequest(() => departments.archiveBlockers(departmentId))).toEqual([
        { type: 'position', count: 3 },
      ]);
    });

    it('blocks a position on holders and on the seats reporting to it', async () => {
      expect(await inRequest(() => positions.archiveBlockers(manager))).toEqual([
        { type: 'holder', count: 2 },
        { type: 'reporting_position', count: 1 },
      ]);
    });

    it('leaves a clean position with no blockers', async () => {
      expect(await inRequest(() => positions.archiveBlockers(vacantSeat))).toEqual([]);
    });
  });

  describe('audience resolution (BR-ANN-002)', () => {
    it('unions the dimensions rather than intersecting them', async () => {
      const found = await inRequest(() =>
        assignments.audienceEmployeeIds(
          { companyId, positionIds: [vacantSeat], jobLevelIds: [jobLevelId] },
          TODAY,
        ),
      );

      // Nobody holds the analyst seat, but everyone employed is at this level —
      // an intersection would have returned nothing.
      expect(found.sort()).toEqual([sari, budi].sort());
    });

    it('means everyone in scope when no dimension is given', async () => {
      const found = await inRequest(() => assignments.audienceEmployeeIds({ companyId }, TODAY));

      expect(found.sort()).toEqual([sari, budi].sort());
    });
  });
});
