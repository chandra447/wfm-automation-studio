import { and, asc, eq, gt, sql as dsql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Approval, RunEvent, RunStatus, RunSummary } from '@wfm/contracts';
import * as schema from '../db/schema.ts';
import type { approvals, auditLog, runEvents, runs, workflowVersions, workflows } from '../db/schema.ts';

export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;

export type RunDb = PostgresJsDatabase<typeof schema>;

export type RunEventKind =
  | 'event_received'
  | 'context_resolved'
  | 'policy_evaluated'
  | 'proposal_created'
  | 'approval_requested'
  | 'approval_decided'
  | 'action_executed'
  | 'run_completed'
  | 'run_failed'
  | 'note';

export interface AppendRunEventInput {
  runId: string;
  kind: RunEventKind;
  nodeId?: string;
  title: string;
  detail?: string;
  data?: unknown;
}

const MAX_SEQ_RETRIES = 5;

/**
 * Appends to the run timeline with a per-run monotonic `seq`. The unique index
 * on (run_id, seq) plus retry makes concurrent appends safe; the row is
 * authoritative for the SSE stream.
 */
export async function appendRunEvent(db: RunDb, input: AppendRunEventInput): Promise<RunEventRow> {
  for (let attempt = 0; ; attempt += 1) {
    const rows = await db
      .insert(runEvents)
      .values({
        runId: input.runId,
        seq: dsql`(SELECT COALESCE(MAX(${runEvents.seq}), -1) + 1 FROM ${runEvents} WHERE ${runEvents.runId} = ${input.runId})`,
        kind: input.kind,
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        title: input.title,
        detail: input.detail ?? '',
        data: input.data,
      })
      .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })
      .returning();
    const row = rows[0];
    if (row) return row;
    if (attempt >= MAX_SEQ_RETRIES) throw new Error(`could not append run_event for run ${input.runId}`);
  }
}

export interface AuditInput {
  tenantId: string;
  runId?: string | null;
  workflowId?: string | null;
  nodeId?: string | null;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
}

/** Append-only audit trail; nothing ever updates or deletes these rows. */
export async function appendAudit(db: RunDb, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    tenantId: input.tenantId,
    runId: input.runId ?? null,
    workflowId: input.workflowId ?? null,
    nodeId: input.nodeId ?? null,
    action: input.action,
    actor: input.actor,
    detail: input.detail,
  });
}

export type RunPatch = Partial<{
  status: RunStatus;
  summary: string | null;
  error: string | null;
  finishedAt: Date;
  actionsExecuted: number;
}>;

export async function updateRun(db: RunDb, runId: string, patch: RunPatch): Promise<RunRow | undefined> {
  const rows = await db.update(runs).set(patch).where(eq(runs.runId, runId)).returning();
  return rows[0];
}

export async function getRunRow(db: RunDb, runId: string): Promise<RunRow | undefined> {
  const rows = await db.select().from(runs).where(eq(runs.runId, runId)).limit(1);
  return rows[0];
}

export async function getRunEvents(db: RunDb, runId: string, afterId = 0, limit = 500): Promise<RunEventRow[]> {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterId)))
    .orderBy(asc(runEvents.id))
    .limit(limit);
}

export async function getFirstRunEvent(db: RunDb, runId: string, kind: RunEventKind): Promise<RunEventRow | undefined> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.kind, kind)))
    .orderBy(asc(runEvents.seq))
    .limit(1);
  return rows[0];
}

export async function listApprovalsForNode(db: RunDb, runId: string, nodeId: string): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.nodeId, nodeId)))
    .orderBy(asc(approvals.requestedAt));
}

export async function getApprovalRow(db: RunDb, approvalId: string): Promise<ApprovalRow | undefined> {
  const rows = await db.select().from(approvals).where(eq(approvals.approvalId, approvalId)).limit(1);
  return rows[0];
}

export async function getPendingApproval(db: RunDb, runId: string): Promise<ApprovalRow | undefined> {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
    .orderBy(asc(approvals.requestedAt))
    .limit(1);
  return rows[0];
}

export async function decideApprovalRow(
  db: RunDb,
  approvalId: string,
  decision: 'approved' | 'rejected' | 'timed_out',
  decidedBy: string,
  reason: string,
): Promise<ApprovalRow | undefined> {
  const rows = await db
    .update(approvals)
    .set({ status: decision, decidedBy, decisionReason: reason, decidedAt: new Date() })
    .where(and(eq(approvals.approvalId, approvalId), eq(approvals.status, 'pending')))
    .returning();
  return rows[0];
}

export async function insertApproval(db: RunDb, row: typeof approvals.$inferInsert): Promise<ApprovalRow> {
  const rows = await db.insert(approvals).values(row).returning();
  const row0 = rows[0];
  if (!row0) throw new Error(`approval row insert returned no row (run ${row.runId})`);
  return row0;
}

export function toRunSummary(run: RunRow, versionNumber: number, pendingApprovalId: string | null): RunSummary {
  return {
    runId: run.runId,
    tenantId: run.tenantId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    workflowVersionNumber: versionNumber,
    triggerEventId: run.triggerEventId,
    triggerEventType: run.triggerEventType,
    status: run.status as RunStatus,
    dryRun: run.dryRun,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    actionsExecuted: run.actionsExecuted,
    summary: run.summary,
    pendingApprovalId,
  };
}

export function toRunEvent(row: RunEventRow): RunEvent {
  return {
    runId: row.runId,
    seq: row.seq,
    at: row.at.toISOString(),
    kind: row.kind as RunEvent['kind'],
    nodeId: row.nodeId,
    title: row.title,
    detail: row.detail,
    data: row.data ?? undefined,
  };
}

export function toApproval(row: ApprovalRow, workflowName: string): Approval {
  return {
    approvalId: row.approvalId,
    runId: row.runId,
    tenantId: row.tenantId,
    workflowName,
    nodeId: row.nodeId,
    subject: row.subject,
    requestedFromRole: row.requestedFromRole,
    escalateTo: row.escalateTo,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.status as Approval['status'],
    proposal: row.proposal as Approval['proposal'],
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
  };
}

