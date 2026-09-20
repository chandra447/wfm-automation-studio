import { SQL } from 'bun';
import { ensureOutboxTable } from '@wfm/outbox';
import { createTestDatabase, demo } from '@wfm/testkit';
import { createRosteringApp } from '../src/app.ts';
import { applyMigrations } from '../src/db/migrate.ts';

export { demo };

process.env.EVENT_STREAM_PREFIX ??= 'wfm.test.rostering';

const ADMIN_URL = 'postgres://wfm:wfm@127.0.0.1:5433/postgres';

const TENANT_ID = demo.tenantId;
const LOCATION_ID = demo.location.id;

export interface AppHandle {
  handle: (request: Request) => Promise<Response>;
}

export interface TestHarness {
  sql: SQL;
  app: AppHandle;
  tenantId: string;
  locationId: string;
  drop: () => Promise<void>;
}

export async function createRosteringHarness(databaseLabel: string): Promise<TestHarness> {
  const database = await createTestDatabase(
    ADMIN_URL,
    `rostering_${databaseLabel}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
  );
  await applyMigrations(database.url);
  const sql = new SQL(database.url, { max: 10 });
  await ensureOutboxTable(sql);
  const app = createRosteringApp(sql);
  return {
    sql,
    app,
    tenantId: TENANT_ID,
    locationId: LOCATION_ID,
    drop: async () => {
      await sql.close({ timeout: 5 });
      await database.drop();
    },
  };
}

interface SeedEmployee {
  id: string;
  name: string;
  qualificationCodes: readonly string[];
  hourlyRateCents: number;
  weeklyHours: number;
}

export async function seedEmployee(sql: SQL, employee: SeedEmployee): Promise<void> {
  const email = `${employee.name.toLowerCase().replaceAll(' ', '.')}@demo.test`;
  await sql`
    INSERT INTO employees (id, tenant_id, name, email, hourly_rate_cents, weekly_hours)
    VALUES (${employee.id}, ${TENANT_ID}, ${employee.name}, ${email}, ${employee.hourlyRateCents}, ${employee.weeklyHours})
  `;
  for (const code of employee.qualificationCodes) {
    await sql`
      INSERT INTO employee_qualifications (id, tenant_id, employee_id, code)
      VALUES (${crypto.randomUUID()}, ${TENANT_ID}, ${employee.id}, ${code})
    `;
  }
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await sql`
      INSERT INTO employee_availability (id, tenant_id, employee_id, weekday, start_minute, end_minute)
      VALUES (${crypto.randomUUID()}, ${TENANT_ID}, ${employee.id}, ${weekday}, 0, 1440)
    `;
  }
}

export interface SeedShift {
  id: string;
  startsAt: Date;
  endsAt: Date;
  roleName?: string;
  requiredQualificationCodes?: string[];
  hourlyRateCents?: number;
  status?: 'draft' | 'published' | 'offered' | 'assigned' | 'cancelled';
  assignedEmployeeId?: string | null;
  baselineCostCents?: number;
}

export async function seedShift(sql: SQL, shift: SeedShift): Promise<void> {
  await sql`
    INSERT INTO shifts (
      id, tenant_id, location_id, role_name, required_qualification_codes,
      starts_at, ends_at, hourly_rate_cents, status, assigned_employee_id, baseline_cost_cents
    ) VALUES (
      ${shift.id}, ${TENANT_ID}, ${LOCATION_ID}, ${shift.roleName ?? 'Registered Nurse'},
      ${shift.requiredQualificationCodes ?? ['RN', 'AGED_CARE']},
      ${shift.startsAt}, ${shift.endsAt}, ${shift.hourlyRateCents ?? 6200},
      ${shift.status ?? 'published'}, ${shift.assignedEmployeeId ?? null},
      ${shift.baselineCostCents ?? 49600}
    )
  `;
}

export async function seedLocation(sql: SQL): Promise<void> {
  await sql`
    INSERT INTO locations (id, tenant_id, name, timezone)
    VALUES (${LOCATION_ID}, ${TENANT_ID}, ${demo.location.name}, 'Australia/Melbourne')
  `;
}

export interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function call(app: AppHandle, path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`http://rostering.test${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers ?? { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return app.handle(request);
}

export async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function outboxEvents(
  sql: SQL,
  eventType: string,
  tenantId = TENANT_ID,
): Promise<Array<{ payload: { payload: Record<string, unknown>; eventType: string; correlationId: string; actor: unknown } }>> {
  return sql`
    SELECT payload
    FROM outbox
    WHERE event_type = ${eventType} AND tenant_id = ${tenantId}
    ORDER BY created_at
  `;
}

export const employees = {
  outgoing: { id: demo.employees.outgoing.id, name: demo.employees.outgoing.name, qualificationCodes: demo.employees.outgoing.qualifications, hourlyRateCents: demo.employees.outgoing.hourlyRateCents, weeklyHours: 32 },
  bestFit: { id: demo.employees.bestFit.id, name: demo.employees.bestFit.name, qualificationCodes: demo.employees.bestFit.qualifications, hourlyRateCents: demo.employees.bestFit.hourlyRateCents, weeklyHours: 28 },
  expensive: { id: demo.employees.expensive.id, name: demo.employees.expensive.name, qualificationCodes: demo.employees.expensive.qualifications, hourlyRateCents: demo.employees.expensive.hourlyRateCents, weeklyHours: 38 },
  unqualified: { id: demo.employees.unqualified.id, name: demo.employees.unqualified.name, qualificationCodes: demo.employees.unqualified.qualifications, hourlyRateCents: demo.employees.unqualified.hourlyRateCents, weeklyHours: 20 },
} as const;

export function actorHeadersOf(actor: { userId: string; roles: readonly string[] }, employeeId?: string): Record<string, string> {
  return {
    'x-tenant-id': TENANT_ID,
    'x-user-id': actor.userId,
    'x-user-roles': actor.roles.join(','),
    ...(employeeId === undefined ? {} : { 'x-employee-id': employeeId }),
    'content-type': 'application/json',
  };
}

export const managerHeaders = actorHeadersOf(demo.manager);
