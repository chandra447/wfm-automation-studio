import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  actorHeadersOf,
  call,
  createRosteringHarness,
  demo,
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
const shiftId = '22222222-2222-4222-8222-000000000400';
const key = 'run:99999999:step:send_offers';

const offerHeaders = { ...managerHeaders, 'idempotency-key': key };

beforeAll(async () => {
  harness = await createRosteringHarness('acceptance');
  await seedLocation(harness.sql);
  for (const employee of Object.values(employees)) {
    await seedEmployee(harness.sql, employee);
  }
  await seedShift(harness.sql, {
    id: shiftId,
    startsAt: new Date(Date.now() + 12 * 3_600_000),
    endsAt: new Date(Date.now() + 20 * 3_600_000),
  });
});

afterAll(async () => {
  await harness.drop();
});

async function sendOffers(employeeIds: string[], expiresAt?: string): Promise<Record<string, unknown>[]> {
  const response = await call(harness.app, `/shifts/${shiftId}/offers`, {
    method: 'POST',
    headers: { ...offerHeaders, 'idempotency-key': `${key}:${employeeIds[0]}` },
    body: {
      employeeIds,
      expiresAt: expiresAt ?? new Date(Date.now() + 2 * 3_600_000).toISOString(),
      reason: 'Coverage rescue',
    },
  });
  expect(response.status).toBe(200);
  return (await jsonOf<{ offers: Record<string, unknown>[] }>(response)).offers;
}

describe('POST /shifts/:shiftId/acceptance', () => {
  test('accepts an offer, assigns the shift, and emits shift.assigned by employee_acceptance', async () => {
    const offers = await sendOffers([employees.outgoing.id, employees.bestFit.id]);
    const offer = offers.find((row) => row['employeeId'] === employees.outgoing.id);
    expect(offer).toBeDefined();

    const employeeHeaders = actorHeadersOf(demo.manager, employees.outgoing.id);
    const response = await call(harness.app, `/shifts/${shiftId}/acceptance`, {
      method: 'POST',
      headers: employeeHeaders,
      body: { employeeId: employees.outgoing.id, offerId: offer?.['offerId'] as string },
    });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ status: string; assignedEmployeeId: string }>(response);
    expect(body.status).toBe('assigned');
    expect(body.assignedEmployeeId).toBe(employees.outgoing.id);

    const events = await outboxEvents(harness.sql, 'shift.assigned');
    expect(events).toHaveLength(1);
    const envelope = events[0]?.payload;
    const payload = envelope?.payload as Record<string, unknown>;
    expect(payload?.['assignedBy']).toBe('employee_acceptance');
    expect(payload?.['employeeId']).toBe(employees.outgoing.id);
    expect(envelope?.actor).toEqual({ type: 'employee', id: employees.outgoing.id });
  });

  test('refuses to accept the same offer twice', async () => {
    const detail = await jsonOf<{ offers: Array<{ offerId: string; employeeId: string; status: string }> }>(
      await call(harness.app, `/shifts/${shiftId}/offers`, { headers: managerHeaders }),
    );
    const accepted = detail.offers.find((row) => row.employeeId === employees.outgoing.id);
    expect(accepted?.status).toBe('accepted');

    const response = await call(harness.app, `/shifts/${shiftId}/acceptance`, {
      method: 'POST',
      headers: actorHeadersOf(demo.manager, employees.outgoing.id),
      body: { employeeId: employees.outgoing.id, offerId: accepted?.offerId },
    });
    expect(response.status).toBe(409);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('PRECONDITION_FAILED');
  });

  test('refuses an acceptance by an employee whose offer it is not', async () => {
    const detail = await jsonOf<{ offers: Array<{ offerId: string; employeeId: string }> }>(
      await call(harness.app, `/shifts/${shiftId}/offers`, { headers: managerHeaders }),
    );
    const bestFitOffer = detail.offers.find((row) => row.employeeId === employees.bestFit.id);
    expect(bestFitOffer).toBeDefined();

    const response = await call(harness.app, `/shifts/${shiftId}/acceptance`, {
      method: 'POST',
      headers: actorHeadersOf(demo.manager, employees.outgoing.id),
      body: { employeeId: employees.outgoing.id, offerId: bestFitOffer?.offerId },
    });
    expect(response.status).toBe(403);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('refuses an expired offer', async () => {
    await seedShift(harness.sql, {
      id: '22222222-2222-4222-8222-000000000401',
      startsAt: new Date(Date.now() + 36 * 3_600_000),
      endsAt: new Date(Date.now() + 44 * 3_600_000),
    });
    const offers = await call(harness.app, '/shifts/22222222-2222-4222-8222-000000000401/offers', {
      method: 'POST',
      headers: { ...offerHeaders, 'idempotency-key': `${key}:expired` },
      body: {
        employeeIds: [employees.expensive.id],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        reason: 'Coverage rescue',
      },
    });
    const detail = await jsonOf<{ offers: Array<{ offerId: string }> }>(offers);
    const expired = detail.offers[0];

    const response = await call(harness.app, '/shifts/22222222-2222-4222-8222-000000000401/acceptance', {
      method: 'POST',
      headers: actorHeadersOf(demo.manager, employees.expensive.id),
      body: { employeeId: employees.expensive.id, offerId: expired?.offerId },
    });
    expect(response.status).toBe(409);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('PRECONDITION_FAILED');
  });
});
