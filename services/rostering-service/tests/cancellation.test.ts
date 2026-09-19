import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  call,
  createRosteringHarness,
  employees,
  jsonOf,
  managerHeaders,
  outboxEvents,
  seedEmployee,
  seedLocation,
  seedShift,
  type TestHarness,
} from './helpers.ts';

let harness: TestHarness;
const shiftId = '22222222-2222-4222-8222-000000000300';

beforeAll(async () => {
  harness = await createRosteringHarness('cancellation');
  await seedLocation(harness.sql);
  for (const employee of Object.values(employees)) {
    await seedEmployee(harness.sql, employee);
  }
  await seedShift(harness.sql, {
    id: shiftId,
    startsAt: new Date(Date.now() + 8 * 3_600_000),
    endsAt: new Date(Date.now() + 16 * 3_600_000),
    status: 'assigned',
    assignedEmployeeId: employees.outgoing.id,
  });
});

afterAll(async () => {
  await harness.drop();
});

describe('POST /shifts/:shiftId/cancellation', () => {
  test('cancels the shift and emits shift.cancelled with hoursUntilStart from now', async () => {
    const response = await call(harness.app, `/shifts/${shiftId}/cancellation`, {
      method: 'POST',
      headers: managerHeaders,
      body: { reason: 'Sick leave', cancelledByEmployeeId: employees.outgoing.id },
    });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ status: string; assignedEmployeeId: string | null }>(response);
    expect(body.status).toBe('cancelled');
    expect(body.assignedEmployeeId).toBeNull();

    const events = await outboxEvents(harness.sql, 'shift.cancelled');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload.payload as Record<string, unknown>;
    const hoursUntilStart = payload?.['hoursUntilStart'] as number;
    expect(hoursUntilStart).toBeGreaterThanOrEqual(7.9);
    expect(hoursUntilStart).toBeLessThanOrEqual(8.01);
    expect(payload?.['cancelledByEmployeeId']).toBe(employees.outgoing.id);
    expect(payload?.['roleName']).toBe('Registered Nurse');
    expect(payload?.['requiredQualificationCodes']).toEqual(['RN', 'AGED_CARE']);
    expect(payload?.['reason']).toBe('Sick leave');
  });

  test('refuses to cancel an already cancelled shift', async () => {
    const response = await call(harness.app, `/shifts/${shiftId}/cancellation`, {
      method: 'POST',
      headers: managerHeaders,
      body: { reason: 'Duplicate' },
    });
    expect(response.status).toBe(409);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('PRECONDITION_FAILED');
  });
});
