import { describe, expect, test } from 'bun:test';
import {
  candidateChoiceOutputSchema,
  timesheetAdjustmentOutputSchema,
  type AiDecisionNode,
} from '@wfm/workflows';
import type { AnyWfmEvent } from '@wfm/contracts';
import { RulesProposer } from '../src/engine/nodes/proposers.ts';
import {
  BEST_FIT_ID,
  candidatesFixture,
  SHIFT_ID,
  stubDomainClients,
  TENANT,
  TIMESHEET_ID,
  timesheetFixture,
} from './helpers.ts';

const proposer = new RulesProposer();

const candidateNode: AiDecisionNode = {
  id: 'rank_candidates',
  type: 'ai_decision',
  label: 'Rank eligible employees',
  config: {
    goal: 'Choose the employees to offer this shift to.',
    tools: ['shift.get', 'shift.candidates'],
    output: 'candidate_choice',
    mustCiteEvidence: true,
  },
};

const adjustmentNode: AiDecisionNode = {
  id: 'draft_adjustment',
  type: 'ai_decision',
  label: 'Draft the award adjustment',
  config: {
    goal: 'Draft the award-correct adjustment for the exception.',
    tools: ['timesheet.get', 'award_rule.get'],
    output: 'timesheet_adjustment',
    mustCiteEvidence: true,
  },
};

const cancelledEvent: AnyWfmEvent = {
  eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000090',
  eventType: 'shift.cancelled',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  tenantId: TENANT,
  aggregate: { type: 'shift', id: SHIFT_ID },
  actor: null,
  correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000090',
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

const exceptionEvent: AnyWfmEvent = {
  eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000091',
  eventType: 'timesheet.exception_raised',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  tenantId: TENANT,
  aggregate: { type: 'timesheet', id: TIMESHEET_ID },
  actor: null,
  correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000091',
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

const clients = stubDomainClients();

async function candidatesData(): Promise<Record<string, unknown>> {
  return {
    'shift.get': await clients.rostering.getShift(TENANT, SHIFT_ID),
    'shift.candidates': await clients.rostering.listCandidates(TENANT, SHIFT_ID),
  };
}

const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('rules proposer', () => {
  test('candidate choice output is schema-valid and excludes ineligible employees', async () => {
    const result = await proposer.propose({
      runId: RUN_ID,
      node: candidateNode,
      event: cancelledEvent,
      data: await candidatesData(),
      steering: [],
    });
    expect(result.proposer).toBe('rules');
    const output = candidateChoiceOutputSchema.parse(result.output);
    expect(output.employeeIds).toContain(BEST_FIT_ID);
    expect(output.employeeIds).toHaveLength(1);
    expect(output.topCandidateId).toBe(BEST_FIT_ID);
    expect(output.costDeltaCents).toBe(5_000);
    expect(output.evidence.length).toBeGreaterThan(0);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  test('timesheet adjustment output is schema-valid and award-consistent', async () => {
    const result = await proposer.propose({
      runId: RUN_ID,
      node: adjustmentNode,
      event: exceptionEvent,
      data: { 'timesheet.get': timesheetFixture },
      steering: [],
    });
    expect(result.proposer).toBe('rules');
    const output = timesheetAdjustmentOutputSchema.parse(result.output);
    expect(output.unpaidBreakMinutesDelta).toBe(30);
    expect(output.overtimeMinutesDelta).toBeLessThanOrEqual(0);
    expect(output.awardRuleCode).toBe('MA000034');
    expect(output.payImpactCents).toBeLessThan(0);
    expect(output.evidence.length).toBeGreaterThan(0);
  });

  test('refuses to propose when no eligible candidate exists', async () => {
    const ineligibleOnly = {
      ...candidatesFixture,
      candidates: candidatesFixture.candidates.filter(
        (candidate) => candidate.employeeId !== BEST_FIT_ID,
      ),
    };
    const data = {
      'shift.get': await clients.rostering.getShift(TENANT, SHIFT_ID),
      'shift.candidates': ineligibleOnly,
    };
    await proposer
      .propose({ runId: RUN_ID, node: candidateNode, event: cancelledEvent, data, steering: [] })
      .then(
        () => {
          throw new Error('proposer should have refused');
        },
        (error: unknown) => {
          expect(String(error)).toContain('no eligible candidate');
        },
      );
  });
});
