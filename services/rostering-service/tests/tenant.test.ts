import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { ensureOutboxTable } from '@wfm/outbox';
import { createTestDatabase } from '@wfm/testkit';
import { applyMigrations } from '../src/db/migrate.ts';
import { createRosteringApp } from '../src/app.ts';
import {
  call,
  employees,
  jsonOf,
  managerHeaders,
  seedEmployee,
  seedLocation,
  seedShift,
  type AppHandle,
} from './helpers.ts';

const otherTenantId = '22222222-2222-4222-8222-999999999999';
const shiftId = '22222222-2222-4222-8222-000000000600';

let sql: postgres.Sql;
let app: AppHandle;
let drop: () => Promise<void>;

beforeAll(async () => {
  const database = await createTestDatabase(
    'postgres://wfm:wfm@127.0.0.1:5433/postgres',
    `rostering_tenant_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
  );
  await applyMigrations(database.url);
  sql = postgres(database.url, { onnotice: () => {} });
  await ensureOutboxTable(sql);
  app = createRosteringApp(sql);
  drop = database.drop;

  await seedLocation(sql);
  for (const employee of Object.values(employees)) {
    await seedEmployee(sql, employee);
  }
  await seedShift(sql, {
    id: shiftId,
    startsAt: new Date(Date.now() + 12 * 3_600_000),
    endsAt: new Date(Date.now() + 20 * 3_600_000),
  });
});

afterAll(async () => {
  await sql.end();
  await drop();
});

const otherTenantHeaders = {
  'x-tenant-id': otherTenantId,
  'x-user-id': 'manager@other.test',
  'x-user-roles': 'roster_manager',
  'content-type': 'application/json',
};

describe('tenant scoping', () => {
  test('hides shifts from another tenant', async () => {
    const response = await call(app, `/shifts/${shiftId}`, { headers: otherTenantHeaders });
    expect(response.status).toBe(404);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('refuses candidates for a shift outside the tenant', async () => {
    const response = await call(app, `/shifts/${shiftId}/candidates`, { headers: otherTenantHeaders });
    expect(response.status).toBe(404);
  });

  test('refuses to mutate a shift outside the tenant', async () => {
    const response = await call(app, `/shifts/${shiftId}/offers`, {
      method: 'POST',
      headers: { ...otherTenantHeaders, 'idempotency-key': 'run:1:step:offers' },
      body: {
        employeeIds: [employees.bestFit.id],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'Cross tenant attempt',
      },
    });
    expect(response.status).toBe(404);

    const offerRows = await sql`SELECT count(*)::int AS count FROM shift_offers WHERE shift_id = ${shiftId}`;
    expect(offerRows[0]?.count).toBe(0);
    const events = await sql`SELECT count(*)::int AS count FROM outbox`;
    expect(events[0]?.count).toBe(0);
  });

  test('refuses requests without actor headers', async () => {
    const response = await call(app, '/shifts', {
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('INVALID_ACTOR_CONTEXT');
  });

  test('returns shifts for the owning tenant', async () => {
    const response = await call(app, '/shifts', { headers: managerHeaders });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ shifts: Array<{ shiftId: string; tenantId: string; locationName: string }> }>(response);
    expect(body.shifts.map((shift) => shift.shiftId)).toContain(shiftId);
    expect(body.shifts.every((shift) => shift.tenantId !== otherTenantId)).toBe(true);
  });
});
