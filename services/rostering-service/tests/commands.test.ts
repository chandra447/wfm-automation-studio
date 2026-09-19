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
const draftShiftId = '22222222-2222-4222-8222-000000000500';
const assignedShiftId = '22222222-2222-4222-8222-000000000501';

beforeAll(async () => {
  harness = await createRosteringHarness('commands');
  await seedLocation(harness.sql);
  for (const employee of Object.values(employees)) {
    await seedEmployee(harness.sql, employee);
  }
  await seedShift(harness.sql, {
    id: draftShiftId,
    startsAt: new Date(Date.now() + 48 * 3_600_000),
    endsAt: new Date(Date.now() + 56 * 3_600_000),
    status: 'draft',
  });
  await seedShift(harness.sql, {
    id: assignedShiftId,
    startsAt: new Date(Date.now() + 72 * 3_600_000),
    endsAt: new Date(Date.now() + 80 * 3_600_000),
    status: 'assigned',
    assignedEmployeeId: employees.outgoing.id,
    baselineCostCents: 49600,
  });
});

afterAll(async () => {
  await harness.drop();
});

describe('POST /shifts/:shiftId/publication', () => {
  test('publishes a draft shift and emits shift.published once', async () => {
    const response = await call(harness.app, `/shifts/${draftShiftId}/publication`, {
      method: 'POST',
      headers: managerHeaders,
    });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ status: string }>(response);
    expect(body.status).toBe('published');

    const events = await outboxEvents(harness.sql, 'shift.published');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.payload).toMatchObject({
      shiftId: draftShiftId,
      roleName: 'Registered Nurse',
      hourlyRateCents: 6200,
    });

    await call(harness.app, `/shifts/${draftShiftId}/publication`, {
      method: 'POST',
      headers: managerHeaders,
    });
    expect(await outboxEvents(harness.sql, 'shift.published')).toHaveLength(1);
  });
});

describe('POST /shifts/:shiftId/swap-request', () => {
  test('records the swap request and emits shift.swap_requested', async () => {
    const response = await call(harness.app, `/shifts/${assignedShiftId}/swap-request`, {
      method: 'POST',
      headers: { ...managerHeaders, 'x-employee-id': employees.outgoing.id },
      body: { requestingEmployeeId: employees.outgoing.id, targetEmployeeId: employees.bestFit.id, reason: 'University exam' },
    });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ swapRequestId: string; targetEmployeeId: string | null; shiftId: string }>(response);
    expect(body.shiftId).toBe(assignedShiftId);
    expect(body.targetEmployeeId).toBe(employees.bestFit.id);

    const events = await outboxEvents(harness.sql, 'shift.swap_requested');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.payload).toMatchObject({
      shiftId: assignedShiftId,
      requestingEmployeeId: employees.outgoing.id,
      targetEmployeeId: employees.bestFit.id,
      reason: 'University exam',
    });
  });

  test('refuses a swap request from an employee who is not assigned', async () => {
    const response = await call(harness.app, `/shifts/${assignedShiftId}/swap-request`, {
      method: 'POST',
      headers: managerHeaders,
      body: { requestingEmployeeId: employees.expensive.id, reason: 'Not my shift' },
    });
    expect(response.status).toBe(409);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('PRECONDITION_FAILED');
  });
});
