/**
 * End-to-end proof for the two demo scenarios. Requires the stack from
 * `scripts/verify.sh` (services, engine, worker) and seeded demo data.
 *
 * Every assertion reads observable state: run rows, approval records, run
 * timeline events, and the domain services' own API responses.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Approval, RunDetail, RunSummary, SimulatorResponse, Timesheet, Shift } from '@wfm/contracts';
import { waitFor } from '@wfm/testkit';

const studioApi = process.env.STUDIO_API_BASE_URL ?? 'http://127.0.0.1:4103';
const rosteringApi = process.env.ROSTERING_BASE_URL ?? 'http://127.0.0.1:4101';
const attendanceApi = process.env.TIME_ATTENDANCE_BASE_URL ?? 'http://127.0.0.1:4102';
const tenantId = process.env.DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';

function headersFor(actor: 'manager' | 'people_ops' | 'employee' | 'operations_lead'): Record<string, string> {
  const actors = {
    manager: { userId: 'manager@demo.test', roles: ['roster_manager'] },
    operations_lead: { userId: 'ops.lead@demo.test', roles: ['operations_lead'] },
    people_ops: { userId: 'people-ops@demo.test', roles: ['people_ops'] },
    employee: { userId: 'marcus.webb@demo.test', roles: ['employee'], employeeId: '44444444-4444-4444-8444-000000000003' },
  } as const;
  const actor_ = actors[actor];
  return {
    'x-tenant-id': tenantId,
    'x-user-id': actor_.userId,
    'x-user-roles': actor_.roles.join(','),
    ...('employeeId' in actor_ ? { 'x-employee-id': actor_.employeeId } : {}),
    'content-type': 'application/json',
  };
}

async function call<T>(
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function runIds(): Promise<Set<string>> {
  const { body } = await call<RunSummary[]>(`${studioApi}/runs?limit=100`, { headers: headersFor('manager') });
  return new Set(body.map((run) => run.runId));
}

/** The run this test started, never one an earlier test left behind. */
async function runFor(triggerEventType: string, exclude: ReadonlySet<string>): Promise<RunSummary> {
  return waitFor<RunSummary>(
    async () => {
      const { body } = await call<RunSummary[]>(`${studioApi}/runs?limit=100`, { headers: headersFor('manager') });
      return body.find((run) => run.triggerEventType === triggerEventType && !exclude.has(run.runId));
    },
    { description: `a new run triggered by ${triggerEventType}`, timeoutMs: 30_000 },
  );
}

/**
 * A run that reaches an AI decision node calls the configured provider, and a
 * real vendor can take the better part of a minute on a large prompt, so this
 * waits well past the engine's own 90s model timeout.
 */
async function runUntil(runId: string, status: RunSummary['status']): Promise<RunDetail> {
  return waitFor<RunDetail>(
    async () => {
      const { body } = await call<RunDetail>(`${studioApi}/runs/${runId}`, { headers: headersFor('manager') });
      return body.run.status === status ? body : null;
    },
    { description: `run ${runId} to reach ${status}`, timeoutMs: 240_000 },
  );
}

/**
 * The suite pins the deterministic rules proposer rather than inheriting
 * whatever provider the demo was last left on. Against the real vendor the
 * ranking call in this scenario has taken 40 seconds on its own, which spends
 * the test's patience on the network instead of on the engine.
 */
beforeAll(async () => {
  const response = await call(`${studioApi}/provider-settings`, {
    method: 'PUT',
    headers: headersFor('manager'),
    body: { kind: 'none' },
  });
  expect(response.status).toBe(200);
});

describe('scenario A — coverage rescue', () => {
  let shiftId: string;
  let runId: string;

  test('a sick call starts a run that parks for a roster manager', async () => {
    const before = await runIds();
    const simulated = await call<SimulatorResponse>(`${studioApi}/simulator/coverage_rescue`, {
      method: 'POST',
      headers: headersFor('manager'),
    });
    expect(simulated.status).toBe(200);
    expect(simulated.body.emittedEvents).toContain('shift.cancelled');
    shiftId = simulated.body.shiftId!;

    const run = await runFor('shift.cancelled', before);
    runId = run.runId;
    expect(run.workflowName).toContain('cancelled shift');

    const parked = await runUntil(runId, 'awaiting_approval');
    expect(parked.approval?.status).toBe('pending');
    expect(parked.approval?.requestedFromRole).toBe('roster_manager');
    expect(parked.approval?.proposal.rationale.length).toBeGreaterThan(20);
    expect(parked.approval?.proposal.evidence.length).toBeGreaterThan(0);

    const kinds = parked.events.map((event) => event.kind);
    expect(kinds).toContain('policy_evaluated');
    expect(kinds).toContain('proposal_created');
    expect(kinds).toContain('approval_requested');
  }, 300_000);

  test('an employee without the role cannot approve', async () => {
    const parked = await runUntil(runId, 'awaiting_approval');
    const approvalId = parked.approval!.approvalId;
    const denied = await call<{ error: { code: string } }>(`${studioApi}/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: headersFor('employee'),
      body: { decision: 'approve', reason: 'I would like the shift' },
    });
    expect(denied.status).toBe(403);

    const still = await call<Approval[]>(`${studioApi}/approvals?status=pending`, { headers: headersFor('manager') });
    expect(still.body.some((approval) => approval.approvalId === approvalId)).toBe(true);
  }, 300_000);

  test('the manager approves and the engine offers the shift', async () => {
    const parked = await runUntil(runId, 'awaiting_approval');
    const approvalId = parked.approval!.approvalId;

    const decided = await call<{ runStatus: string }>(`${studioApi}/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: headersFor('manager'),
      body: { decision: 'approve', reason: 'Coverage needed for the morning medication round' },
    });
    expect(decided.status).toBe(200);

    const finished = await runUntil(runId, 'succeeded');
    const executed = finished.events.filter((event) => event.kind === 'action_executed');
    expect(executed.length).toBeGreaterThan(0);
    expect(executed[0]?.detail).toContain('offers');

    const offers = await call<{ shiftId: string; offers: Array<{ offerId: string; employeeId: string }> }>(
      `${rosteringApi}/shifts/${shiftId}/offers`,
      { headers: headersFor('manager') },
    );
    expect(offers.status).toBe(200);
    expect(offers.body.shiftId).toBe(shiftId);
    expect(offers.body.offers.length).toBeGreaterThan(0);
  }, 300_000);

  test('a rejection is recorded and no command is issued', async () => {
    const before = await runIds();
    const simulated = await call<SimulatorResponse>(`${studioApi}/simulator/coverage_rescue`, {
      method: 'POST',
      headers: headersFor('manager'),
    });
    expect(simulated.status).toBe(200);
    const rejectedShiftId = simulated.body.shiftId!;
    const offersBefore = await call<{ offers: unknown[] }>(`${rosteringApi}/shifts/${rejectedShiftId}/offers`, {
      headers: headersFor('manager'),
    });

    const run = await runFor('shift.cancelled', before);
    const parked = await runUntil(run.runId, 'awaiting_approval');

    const decided = await call<{ runStatus: string }>(`${studioApi}/approvals/${parked.approval!.approvalId}/decision`, {
      method: 'POST',
      headers: headersFor('manager'),
      body: { decision: 'reject', reason: 'Coverage found through the agency panel instead' },
    });
    expect(decided.status).toBe(200);

    const finished = await waitFor<RunDetail>(
      async () => {
        const { body } = await call<RunDetail>(`${studioApi}/runs/${run.runId}`, { headers: headersFor('manager') });
        return body.run.status === 'succeeded' ? body : null;
      },
      { description: 'the rejected run to finish', timeoutMs: 40_000 },
    );

    // The rejected path ends at the "needs attention" node, and nothing was written.
    expect(finished.run.summary).toContain('Left for manual cover');
    expect(finished.events.some((event) => event.kind === 'action_executed')).toBe(false);
    const decision = finished.events.find((event) => event.kind === 'approval_decided');
    expect(decision?.detail).toContain('agency panel');

    const offersAfter = await call<{ offers: unknown[] }>(`${rosteringApi}/shifts/${rejectedShiftId}/offers`, {
      headers: headersFor('manager'),
    });
    expect(offersAfter.body.offers.length).toBe(offersBefore.body.offers.length);
  }, 90_000);

  test('a replayed decision cannot apply the action twice', async () => {
    const finished = await runUntil(runId, 'succeeded');
    const approvalId = finished.approval!.approvalId;
    const offersBefore = await call<{ offers: unknown[] }>(`${rosteringApi}/shifts/${shiftId}/offers`, {
      headers: headersFor('manager'),
    });

    const replay = await call<unknown>(`${studioApi}/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: headersFor('manager'),
      body: { decision: 'approve', reason: 'approving again' },
    });
    expect([200, 409]).toContain(replay.status);

    const offersAfter = await call<{ offers: unknown[] }>(`${rosteringApi}/shifts/${shiftId}/offers`, {
      headers: headersFor('manager'),
    });
    expect(offersAfter.body.offers.length).toBe(offersBefore.body.offers.length);
  }, 300_000);
});

describe('scenario B — payroll-safe timesheet exception', () => {
  /**
   * The suite asserts a fixed outcome, so it runs the deterministic proposer.
   * The configured vendor is exercised by scripts/verify-features.sh, which
   * checks the proposal, the tokens, and the cost against the real provider.
   */
  test('a missed break is drafted, approved by People Ops, and applied once', async () => {
    const runsBefore = await runIds();
    const simulated = await call<SimulatorResponse>(`${studioApi}/simulator/payroll_exception`, {
      method: 'POST',
      headers: headersFor('manager'),
    });
    expect(simulated.status).toBe(200);
    expect(simulated.body.emittedEvents).toContain('attendance.missed_break');
    const timesheetId = simulated.body.timesheetId!;

    const before = await call<{ timesheet: Timesheet }>(`${attendanceApi}/timesheets/${timesheetId}`, {
      headers: headersFor('manager'),
    });
    expect(before.body.timesheet.exceptions.length).toBeGreaterThan(0);

    const run = await runFor('timesheet.exception_raised', runsBefore);
    const parked = await runUntil(run.runId, 'awaiting_approval');
    expect(parked.approval?.requestedFromRole).toBe('people_ops');
    expect(parked.approval?.proposal.payImpactCents).not.toBe(0);

    const decided = await call<unknown>(`${studioApi}/approvals/${parked.approval!.approvalId}/decision`, {
      method: 'POST',
      headers: headersFor('people_ops'),
      body: { decision: 'approve', reason: 'Award requires the break to be paid and overtime applied' },
    });
    expect(decided.status).toBe(200);

    await runUntil(run.runId, 'succeeded');

    const after = await call<{ timesheet: Timesheet }>(`${attendanceApi}/timesheets/${timesheetId}`, {
      headers: headersFor('manager'),
    });
    expect(after.body.timesheet.status).toBe('adjusted');
    expect(after.body.timesheet.totalPayCents).not.toBe(before.body.timesheet.totalPayCents);
  }, 300_000);
});

describe('platform behaviour visible end to end', () => {
  test('the trigger catalogue is served with schemas and samples', async () => {
    const { body } = await call<Array<{ eventType: string; jsonSchema: unknown; sample: unknown }>>(
      `${studioApi}/triggers`,
      { headers: headersFor('manager') },
    );
    expect(body.length).toBeGreaterThan(10);
    expect(body.some((trigger) => trigger.eventType === 'shift.cancelled')).toBe(true);
  });

  test('the rostering service exposes the shift the demo acts on', async () => {
    const shiftId = process.env.DEMO_SHIFT_ID ?? '22222222-2222-4222-8222-000000000003';
    const { status, body } = await call<Shift>(`${rosteringApi}/shifts/${shiftId}`, { headers: headersFor('manager') });
    expect(status).toBe(200);
    expect(body.tenantId).toBe(tenantId);
  });
});
