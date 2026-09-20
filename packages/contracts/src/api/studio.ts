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

/* Model, provider, and run-accounting shapes. Declared here so the run summary
 * and the run detail below can use them. */

export const llmProviderKindSchema = z.enum(['platform', 'openai-compatible', 'anthropic', 'none']);

export const modelDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: z.string().min(1),
  contextWindow: z.int().positive(),
  maxOutputTokens: z.int().positive(),
  jsonMode: z.boolean(),
  /**
   * Whether the model is known to answer with tool calls. The builder agent
   * runs on tools, so a model that does not is offered for reasoning and not
   * for the chat, rather than failing halfway through a turn.
   */
  toolCalls: z.boolean(),
  inputCentsPerMillion: z.number().nonnegative(),
  outputCentsPerMillion: z.number().nonnegative(),
  default: z.boolean(),
});

export const providerSettingsSchema = z.object({
  kind: llmProviderKindSchema,
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  hasApiKey: z.boolean(),
  apiKeyLast4: z.string().nullable(),
  platformConfigured: z.boolean(),
  updatedAt: isoDateTimeSchema.nullable(),
  updatedBy: z.string().nullable(),
});

export const providerSettingsRequestSchema = z.object({
  kind: llmProviderKindSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(8).max(400).optional(),
  model: z.string().min(1).max(200).optional(),
});

export const tokenUsageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  calls: z.int().nonnegative(),
  estimatedCostCents: z.number().nonnegative(),
});

export const artifactFormatSchema = z.enum(['markdown', 'json']);

export const artifactSchema = z.object({
  artifactId: uuidSchema,
  runId: uuidSchema,
  nodeId: z.string().min(1),
  name: z.string().min(1),
  format: artifactFormatSchema,
  createdAt: isoDateTimeSchema,
});

export const artifactDetailSchema = artifactSchema.extend({
  content: z.string(),
  contentType: z.string().min(1),
});

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
  /** What the run's model calls consumed, from the provider's own usage report. */
  tokens: tokenUsageSchema,
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
  /** What the approver told the workflow to do, when they said more than yes or no. */
  feedback: z.string().nullable(),
});

export const decisionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).max(500),
  /**
   * Steering for the workflow, not for the audit trail: it becomes the next
   * human message in the run, so the nodes after this approval decide with it
   * in front of them.
   */
  feedback: z.string().trim().min(1).max(1000).optional(),
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

/** What triggered the run, which is the data the workflow could read. */
export const runInputSchema = z.object({
  triggerEventId: uuidSchema,
  triggerEventType: z.string().min(1),
  payload: z.unknown(),
  workflowName: z.string().min(1),
  workflowVersionNumber: z.int().positive(),
});

/** What the run delivered, which is what a reviewer checks it against. */
export const runOutputSchema = z.object({
  status: runStatusSchema,
  summary: z.string().nullable(),
  actionsExecuted: z.int().nonnegative(),
  artifacts: z.array(artifactSchema),
});

export const runDetailSchema = z.object({
  run: runSummarySchema,
  events: z.array(runEventSchema),
  approval: approvalSchema.nullable(),
  input: runInputSchema,
  output: runOutputSchema,
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
export type RunInput = z.infer<typeof runInputSchema>;
export type RunOutput = z.infer<typeof runOutputSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ProviderSettingsRequest = z.infer<typeof providerSettingsRequestSchema>;
export type LlmProviderKind = z.infer<typeof llmProviderKindSchema>;

/* Aggregates for the dashboard, and the data the canvas can insert into a node. */

export const dashboardSchema = z.object({
  runs: z.object({
    total: z.int().nonnegative(),
    byStatus: z.record(z.string(), z.int().nonnegative()),
    last24h: z.int().nonnegative(),
    medianDurationMs: z.int().nonnegative().nullable(),
  }),
  tokens: tokenUsageSchema,
  workflows: z.array(
    z.object({
      workflowId: uuidSchema,
      name: z.string().min(1),
      enabled: z.boolean(),
      publishedVersion: z.int().positive().nullable(),
      draftVersion: z.int().positive().nullable(),
      runs: z.int().nonnegative(),
      lastRunAt: isoDateTimeSchema.nullable(),
    }),
  ),
});

/** What the canvas can insert into a node's template fields. */
export const dataCatalogueSchema = z.object({
  eventType: z.string().min(1),
  roots: z.array(
    z.object({
      name: z.string().min(1),
      label: z.string().min(1),
      description: z.string(),
      paths: z.array(
        z.object({
          path: z.string().min(1),
          label: z.string().min(1),
          type: z.string().min(1),
          sample: z.string(),
        }),
      ),
    }),
  ),
});

/** Creating a workflow either supplies a definition or names one to copy. */
export const createWorkflowBodySchema = z.union([
  z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    definition: z.unknown(),
    layout: z.unknown().optional(),
  }),
  z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    fromWorkflowId: uuidSchema,
    versionNumber: z.int().positive().optional(),
  }),
]);

export type Dashboard = z.infer<typeof dashboardSchema>;
export type DataCatalogue = z.infer<typeof dataCatalogueSchema>;
export type CreateWorkflowBody = z.infer<typeof createWorkflowBodySchema>;
