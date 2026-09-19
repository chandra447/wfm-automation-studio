import { z } from 'zod';
import type { WorkflowDefinition } from '../dsl.ts';
import type { CanvasLayout } from './layout.ts';

/**
 * The two workflows seeded for the demo. They are ordinary definitions: the
 * canvas loads them as templates, the API stores them, and the engine compiles
 * them exactly like anything a user draws.
 */

export const coverageRescueWorkflow: WorkflowDefinition = {
  name: 'Rescue a cancelled shift',
  description:
    'When an employee calls in sick inside the 12 hour window, rank eligible staff and get a manager decision before offering the shift.',
  enabled: true,
  nodes: [
    {
      id: 'when_shift_cancelled',
      type: 'trigger',
      label: 'When a shift is cancelled',
      config: {
        eventType: 'shift.cancelled',
        conditions: [{ field: 'payload.hoursUntilStart', op: 'lt', value: 12 }],
      },
    },
    {
      id: 'rank_candidates',
      type: 'ai_decision',
      label: 'Rank eligible employees',
      config: {
        goal: 'Choose the employees to offer this shift to. Prefer qualified staff who meet the rest rule, then lowest cost. Explain the trade-off you accepted.',
        tools: ['shift.get', 'shift.candidates'],
        output: 'candidate_choice',
        mustCiteEvidence: true,
      },
    },
    {
      id: 'coverage_policy',
      type: 'policy_check',
      label: 'Coverage policy',
      config: {
        checks: ['rest_rule', 'availability', 'cost_delta_cap'],
        costCapCents: 12000,
        escalateOnFailure: true,
      },
    },
    {
      id: 'manager_approval',
      type: 'human_approval',
      label: 'Roster manager decision',
      config: {
        role: 'roster_manager',
        timeoutMinutes: 240,
        escalateTo: 'operations_lead',
        show: ['rationale', 'evidence', 'payImpact', 'candidateComparison'],
      },
    },
    {
      id: 'operations_approval',
      type: 'human_approval',
      label: 'Operations lead decision',
      config: {
        role: 'operations_lead',
        timeoutMinutes: 60,
        escalateTo: 'people_ops',
        show: ['rationale', 'evidence', 'payImpact'],
      },
    },
    {
      id: 'send_offers',
      type: 'action',
      label: 'Offer the shift',
      config: {
        command: 'rostering.send_offers',
        input: {
          shiftId: '{{input.payload.shiftId}}',
          employeeIds: '{{nodes.rank_candidates.output.employeeIds}}',
          expiresAt: '{{now+4h}}',
          reason: 'Coverage rescue for a cancelled shift',
        },
      },
    },
    { id: 'filled_end', type: 'end', label: 'Offers sent', config: { outcome: 'completed' } },
    { id: 'stopped_end', type: 'end', label: 'Left for manual cover', config: { outcome: 'needs_attention' } },
  ],
  edges: [
    { from: 'when_shift_cancelled', to: 'rank_candidates', port: 'always' },
    { from: 'rank_candidates', to: 'coverage_policy', port: 'always' },
    { from: 'coverage_policy', to: 'manager_approval', port: 'passed' },
    { from: 'coverage_policy', to: 'operations_approval', port: 'failed' },
    { from: 'manager_approval', to: 'send_offers', port: 'approved' },
    { from: 'manager_approval', to: 'stopped_end', port: 'rejected' },
    { from: 'operations_approval', to: 'send_offers', port: 'approved' },
    { from: 'operations_approval', to: 'stopped_end', port: 'rejected' },
    { from: 'send_offers', to: 'filled_end', port: 'always' },
  ],
};

export const coverageRescueLayout: CanvasLayout = {
  viewport: { x: 0, y: 0, zoom: 0.85 },
  positions: {
    when_shift_cancelled: { x: 0, y: 160 },
    rank_candidates: { x: 300, y: 160 },
    coverage_policy: { x: 600, y: 160 },
    manager_approval: { x: 900, y: 40 },
    operations_approval: { x: 900, y: 300 },
    send_offers: { x: 1200, y: 160 },
    filled_end: { x: 1500, y: 160 },
    stopped_end: { x: 1200, y: 420 },
  },
};

export const payrollExceptionWorkflow: WorkflowDefinition = {
  name: 'Resolve a pay-affecting timesheet exception',
  description:
    'When a missed break or overtime exception is raised, draft the award-correct adjustment, check it against the award, and wait for People Ops before anything touches pay.',
  enabled: true,
  nodes: [
    {
      id: 'when_exception_raised',
      type: 'trigger',
      label: 'When an exception is raised',
      config: {
        eventType: 'timesheet.exception_raised',
        conditions: [{ field: 'payload.exceptionType', op: 'in', value: ['missed_break', 'overtime'] }],
      },
    },
    {
      id: 'draft_adjustment',
      type: 'ai_decision',
      label: 'Draft the award adjustment',
      config: {
        goal: 'Compare the recorded work against the award rule and draft the adjustment the employee is entitled to. State which rule you applied and the pay impact.',
        tools: ['timesheet.get', 'award_rule.get'],
        output: 'timesheet_adjustment',
        mustCiteEvidence: true,
      },
    },
    {
      id: 'award_check',
      type: 'policy_check',
      label: 'Award check',
      config: {
        checks: ['award_validity', 'overtime_risk'],
        costCapCents: 0,
        escalateOnFailure: false,
      },
    },
    {
      id: 'people_ops_approval',
      type: 'human_approval',
      label: 'People Ops decision',
      config: {
        role: 'people_ops',
        timeoutMinutes: 480,
        escalateTo: 'people_ops_lead',
        show: ['rationale', 'evidence', 'payImpact'],
      },
    },
    {
      id: 'apply_adjustment',
      type: 'action',
      label: 'Apply the adjustment',
      config: {
        command: 'time_attendance.apply_adjustment',
        input: {
          timesheetId: '{{input.payload.timesheetId}}',
          unpaidBreakMinutesDelta: '{{nodes.draft_adjustment.output.unpaidBreakMinutesDelta}}',
          overtimeMinutesDelta: '{{nodes.draft_adjustment.output.overtimeMinutesDelta}}',
          reason: 'Award-corrected break and overtime after exception review',
        },
      },
    },
    { id: 'resolved_end', type: 'end', label: 'Timesheet corrected', config: { outcome: 'completed' } },
    { id: 'manual_end', type: 'end', label: 'Left for manual review', config: { outcome: 'needs_attention' } },
  ],
  edges: [
    { from: 'when_exception_raised', to: 'draft_adjustment', port: 'always' },
    { from: 'draft_adjustment', to: 'award_check', port: 'always' },
    { from: 'award_check', to: 'people_ops_approval', port: 'passed' },
    { from: 'award_check', to: 'manual_end', port: 'failed' },
    { from: 'people_ops_approval', to: 'apply_adjustment', port: 'approved' },
    { from: 'people_ops_approval', to: 'manual_end', port: 'rejected' },
    { from: 'apply_adjustment', to: 'resolved_end', port: 'always' },
  ],
};

export const payrollExceptionLayout: CanvasLayout = {
  viewport: { x: 0, y: 0, zoom: 0.9 },
  positions: {
    when_exception_raised: { x: 0, y: 160 },
    draft_adjustment: { x: 300, y: 160 },
    award_check: { x: 600, y: 160 },
    people_ops_approval: { x: 900, y: 160 },
    apply_adjustment: { x: 1200, y: 160 },
    resolved_end: { x: 1500, y: 160 },
    manual_end: { x: 1200, y: 400 },
  },
};

export const demoWorkflows = [
  { definition: coverageRescueWorkflow, layout: coverageRescueLayout },
  { definition: payrollExceptionWorkflow, layout: payrollExceptionLayout },
] as const;

/** Shapes produced by ai_decision nodes. Engine executors and the UI both read these. */
export const candidateChoiceOutputSchema = z.object({
  employeeIds: z.array(z.uuid()).min(1),
  topCandidateId: z.uuid(),
  costDeltaCents: z.int(),
  rationale: z.string().min(1),
  evidence: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(1),
});

export const timesheetAdjustmentOutputSchema = z.object({
  unpaidBreakMinutesDelta: z.int(),
  overtimeMinutesDelta: z.int(),
  payImpactCents: z.int(),
  awardRuleCode: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(1),
});

export type CandidateChoiceOutput = z.infer<typeof candidateChoiceOutputSchema>;
export type TimesheetAdjustmentOutput = z.infer<typeof timesheetAdjustmentOutputSchema>;
