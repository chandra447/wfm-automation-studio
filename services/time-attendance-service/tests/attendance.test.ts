process.env.EVENT_BACKBONE = 'memory';
process.env.EVENT_STREAM_PREFIX = 'wfm.test.attendance';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  adjustmentResponseSchema,
  errorCodes,
  timesheetDetailResponseSchema,
  timesheetSchema,
} from '@wfm/contracts';
import type { AnyWfmEvent } from '@wfm/contracts';
import { InMemoryEventBus } from '@wfm/eventbus';
import { OutboxPublisher } from '@wfm/outbox';
import { actorHeaders, createTestDatabase, demo, type TestDatabase } from '@wfm/testkit';
import { app, setAttendanceService } from '../src/app.ts';
import { createDatabase } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { adjustments, awardRules, employees } from '../src/db/schema.ts';
import { createAttendanceService, type AttendanceService } from '../src/domain/attendance.ts';

const otherTenant = '99999999-9999-4999-8999-999999999999';

const clockResponseSchema = z.object({
  timesheet: timesheetSchema,
  emittedEvents: z.array(z.string().min(1)),
});
const noShowResponseSchema = z.object({ emittedEvents: z.array(z.string().min(1)) });
const approvalResponseSchema = z.object({ timesheet: timesheetSchema });

const awardRuleRow = {
  tenantId: demo.tenantId,
  ruleCode: demo.awardRuleCode,
  name: 'Aged Care Award 2010',
  maxOrdinaryMinutesPerDay: 480,
  overtimeMultiplier: '1.500',
  breakRequiredAfterMinutes: 300,
  unpaidBreakMinutes: 30,
  minimumRestHoursBetweenShifts: '10.00',
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
};

const marcus = {
  id: demo.employees.bestFit.id,
  tenantId: demo.tenantId,
  name: demo.employees.bestFit.name,
  hourlyRateCents: demo.employees.bestFit.hourlyRateCents,
  awardRuleCode: demo.awardRuleCode,
};

let testDb: TestDatabase;
let service: AttendanceService;
let database: ReturnType<typeof createDatabase>;
let bus: InMemoryEventBus;
let publisher: OutboxPublisher;

async function call(request: Request): Promise<{ status: number; body: unknown }> {
  const response = await app.handle(request);
  return { status: response.status, body: await response.json() };
}

function get(path: string, headers: Record<string, string>): Request {
  return new Request(`http://test${path}`, { headers });
}

function post(path: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`http://test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function clockIn(shiftId: string, periodStartIso: string): Promise<string> {
  const { status, body } = await call(
    post(`/shifts/${shiftId}/clock-in`, actorHeaders(demo.manager), {
      employeeId: marcus.id,
      at: periodStartIso,
    }),
  );
  expect(status).toBe(200);
  return clockResponseSchema.parse(body).timesheet.timesheetId;
}

async function clockOut(shiftId: string, at: string, breakMinutesTaken: number): Promise<ClockOutResult> {
  const { status, body } = await call(
    post(`/shifts/${shiftId}/clock-out`, actorHeaders(demo.manager), {
      employeeId: marcus.id,
      shiftId,
      at,
      breakMinutesTaken,
    }),
  );
  expect(status).toBe(200);
  const parsed = clockResponseSchema.parse(body);
  return { timesheetId: parsed.timesheet.timesheetId, emittedEvents: parsed.emittedEvents };
}

interface ClockOutResult {
  timesheetId: string;
  emittedEvents: string[];
}

function eventsOf(type: string): AnyWfmEvent[] {
  return bus.published(demo.tenantId).filter((event) => event.eventType === type);
}

const stranger: Record<string, string> = {
  'x-tenant-id': otherTenant,
  'x-user-id': 'intruder@other.test',
  'x-user-roles': 'manager',
  'content-type': 'application/json',
};

beforeAll(async () => {
  testDb = await createTestDatabase('postgres://wfm:wfm@127.0.0.1:5433', 'ta_attendance_test');
  await migrate(testDb.url);
  database = createDatabase(testDb.url);
  bus = new InMemoryEventBus();
  publisher = new OutboxPublisher({ sql: database.sql, bus, pollMs: 50 });
  service = createAttendanceService({ database });
  await publisher.start();
  setAttendanceService(service);

  await database.db.insert(awardRules).values(awardRuleRow);
  await database.db.insert(employees).values(marcus);
});

afterAll(async () => {
  setAttendanceService(null);
  await publisher.stop();
  await bus.close();
  await service.close();
  await testDb.drop();
});

describe('time-attendance service', () => {
  test('health responds', async () => {
    const { status, body } = await call(get('/health', {}));
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', service: 'time-attendance-service' });
  });

  test('clock-out with no break on a long shift raises missed break, overtime, and rule violation', async () => {
    const shiftId = crypto.randomUUID();
    const timesheetId = await clockIn(shiftId, '2026-09-18T06:00:00Z');

    const { emittedEvents } = await clockOut(shiftId, '2026-09-18T15:00:00Z', 0);
    expect(emittedEvents).toEqual([
      'attendance.clock_out_recorded',
      'attendance.missed_break',
      'timesheet.exception_raised',
      'award.rule_violation_detected',
      'timesheet.exception_raised',
    ]);

    await publisher.drain();

    const missed = eventsOf('attendance.missed_break').at(-1);
    expect(missed).toBeDefined();
    expect(missed!.payload).toEqual({
      employeeId: marcus.id,
      shiftId,
      timesheetId,
      workedMinutes: 540,
      requiredBreakMinutes: 300,
      breakMinutesTaken: 0,
    });

    const raised = eventsOf('timesheet.exception_raised');
    const missedBreakException = raised.find(
      (event) => 'exceptionType' in event.payload && event.payload.exceptionType === 'missed_break',
    );
    expect(missedBreakException).toBeDefined();
    expect(missedBreakException!.payload.estimatedPayImpactCents).toBe(3_200);
    const overtimeException = raised.find(
      (event) => 'exceptionType' in event.payload && event.payload.exceptionType === 'overtime',
    );
    expect(overtimeException).toBeDefined();
    expect(overtimeException!.payload.overtimeMinutes).toBe(60);
    expect(overtimeException!.payload.estimatedPayImpactCents).toBe(3_200);
    expect(eventsOf('award.rule_violation_detected')).toHaveLength(1);

    const detail = await call(get(`/timesheets/${timesheetId}`, actorHeaders(demo.manager)));
    expect(detail.status).toBe(200);
    const { timesheet, awardRule } = timesheetDetailResponseSchema.parse(detail.body);
    expect(awardRule.ruleCode).toBe(demo.awardRuleCode);
    expect(timesheet.status).toBe('submitted');
    expect(timesheet.workedMinutes).toBe(540);
    expect(timesheet.ordinaryMinutes).toBe(480);
    expect(timesheet.overtimeMinutes).toBe(60);
    expect(timesheet.paidMinutes).toBe(540);
    expect(timesheet.totalPayCents).toBe(60_800);
    expect(timesheet.exceptions.map((exception) => exception.type).sort()).toEqual([
      'missed_break',
      'overtime',
    ]);
    expect(timesheet.payLines.map((line) => line.payTypeCode).sort()).toEqual(['ORDINARY', 'OVERTIME']);
  });

  test('clock-out with the break taken raises no exception', async () => {
    const shiftId = crypto.randomUUID();
    const timesheetId = await clockIn(shiftId, '2026-09-18T06:00:00Z');

    const { emittedEvents } = await clockOut(shiftId, '2026-09-18T14:30:00Z', 30);
    expect(emittedEvents).toEqual(['attendance.clock_out_recorded']);
    expect(eventsOf('attendance.missed_break')).toHaveLength(0);
    expect(eventsOf('timesheet.exception_raised')).toHaveLength(0);

    const detail = await call(get(`/timesheets/${timesheetId}`, actorHeaders(demo.manager)));
    const { timesheet } = timesheetDetailResponseSchema.parse(detail.body);
    expect(timesheet.status).toBe('submitted');
    expect(timesheet.workedMinutes).toBe(480);
    expect(timesheet.totalPayCents).toBe(49_600);
    expect(timesheet.breaks).toHaveLength(1);
    expect(timesheet.breaks[0]).toMatchObject({ type: 'unpaid', minutes: 30, recordedBy: 'manager' });
  });

  test('adjustment is idempotent, records the approver, and adjusts the timesheet', async () => {
    const shiftId = crypto.randomUUID();
    const timesheetId = await clockIn(shiftId, '2026-09-18T06:00:00Z');
    await clockOut(shiftId, '2026-09-18T15:00:00Z', 0);

    const headers = { ...actorHeaders(demo.peopleOps), 'idempotency-key': 'adjust-0001' };
    const request = post(`/timesheets/${timesheetId}/adjustments`, headers, {
      reason: 'Worked through the unpaid break',
      unpaidBreakMinutesDelta: 30,
      overtimeMinutesDelta: 0,
    });

    const first = await call(request);
    expect(first.status).toBe(200);
    const applied = adjustmentResponseSchema.parse(first.body);
    expect(applied.payImpactCents).toBe(3_200);
    expect(applied.appliedBy).toBe(demo.peopleOps.userId);

    const second = await call(
      post(`/timesheets/${timesheetId}/adjustments`, headers, {
        reason: 'Worked through the unpaid break',
        unpaidBreakMinutesDelta: 30,
        overtimeMinutesDelta: 0,
      }),
    );
    expect(second.status).toBe(200);
    expect(adjustmentResponseSchema.parse(second.body).adjustmentId).toBe(applied.adjustmentId);

    const mismatch = await call(
      post(`/timesheets/${timesheetId}/adjustments`, headers, {
        reason: 'Different change',
        unpaidBreakMinutesDelta: 10,
        overtimeMinutesDelta: 0,
      }),
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ error: { code: errorCodes.idempotencyMismatch } });

    const [adjustmentRow] = await database.db
      .select()
      .from(adjustments)
      .where(eq(adjustments.timesheetId, timesheetId));
    expect(adjustmentRow).toBeDefined();
    expect(adjustmentRow!.approvedBy).toBe(demo.peopleOps.userId);
    expect(adjustmentRow!.payImpactCents).toBe(3_200);

    const detail = await call(get(`/timesheets/${timesheetId}`, actorHeaders(demo.manager)));
    const { timesheet } = timesheetDetailResponseSchema.parse(detail.body);
    expect(timesheet.status).toBe('adjusted');
    expect(timesheet.totalPayCents).toBe(60_800 + 3_200);

    const adjusted = eventsOf('timesheet.adjusted');
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0]!.payload).toMatchObject({
      timesheetId,
      adjustmentId: applied.adjustmentId,
      unpaidBreakMinutesDelta: 30,
      payImpactCents: 3_200,
      approvedBy: demo.peopleOps.userId,
    });
  });

  test('approval approves the timesheet and emits timesheet.submitted once', async () => {
    const shiftId = crypto.randomUUID();
    const timesheetId = await clockIn(shiftId, '2026-09-18T06:00:00Z');
    await clockOut(shiftId, '2026-09-18T14:30:00Z', 30);

    const approve = await call(
      post(
        `/timesheets/${timesheetId}/approval`,
        { ...actorHeaders(demo.manager), 'idempotency-key': 'approve-0001' },
        { decision: 'approve', reason: 'Payrun ready' },
      ),
    );
    expect(approve.status).toBe(200);
    expect(approvalResponseSchema.parse(approve.body).timesheet.status).toBe('approved');
    expect(eventsOf('timesheet.submitted')).toHaveLength(1);
    expect(eventsOf('timesheet.submitted')[0]!.payload).toMatchObject({ timesheetId, totalPayCents: 49_600 });

    const again = await call(
      post(
        `/timesheets/${timesheetId}/approval`,
        { ...actorHeaders(demo.manager), 'idempotency-key': 'approve-0002' },
        { decision: 'approve', reason: 'Payrun ready' },
      ),
    );
    expect(again.status).toBe(409);
    expect(eventsOf('timesheet.submitted')).toHaveLength(1);
  });

  test('no-show records an exception and emits attendance.no_show', async () => {
    const shiftId = crypto.randomUUID();
    const timesheetId = await clockIn(shiftId, '2026-09-18T06:00:00Z');

    const { status, body } = await call(
      post(
        `/timesheets/${timesheetId}/no-show`,
        actorHeaders(demo.manager),
        { shiftStartsAt: '2026-09-18T06:00:00Z', minutesLate: 45 },
      ),
    );
    expect(status).toBe(200);
    expect(noShowResponseSchema.parse(body).emittedEvents).toEqual(['attendance.no_show']);

    const emitted = eventsOf('attendance.no_show').at(-1);
    expect(emitted!.payload).toMatchObject({ employeeId: marcus.id, shiftId, minutesLate: 45 });

    const detail = await call(get(`/timesheets/${timesheetId}`, actorHeaders(demo.manager)));
    const { timesheet } = timesheetDetailResponseSchema.parse(detail.body);
    expect(timesheet.exceptions.some((exception) => exception.type === 'no_show')).toBe(true);
  });

  test('cross-tenant reads are refused', async () => {
    const shiftId = crypto.randomUUID();
    const timesheetId = await clockIn(shiftId, '2026-09-18T06:00:00Z');

    const detail = await call(get(`/timesheets/${timesheetId}`, stranger));
    expect(detail.status).toBe(404);
    expect(detail.body).toMatchObject({ error: { code: errorCodes.notFound } });

    const exceptions = await call(get(`/timesheets/${timesheetId}/exceptions`, stranger));
    expect(exceptions.status).toBe(404);

    const rule = await call(get(`/award-rules/${demo.awardRuleCode}`, stranger));
    expect(rule.status).toBe(404);

    const mutation = await call(
      post(
        `/timesheets/${timesheetId}/no-show`,
        stranger,
        { minutesLate: 0 },
      ),
    );
    expect(mutation.status).toBe(404);

    const own = await call(get(`/timesheets/${timesheetId}`, actorHeaders(demo.manager)));
    expect(own.status).toBe(200);
  });

  test('missing actor context is rejected', async () => {
    const response = await call(get('/timesheets/77777777-7777-4777-8777-000000000001', {}));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: errorCodes.invalidActorContext } });
  });
});
