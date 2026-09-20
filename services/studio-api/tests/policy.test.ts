import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AnyWfmEvent } from '@wfm/contracts';
import { candidateChoiceOutputSchema, coverageRescueWorkflow, type PolicyCheckNode } from '@wfm/workflows';
import { runPolicyNode, type PolicyCheckOutput } from '../src/engine/nodes/policy.ts';
import type { RunStateFields } from '../src/engine/state.ts';
import type { ExecutorDeps } from '../src/engine/nodes/context.ts';
import type { DomainClients } from '../src/engine/domain-clients.ts';
import { createLogger as createPinoLogger } from '@wfm/observability';
import type { Logger } from 'pino';
import { BEST_FIT_ID, candidatesFixture, createHarness, EXPENSIVE_ID, SHIFT_ID, stubDomainClients, TENANT, TIMESHEET_ID } from './helpers.ts';
import type { Harness } from './helpers.ts';

let harness: Harness;

function shiftEvent(): AnyWfmEvent {
  return {
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000099',
    eventType: 'shift.cancelled',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: TENANT,
    aggregate: { type: 'shift', id: SHIFT_ID },
    actor: null,
    correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000099',
    causationId: null,
    traceparent: null,
    payload: {
      shiftId: SHIFT_ID,
      locationId: '33333333-3333-4333-8333-000000000001',
      startsAt: '2026-09-21T04:00:00.000Z',
      hoursUntilStart: 7.5,
      reason: 'test',
      cancelledByEmployeeId: null,
      requiredQualificationCodes: ['RN'],
      roleName: 'Registered Nurse',
    },
  };
}

function timesheetEvent(): AnyWfmEvent {
  return {
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000098',
    eventType: 'timesheet.exception_raised',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: TENANT,
    aggregate: { type: 'timesheet', id: TIMESHEET_ID },
    actor: null,
    correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000098',
    causationId: null,
    traceparent: null,
    payload: {
      timesheetId: TIMESHEET_ID,
      employeeId: BEST_FIT_ID,
      shiftId: null,
      exceptionType: 'missed_break',
      awardRuleCode: 'MA000034',
      detail: 'Unpaid 30 minute break not recorded',
      overtimeMinutes: 75,
      estimatedPayImpactCents: 8_240,
    },
  };
}

function policyNode(checks: PolicyCheckNode['config']['checks'], costCapCents = 0): PolicyCheckNode {
  return { id: 'policy', type: 'policy_check', label: 'Policy', config: { checks, costCapCents, escalateOnFailure: true } };
}

function candidateState(employeeIds: string[], costDeltaCents: number): RunStateFields {
  const output = candidateChoiceOutputSchema.parse({
    employeeIds,
    topCandidateId: employeeIds[0],
    costDeltaCents,
    rationale: 'test proposal',
    evidence: [{ label: 'test', value: 'proposal' }],
  });
  return {
    runId: crypto.randomUUID(),
    tenantId: TENANT,
    definition: coverageRescueWorkflow,
    event: shiftEvent(),
    nodes: { rank_candidates: { output, summary: 'test proposal' } },
    messages: [],
    cursor: 'rank_candidates',
    decision: null,
  };
}

function adjustmentState(unpaidBreakMinutesDelta: number, overtimeMinutesDelta: number): RunStateFields {
  return {
    runId: crypto.randomUUID(),
    tenantId: TENANT,
    definition: coverageRescueWorkflow,
    event: timesheetEvent(),
    nodes: {
      draft_adjustment: {
        output: {
          unpaidBreakMinutesDelta,
          overtimeMinutesDelta,
          payImpactCents: -11_200,
          awardRuleCode: 'MA000034',
          rationale: 'test adjustment',
          evidence: [{ label: 'award', value: 'MA000034' }],
        },
        summary: 'test adjustment',
      },
    },
    messages: [],
    cursor: 'draft_adjustment',
    decision: null,
  };
}

async function evaluate(node: PolicyCheckNode, state: RunStateFields): Promise<PolicyCheckOutput & { port: string }> {
  const deps: ExecutorDeps = {
    db: harness.db,
    bus: harness.bus,
    clients: stubs,
    queue: { enqueueRunStart: async () => {}, enqueueRunStep: async () => {}, scheduleApprovalTimeout: async () => {}, start: async () => {}, stop: async () => {} },
    proposer: harness.proposer,
    logger,
  };
  const scope = {
    runId: state.runId,
    tenantId: state.tenantId,
    workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099',
    workflowVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000098',
    workflowName: 'test',
    correlationId: state.runId,
    triggerEventId: state.event.eventId,
    dryRun: false,
  };
  const result = await runPolicyNode(scope, deps, node, state);
  const output = result.nodes['policy']?.output as PolicyCheckOutput;
  return { ...output, port: result.decision?.port ?? '' };
}

let stubs: DomainClients;
let logger: Logger;

beforeAll(async () => {
  harness = await createHarness();
  stubs = stubDomainClients();
  logger = createPinoLogger('policy-test', 'error');
});

afterAll(async () => {
  await harness.drop();
});

describe('policy checks', () => {
  test('rest_rule passes when every chosen employee meets the rest rule', async () => {
    const result = await evaluate(policyNode(['rest_rule']), candidateState([BEST_FIT_ID], 5_000));
    expect(result.outcome).toBe('passed');
    expect(result.checks[0]?.passed).toBe(true);
    expect(result.port).toBe('passed');
  });

  test('rest_rule fails for an employee below minimum rest', async () => {
    const belowRest = candidatesFixture.candidates.find((candidate) => !candidate.meetsRestRule);
    if (!belowRest) throw new Error('candidate fixture is missing a below-rest employee');
    const result = await evaluate(policyNode(['rest_rule']), candidateState([belowRest.employeeId], 5_000));
    expect(result.outcome).toBe('failed');
    expect(result.checks[0]?.detail).toContain('below minimum rest');
    expect(result.port).toBe('failed');
  });

  test('availability passes when chosen employees are in the eligible set', async () => {
    const result = await evaluate(policyNode(['availability']), candidateState([BEST_FIT_ID], 5_000));
    expect(result.outcome).toBe('passed');
  });

  test('availability fails for an employee the rostering service did not rank', async () => {
    const unknownEmployee = '44444444-4444-4444-8444-999999999999';
    const result = await evaluate(policyNode(['availability']), candidateState([BEST_FIT_ID, unknownEmployee], 5_000));
    expect(result.outcome).toBe('failed');
    expect(result.checks[0]?.detail).toContain('not available');
  });

  test('cost_delta_cap passes under the cap', async () => {
    const result = await evaluate(policyNode(['cost_delta_cap'], 12_000), candidateState([BEST_FIT_ID], 5_000));
    expect(result.outcome).toBe('passed');
  });

  test('cost_delta_cap fails above the cap', async () => {
    const result = await evaluate(policyNode(['cost_delta_cap'], 3_000), candidateState([BEST_FIT_ID], 5_000));
    expect(result.outcome).toBe('failed');
    expect(result.checks[0]?.detail).toContain('exceeds cap');
  });

  test('cost_delta_cap is disabled with a zero cap', async () => {
    const result = await evaluate(policyNode(['cost_delta_cap'], 0), candidateState([BEST_FIT_ID], 20_000));
    expect(result.outcome).toBe('passed');
  });

  test('award_validity passes when the adjustment covers the award shortfall', async () => {
    const result = await evaluate(policyNode(['award_validity']), adjustmentState(30, -75));
    expect(result.outcome).toBe('passed');
  });

  test('award_validity fails when the break delta does not cover the shortfall', async () => {
    const result = await evaluate(policyNode(['award_validity']), adjustmentState(0, -75));
    expect(result.outcome).toBe('failed');
    expect(result.checks[0]?.detail).toContain('award breach');
  });

  test('overtime_risk passes for a low-risk candidate', async () => {
    const result = await evaluate(policyNode(['overtime_risk']), candidateState([BEST_FIT_ID], 5_000));
    expect(result.outcome).toBe('passed');
  });

  test('overtime_risk fails for a high-risk candidate', async () => {
    const result = await evaluate(policyNode(['overtime_risk']), candidateState([EXPENSIVE_ID], 5_000));
    expect(result.outcome).toBe('failed');
    expect(result.checks[0]?.detail).toContain('high overtime risk');
  });

  test('overtime_risk passes when the adjustment reduces overtime and fails when it adds overtime', async () => {
    const reducing = await evaluate(policyNode(['overtime_risk']), adjustmentState(30, -75));
    expect(reducing.outcome).toBe('passed');
    const increasing = await evaluate(policyNode(['overtime_risk']), adjustmentState(30, 60));
    expect(increasing.outcome).toBe('failed');
    expect(increasing.checks[0]?.detail).toContain('would add');
  });
});
