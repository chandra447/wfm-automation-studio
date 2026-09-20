import { SQL } from 'bun';

/** Fixtures shared by the seed script and the end-to-end tests. */
export const demo = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantName: 'Aurora Care Group',
  location: {
    id: '33333333-3333-4333-8333-000000000001',
    name: 'Aurora Aged Care — Kew',
  },
  employees: {
    outgoing: {
      id: '44444444-4444-4444-8444-000000000001',
      name: 'Priya Raman',
      email: 'priya.raman@demo.test',
      qualifications: ['RN', 'AGED_CARE'],
      hourlyRateCents: 6200,
    },
    bestFit: {
      id: '44444444-4444-4444-8444-000000000003',
      name: 'Marcus Webb',
      email: 'marcus.webb@demo.test',
      qualifications: ['RN', 'AGED_CARE', 'MEDICATION'],
      hourlyRateCents: 6400,
    },
    expensive: {
      id: '44444444-4444-4444-8444-000000000004',
      name: 'Elena Fischer',
      email: 'elena.fischer@demo.test',
      qualifications: ['RN', 'AGED_CARE'],
      hourlyRateCents: 8100,
    },
    unqualified: {
      id: '44444444-4444-4444-8444-000000000005',
      name: 'Tom Okafor',
      email: 'tom.okafor@demo.test',
      qualifications: ['SUPPORT_WORKER'],
      hourlyRateCents: 4800,
    },
  },
  manager: {
    userId: 'manager@demo.test',
    roles: ['roster_manager'],
  },
  peopleOps: {
    userId: 'people-ops@demo.test',
    roles: ['people_ops'],
  },
  awardRuleCode: 'MA000034',
  scenarios: {
    coverageRescueShiftId: '22222222-2222-4222-8222-000000000003',
    payrollTimesheetId: '77777777-7777-4777-8777-000000000001',
  },
} as const;

export interface TestDatabase {
  url: string;
  drop: () => Promise<void>;
}

export async function createTestDatabase(adminUrl: string, databaseName: string): Promise<TestDatabase> {
  const admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.close({ timeout: 5 });
    },
  };
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description: string;
}

/** Polls until the predicate holds; throws with the description on timeout. */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  options: WaitOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for: ${options.description}` +
          (lastError ? ` (last error: ${String(lastError)})` : ''),
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

export function actorHeaders(actor: { userId: string; roles: readonly string[] }, employeeId?: string): Record<string, string> {
  return {
    'x-tenant-id': demo.tenantId,
    'x-user-id': actor.userId,
    'x-user-roles': actor.roles.join(','),
    ...(employeeId ? { 'x-employee-id': employeeId } : {}),
    'content-type': 'application/json',
  };
}
