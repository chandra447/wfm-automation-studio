import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  call,
  createRosteringHarness,
  employees,
  jsonOf,
  managerHeaders,
  seedEmployee,
  seedLocation,
  seedShift,
  type TestHarness,
} from './helpers.ts';

let harness: TestHarness;
const targetShiftId = '22222222-2222-4222-8222-000000000100';
const previousShiftId = '22222222-2222-4222-8222-000000000101';

beforeAll(async () => {
  harness = await createRosteringHarness('candidates');
  await seedLocation(harness.sql);
  for (const employee of Object.values(employees)) {
    await seedEmployee(harness.sql, employee);
  }
  // Outgoing finished a shift five hours before the target shift starts: the
  // 10h rest rule must exclude them even though they hold every qualification.
  await seedShift(harness.sql, {
    id: previousShiftId,
    startsAt: new Date(Date.now() + 11 * 3_600_000),
    endsAt: new Date(Date.now() + 19 * 3_600_000),
    status: 'assigned',
    assignedEmployeeId: employees.outgoing.id,
    baselineCostCents: 49600,
  });
  await seedShift(harness.sql, {
    id: targetShiftId,
    startsAt: new Date(Date.now() + 24 * 3_600_000),
    endsAt: new Date(Date.now() + 32 * 3_600_000),
    baselineCostCents: 49600,
  });
});

afterAll(async () => {
  await harness.drop();
});

describe('GET /shifts/:shiftId/candidates', () => {
  test('ranks eligible employees and excludes unqualified, overlapping and rest-rule-violating ones', async () => {
    const response = await call(harness.app, `/shifts/${targetShiftId}/candidates`, { headers: managerHeaders });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ shiftId: string; candidates: Array<{ employeeId: string; estimatedCostCents: number; costDeltaVsBaselineCents: number; overtimeRisk: string; restHoursBeforeShift: number; score: number }> }>(response);

    const rankedIds = body.candidates.map((candidate) => candidate.employeeId);
    expect(rankedIds).not.toContain(employees.unqualified.id);
    expect(rankedIds).not.toContain(employees.outgoing.id);

    const bestFit = body.candidates.find((candidate) => candidate.employeeId === employees.bestFit.id);
    const expensive = body.candidates.find((candidate) => candidate.employeeId === employees.expensive.id);
    expect(bestFit).toBeDefined();
    expect(expensive).toBeDefined();
    expect(rankedIds).toEqual([employees.bestFit.id, employees.expensive.id]);

    expect(bestFit?.estimatedCostCents).toBe(51200);
    expect(bestFit?.costDeltaVsBaselineCents).toBe(1600);
    expect(bestFit?.overtimeRisk).toBe('low');
    expect(bestFit?.restHoursBeforeShift).toBe(48);
    expect(bestFit?.score).toBeGreaterThan(expensive?.score ?? 0);

    expect(expensive?.overtimeRisk).toBe('high');
    expect(expensive?.costDeltaVsBaselineCents).toBe(15200);
  });

  test('drops employees named in excludeEmployeeIds', async () => {
    const response = await call(
      harness.app,
      `/shifts/${targetShiftId}/candidates?excludeEmployeeIds=${employees.bestFit.id}`,
      { headers: managerHeaders },
    );
    expect(response.status).toBe(200);
    const body = await jsonOf<{ candidates: Array<{ employeeId: string }> }>(response);
    expect(body.candidates.map((candidate) => candidate.employeeId)).toEqual([employees.expensive.id]);
  });

  test('rejects malformed excludeEmployeeIds values', async () => {
    const response = await call(harness.app, `/shifts/${targetShiftId}/candidates?excludeEmployeeIds=not-a-uuid`, {
      headers: managerHeaders,
    });
    expect(response.status).toBe(400);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
