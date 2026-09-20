import { pgTable, integer, customType, text, timestamp, uuid, bigserial, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { CanvasLayout, Diagnostic, WorkflowDefinition } from '@wfm/workflows';

// drizzle's jsonb() stringifies the value, and Bun then encodes the string a
// second time, so the column ends up as a jsonb string scalar. This passthrough
// custom type hands the JS object straight to the driver.
const jsonbObject = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
});

/**
 * Studio persistence. Workflow definitions are versioned and immutable once
 * published; a run pins the version it started with so a run in flight never
 * changes shape because someone edited the workflow (design.md §7).
 */

export const workflows = pgTable(
  'workflows',
  {
    workflowId: uuid('workflow_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    draftVersionNumber: integer('draft_version_number').notNull().default(1),
    publishedVersionNumber: integer('published_version_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('workflows_tenant_idx').on(table.tenantId)],
);

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    versionId: uuid('version_id').primaryKey(),
    workflowId: uuid('workflow_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    definition: jsonbObject('definition').$type<WorkflowDefinition>().notNull(),
    layout: jsonbObject('layout').$type<CanvasLayout>().notNull(),
    diagnostics: jsonbObject('diagnostics').$type<Diagnostic[]>().notNull().default([]),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workflow_versions_unique').on(table.workflowId, table.versionNumber),
    index('workflow_versions_tenant_idx').on(table.tenantId),
  ],
);

export const runs = pgTable(
  'runs',
  {
    runId: uuid('run_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    workflowName: text('workflow_name').notNull(),
    triggerEventId: uuid('trigger_event_id').notNull(),
    triggerEventType: text('trigger_event_type').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'],
    }).notNull(),
    correlationId: uuid('correlation_id').notNull(),
    dryRun: boolean('dry_run').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    actionsExecuted: integer('actions_executed').notNull().default(0),
    summary: text('summary'),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('runs_workflow_event_unique').on(table.workflowId, table.triggerEventId),
    index('runs_status_idx').on(table.status),
    index('runs_tenant_idx').on(table.tenantId),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    nodeId: text('node_id'),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    data: jsonbObject('data'),
  },
  (table) => [uniqueIndex('run_events_seq_unique').on(table.runId, table.seq)],
);

export const approvals = pgTable(
  'approvals',
  {
    approvalId: uuid('approval_id').primaryKey(),
    runId: uuid('run_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: text('node_id').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'timed_out'] }).notNull(),
    subject: text('subject').notNull(),
    requestedFromRole: text('requested_from_role').notNull(),
    escalateTo: text('escalate_to').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    payImpactCents: integer('pay_impact_cents').notNull().default(0),
    proposal: jsonbObject('proposal').notNull(),
    decidedBy: text('decided_by'),
    decisionReason: text('decision_reason'),
    /** Steering the approver sent to the run; becomes a human message on resume. */
    feedback: text('feedback'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [index('approvals_status_idx').on(table.status), index('approvals_run_idx').on(table.runId)],
);

/** One row per (event, consumer): the dedupe ledger for at-least-once delivery. */
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    consumer: text('consumer').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('processed_events_unique').on(table.eventId, table.consumer)],
);

export const deadLetters = pgTable('dead_letters', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id'),
  eventType: text('event_type'),
  reason: text('reason').notNull(),
  raw: text('raw').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only. Nothing in the engine updates or deletes a row here. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id'),
    workflowId: uuid('workflow_id'),
    nodeId: text('node_id'),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    detail: jsonbObject('detail').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_run_idx').on(table.runId)],
);

/**
 * One row per tenant: which model provider the studio should use. A customer
 * key is stored encrypted and is never read back out, only its last four
 * characters.
 */
export const llmProviderSettings = pgTable('llm_provider_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  kind: text('kind', { enum: ['platform', 'openai-compatible', 'anthropic', 'none'] }).notNull(),
  baseUrl: text('base_url'),
  model: text('model'),
  apiKeyCiphertext: text('api_key_ciphertext'),
  apiKeyLast4: text('api_key_last4'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per model call, so tokens and cost stay auditable per run and node. */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    nodeId: text('node_id').notNull(),
    providerKind: text('provider_kind').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('llm_calls_run_idx').on(table.runId), index('llm_calls_tenant_idx').on(table.tenantId)],
);

/** A document a run rendered from its own data. */
export const artifacts = pgTable(
  'artifacts',
  {
    artifactId: uuid('artifact_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    runId: uuid('run_id').notNull(),
    nodeId: text('node_id').notNull(),
    name: text('name').notNull(),
    format: text('format', { enum: ['markdown', 'json'] }).notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('artifacts_run_idx').on(table.runId)],
);

/**
 * The builder conversation, one row per turn. It is stored rather than kept in
 * the browser so a reload, or a different machine, resumes the same thread, and
 * so what the agent was told is auditable next to the graph it produced.
 */
export const builderMessages = pgTable(
  'builder_messages',
  {
    messageId: uuid('message_id').primaryKey(),
    workflowId: uuid('workflow_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    model: text('model'),
    applied: jsonbObject('applied'),
    rejected: jsonbObject('rejected'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('builder_messages_workflow_idx').on(table.workflowId)],
);
