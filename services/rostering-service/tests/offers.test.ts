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
const shiftId = '22222222-2222-4222-8222-000000000200';
const idempotencyKey = 'run:99999999:step:send_offers';

const offerBody = () => ({
  employeeIds: [employees.bestFit.id, employees.expensive.id],
  expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  reason: 'Coverage rescue for cancelled shift',
});

const offerHeaders = () => ({ ...managerHeaders, 'idempotency-key': idempotencyKey });

beforeAll(async () => {
  harness = await createRosteringHarness('offers');
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

describe('POST /shifts/:shiftId/offers', () => {
  test('sends offers, marks the shift offered, and emits one offers_sent event', async () => {
    const response = await call(harness.app, `/shifts/${shiftId}/offers`, {
      method: 'POST',
      headers: offerHeaders(),
      body: offerBody(),
    });
    expect(response.status).toBe(200);
    const body = await jsonOf<{ shiftId: string; offers: Array<{ offerId: string; employeeId: string; status: string }> }>(response);
    expect(body.shiftId).toBe(shiftId);
    expect(body.offers.map((offer) => offer.employeeId).sort()).toEqual(
      [employees.bestFit.id, employees.expensive.id].sort(),
    );
    expect(body.offers.every((offer) => offer.status === 'sent')).toBe(true);

    const shift = await jsonOf<{ status: string }>(
      await call(harness.app, `/shifts/${shiftId}`, { headers: managerHeaders }),
    );
    expect(shift.status).toBe('offered');

    const detail = await jsonOf<{ offers: Array<{ employeeId: string; expiresAt: string; status: string }> }>(
      await call(harness.app, `/shifts/${shiftId}/offers`, { headers: managerHeaders }),
    );
    expect(detail.offers).toHaveLength(2);
    expect(detail.offers.every((offer) => offer.status === 'sent')).toBe(true);

    const events = await outboxEvents(harness.sql, 'shift.offers_sent');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload.payload;
    expect(payload?.['shiftId']).toBe(shiftId);
    expect((payload?.['employeeIds'] as string[]).sort()).toEqual(
      [employees.bestFit.id, employees.expensive.id].sort(),
    );
  });

  test('replays the stored response for a repeat with the same key and body', async () => {
    const first = await jsonOf<Record<string, unknown>>(
      await call(harness.app, `/shifts/${shiftId}/offers`, {
        method: 'POST',
        headers: offerHeaders(),
        body: offerBody(),
      }),
    );
    const repeat = await jsonOf<Record<string, unknown>>(
      await call(harness.app, `/shifts/${shiftId}/offers`, {
        method: 'POST',
        headers: offerHeaders(),
        body: offerBody(),
      }),
    );
    expect(repeat).toEqual(first);

    const offerRows = await harness.sql`SELECT count(*)::int AS count FROM shift_offers WHERE shift_id = ${shiftId}`;
    expect(offerRows[0]?.count).toBe(2);
    const events = await outboxEvents(harness.sql, 'shift.offers_sent');
    expect(events).toHaveLength(1);
  });

  test('rejects a repeat with the same key but a different body', async () => {
    const response = await call(harness.app, `/shifts/${shiftId}/offers`, {
      method: 'POST',
      headers: offerHeaders(),
      body: { ...offerBody(), employeeIds: [employees.unqualified.id] },
    });
    expect(response.status).toBe(409);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });

  test('rejects a request without an Idempotency-Key', async () => {
    const response = await call(harness.app, `/shifts/${shiftId}/offers`, {
      method: 'POST',
      headers: { ...managerHeaders },
      body: offerBody(),
    });
    expect(response.status).toBe(400);
    const body = await jsonOf<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
