import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from '../primitives.ts';

/**
 * Automation Studio DTOs. Workflow shapes live in @wfm/workflows (the DSL);
 * this file covers the trigger catalogue, runs, approvals, and the simulator.
 */

export const triggerDescriptorSchema = z.object({
  eventType: z.string().min(1),
  eventVersion: z.int().positive(),
  owner: z.enum(['rostering', 'time-attendance', 'studio']),
  summary: z.string().min(1),
  jsonSchema: z.unknown(),
  sample: z.unknown(),
});

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
]);

export const runSummarySchema = z.object({
  runId: uuidSchema,
  tenantId: uuidSchema,
  workflowId: uuidSchema,
  workflowName: z.string().min(1),
  workflowVersionNumber: z.int().positive(),
  triggerEventId: uuidSchema,
  triggerEventType: z.string().min(1),
  status: runStatusSchema,
  dryRun: z.boolean(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  actionsExecuted: z.int().nonnegative(),
  summary: z.string().nullable(),
  pendingApprovalId: uuidSchema.nullable(),
});

export const runEventKindSchema = z.enum([
  'event_received',
  'context_resolved',
  'policy_evaluated',
  'proposal_created',
  'approval_requested',
  'approval_decided',
  'action_executed',
  'run_completed',
  'run_failed',
  'note',
]);

export const runEventSchema = z.object({
  runId: uuidSchema,
  seq: z.int().nonnegative(),
  at: isoDateTimeSchema,
  kind: runEventKindSchema,
  nodeId: z.string().nullable(),
  title: z.string().min(1),
  detail: z.string(),
  data: z.unknown(),
});

export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'timed_out']);

export const approvalProposalSchema = z.object({
  action: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })),
  proposer: z.enum(['llm', 'rules']),
  payImpactCents: z.int(),
  payload: z.unknown(),
});

export const approvalSchema = z.object({
  approvalId: uuidSchema,
  runId: uuidSchema,
  tenantId: uuidSchema,
  workflowName: z.string().min(1),
  nodeId: z.string().min(1),
  subject: z.string().min(1),
  requestedFromRole: z.string().min(1),
  escalateTo: z.string().min(1),
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  status: approvalStatusSchema,
  proposal: approvalProposalSchema,
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

export const decisionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).max(500),
});

export const decisionResponseSchema = z.object({
  approvalId: uuidSchema,
  runId: uuidSchema,
  status: approvalStatusSchema,
  runStatus: runStatusSchema,
});

export const simulatorScenarioSchema = z.enum(['coverage_rescue', 'payroll_exception']);

export const simulatorResponseSchema = z.object({
  scenario: simulatorScenarioSchema,
  shiftId: uuidSchema.nullable(),
  timesheetId: uuidSchema.nullable(),
  emittedEvents: z.array(z.string()),
  note: z.string().min(1),
});

export const runDetailSchema = z.object({
  run: runSummarySchema,
  events: z.array(runEventSchema),
  approval: approvalSchema.nullable(),
});

export type TriggerDescriptor = z.infer<typeof triggerDescriptorSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type ApprovalProposal = z.infer<typeof approvalProposalSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;
export type SimulatorScenario = z.infer<typeof simulatorScenarioSchema>;
export type SimulatorResponse = z.infer<typeof simulatorResponseSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
