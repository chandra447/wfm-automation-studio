import { candidateListSchema, shiftSchema, timesheetDetailResponseSchema, type AnyWfmEvent } from '@wfm/contracts';
import type { z } from 'zod';
import { policyCheckLabels, type WorkflowNode } from '@wfm/workflows';
import { appendAudit, appendRunEvent } from '../run-store.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';
import { coveragePlanOutputSchema } from './proposers.ts';
import { candidateChoiceOutputSchema, timesheetAdjustmentOutputSchema } from '@wfm/workflows';

export interface PolicyCheckResult {
  kind: string;
  passed: boolean;
  detail: string;
}

export interface PolicyCheckOutput {
  outcome: 'passed' | 'failed';
  checks: PolicyCheckResult[];
}

type CandidateList = z.infer<typeof candidateListSchema>;
type Shift = z.infer<typeof shiftSchema>;
type TimesheetDetail = z.infer<typeof timesheetDetailResponseSchema>;

function policyLabel(kind: string): string {
  const labels: Record<string, string> = policyCheckLabels;
  return labels[kind] ?? kind;
}

interface CheckInputs {
  chosen: string[];
  chosenState: RunStateFields;
  costDeltaCents: number | null;
  capCents: number;
  candidates: CandidateList | null;
  shift: Shift | null;
  timesheet: TimesheetDetail | null;
}

/**
 * Deterministic guardrails evaluated before anything else acts (design §7.3).
 * The model is never consulted here: each check is a pure function over the
 * proposal and the current state re-read from the domain services.
 */
export async function runPolicyNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (node.type !== 'policy_check') throw new Error(`${node.type} executor reached with a ${node.type} node`);
  const chosen = chosenEmployeeIds(state);
  const costDeltaCents = proposalCostDelta(state);

  const shiftId = eventShiftId(state.event);
  const candidates = shiftId
    ? await fetchCandidates(deps, scope, shiftId, state.event)
    : null;
  const shift = shiftId ? await fetchShift(deps, scope, shiftId) : null;
  const timesheet = await fetchTimesheet(deps, scope, state.event);

  const results: PolicyCheckResult[] = [];
  for (const kind of node.config.checks) {
    const result = evaluateCheck(kind, {
      chosen,
      chosenState: state,
      costDeltaCents,
      capCents: node.config.costCapCents,
      candidates,
      shift,
      timesheet,
    });
    results.push(result);
  }

  const failed = results.some((result) => !result.passed);
  const outcome: PolicyCheckOutput['outcome'] = failed ? 'failed' : 'passed';
  const summary =
    `${node.label}: ${outcome} — ` +
    results
      .map((result) => `${policyLabel(result.kind)}: ${result.passed ? 'ok' : 'FAILED'}`)
      .join('; ');

  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'policy_check.evaluate',
    actor: 'system',
    detail: { checks: results, outcome, costCapCents: node.config.costCapCents },
  });
  await appendRunEvent(deps.db, {
    runId: scope.runId,
    kind: 'policy_evaluated',
    nodeId: node.id,
    title: `${node.label}: ${outcome}`,
    detail: summary,
    data: { outcome, checks: results },
  });
  return {
    nodes: { [node.id]: { output: { outcome, checks: results }, summary } },
    cursor: node.id,
    decision: { nodeId: node.id, port: outcome },
  };
}

function evaluateCheck(kind: string, input: CheckInputs): PolicyCheckResult {
  switch (kind) {
    case 'rest_rule':
      return restRuleCheck(input);
    case 'availability':
      return availabilityCheck(input);
    case 'cost_delta_cap':
      return costDeltaCapCheck(input);
    case 'award_validity':
      return awardValidityCheck(input);
    case 'overtime_risk':
      return overtimeRiskCheck(input);
    default:
      return { kind, passed: false, detail: `unknown policy check kind "${kind}"` };
  }
}

function restRuleCheck(input: CheckInputs): PolicyCheckResult {
  const { candidates } = input;
  if (candidates === null) {
    return { kind: 'rest_rule', passed: false, detail: 'rest_rule needs a candidate list; none was resolved' };
  }
  const chosen = input.chosen.length > 0 ? input.chosen : candidates.candidates.map((candidate) => candidate.employeeId);
  const offending = candidates.candidates.filter(
    (candidate) => chosen.includes(candidate.employeeId) && !candidate.meetsRestRule,
  );
  return {
    kind: 'rest_rule',
    passed: offending.length === 0,
    detail:
      offending.length === 0
        ? 'every chosen employee meets the minimum rest rule'
        : `below minimum rest: ${offending.map((candidate) => `${candidate.employeeName} (${candidate.restHoursBeforeShift}h)`).join(', ')}`,
  };
}

/**
 * Availability is proven by membership in the rostering service's eligible
 * candidate list — the rostering service already applies approved leave and
 * availability windows when ranking candidates.
 */
function availabilityCheck(input: CheckInputs): PolicyCheckResult {
  const { candidates } = input;
  if (candidates === null) {
    return { kind: 'availability', passed: false, detail: 'availability needs a candidate list; none was resolved' };
  }
  if (input.chosen.length === 0) {
    return { kind: 'availability', passed: false, detail: 'no employee was chosen for the availability check' };
  }
  const eligible = new Set(candidates.candidates.map((candidate) => candidate.employeeId));
  const offending = input.chosen.filter((employeeId) => !eligible.has(employeeId));
  return {
    kind: 'availability',
    passed: offending.length === 0,
    detail:
      offending.length === 0
        ? 'all chosen employees are in the rostering eligible set'
        : `not available per rostering: ${offending.join(', ')}`,
  };
}

function costDeltaCapCheck(input: CheckInputs): PolicyCheckResult {
  if (input.capCents <= 0) {
    return { kind: 'cost_delta_cap', passed: true, detail: 'no cost delta cap configured (0 disables the check)' };
  }
  if (input.costDeltaCents === null) {
    return { kind: 'cost_delta_cap', passed: false, detail: 'cost delta cap requires a proposal with a cost delta' };
  }
  const withinCap = input.costDeltaCents <= input.capCents;
  return {
    kind: 'cost_delta_cap',
    passed: withinCap,
    detail: withinCap
      ? `cost delta ${input.costDeltaCents}c within cap ${input.capCents}c`
      : `cost delta ${input.costDeltaCents}c exceeds cap ${input.capCents}c`,
  };
}

function awardValidityCheck(input: CheckInputs): PolicyCheckResult {
  const { timesheet } = input;
  if (timesheet === null) {
    return { kind: 'award_validity', passed: false, detail: 'award_validity needs a timesheet; none was resolved' };
  }
  const proposal = findTimesheetAdjustmentProposal(input.chosenState);
  if (proposal === null) {
    return { kind: 'award_validity', passed: false, detail: 'award_validity needs a proposed adjustment; none was resolved' };
  }
  const { timesheet: sheet, awardRule } = timesheet;
  const unpaidBreakTaken = sheet.breaks
    .filter((breakRecord) => breakRecord.type === 'unpaid')
    .reduce((total, breakRecord) => total + breakRecord.minutes, 0);
  const shortfall = Math.max(0, awardRule.unpaidBreakMinutes - unpaidBreakTaken);

  const breakCovered = proposal.unpaidBreakMinutesDelta >= shortfall;
  const overtimeReduced = proposal.overtimeMinutesDelta <= 0;
  const passed = breakCovered && overtimeReduced;
  return {
    kind: 'award_validity',
    passed,
    detail:
      `proposed break delta ${proposal.unpaidBreakMinutesDelta}m vs award shortfall ${shortfall}m ` +
      `(${awardRule.ruleCode}); proposed overtime delta ${proposal.overtimeMinutesDelta}m — ` +
      (passed ? 'award-consistent' : 'award breach'),
  };
}

function overtimeRiskCheck(input: CheckInputs): PolicyCheckResult {
  if (input.timesheet !== null) {
    const proposal = findTimesheetAdjustmentProposal(input.chosenState);
    if (proposal === null) {
      return { kind: 'overtime_risk', passed: false, detail: 'overtime_risk needs a proposed adjustment; none was resolved' };
    }
    const passed = proposal.overtimeMinutesDelta <= 0;
    return {
      kind: 'overtime_risk',
      passed,
      detail: passed
        ? `proposed adjustment does not increase overtime (delta ${proposal.overtimeMinutesDelta}m)`
        : `proposed adjustment would add ${proposal.overtimeMinutesDelta}m of overtime`,
    };
  }
  const { candidates } = input;
  if (candidates === null) {
    return { kind: 'overtime_risk', passed: false, detail: 'overtime_risk needs a candidate list; none was resolved' };
  }
  const chosen = input.chosen.length > 0 ? input.chosen : candidates.candidates.map((candidate) => candidate.employeeId);
  const offending = candidates.candidates.filter(
    (candidate) => chosen.includes(candidate.employeeId) && candidate.overtimeRisk === 'high',
  );
  return {
    kind: 'overtime_risk',
    passed: offending.length === 0,
    detail:
      offending.length === 0
        ? 'no chosen employee carries a high overtime risk'
        : `high overtime risk: ${offending.map((candidate) => candidate.employeeName).join(', ')}`,
  };
}

function chosenEmployeeIds(state: RunStateFields): string[] {
  for (const value of Object.values(state.nodes)) {
    if (isProposalWithEmployees(value?.output)) return value.output.employeeIds;
  }
  return [];
}

interface EmployeeProposal {
  employeeIds: string[];
  topCandidateId: string;
  costDeltaCents: number;
}

function findTimesheetAdjustmentProposal(state: RunStateFields): z.infer<typeof timesheetAdjustmentOutputSchema> | null {
  for (const value of Object.values(state.nodes)) {
    const parsed = timesheetAdjustmentOutputSchema.safeParse(value?.output);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function isProposalWithEmployees(value: unknown): value is EmployeeProposal {
  if (candidateChoiceOutputSchema.safeParse(value).success) return true;
  return coveragePlanOutputSchema.safeParse(value).success;
}

function proposalCostDelta(state: RunStateFields): number | null {
  for (const value of Object.values(state.nodes)) {
    if (isProposalWithEmployees(value?.output)) return value.output.costDeltaCents;
  }
  return null;
}

function eventShiftId(event: AnyWfmEvent): string | null {
  if ('shiftId' in event.payload && typeof event.payload.shiftId === 'string') return event.payload.shiftId;
  return event.aggregate.type === 'shift' ? event.aggregate.id : null;
}

async function fetchCandidates(
  deps: ExecutorDeps,
  scope: RunScope,
  shiftId: string,
  event: AnyWfmEvent,
): Promise<CandidateList | null> {
  try {
    const exclusions =
      'cancelledByEmployeeId' in event.payload && typeof event.payload.cancelledByEmployeeId === 'string'
        ? [event.payload.cancelledByEmployeeId]
        : [];
    return await deps.clients.rostering.listCandidates(scope.tenantId, shiftId, {
      ...(exclusions.length > 0 ? { excludeEmployeeIds: exclusions } : {}),
    });
  } catch (error) {
    deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, error: String(error) }, 'candidate fetch failed');
    return null;
  }
}

async function fetchShift(deps: ExecutorDeps, scope: RunScope, shiftId: string): Promise<Shift | null> {
  try {
    return await deps.clients.rostering.getShift(scope.tenantId, shiftId);
  } catch (error) {
    deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, error: String(error) }, 'shift fetch failed');
    return null;
  }
}

async function fetchTimesheet(
  deps: ExecutorDeps,
  scope: RunScope,
  event: AnyWfmEvent,
): Promise<TimesheetDetail | null> {
  const timesheetId =
    'timesheetId' in event.payload && typeof event.payload.timesheetId === 'string'
      ? event.payload.timesheetId
      : event.aggregate.type === 'timesheet'
      ? event.aggregate.id
      : null;
  if (timesheetId === null) return null;
  try {
    return await deps.clients.attendance.getTimesheet(scope.tenantId, timesheetId);
  } catch (error) {
    deps.logger.warn({ tenantId: scope.tenantId, runId: scope.runId, error: String(error) }, 'timesheet fetch failed');
    return null;
  }
}
