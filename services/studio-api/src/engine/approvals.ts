import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ActorContext, Approval, DecisionRequest, DecisionResponse, RunStatus } from '@wfm/contracts';
import type { EventBus } from '@wfm/eventbus';
import * as schema from '../db/schema.ts';
import { ForbiddenError, NotFoundError } from './errors.ts';
import { publishApprovalDecided } from './events.ts';
import type { Orchestrator } from './orchestrator.ts';
import { appendAudit, appendRunEvent, decideApprovalRow, getApprovalRow, getRunRow, toApproval, type RunDb } from './run-store.ts';

/**
 * Approval listing and human decisions (design §7.3). A decision is only
 * valid from the requested role (or its escalation role) inside the same
 * tenant; the decision row is written, published onto the backbone, and the
 * paused graph is resumed on the same thread.
 */
export class ApprovalService {
  readonly #db: RunDb;
  readonly #bus: EventBus;
  readonly #logger: Logger;
  readonly #orchestrator: Orchestrator;

  constructor(db: RunDb, bus: EventBus, logger: Logger, orchestrator: Orchestrator) {
    this.#db = db;
    this.#bus = bus;
    this.#logger = logger;
    this.#orchestrator = orchestrator;
  }

  async list(actor: ActorContext, status?: Approval['status']): Promise<Approval[]> {
    const conditions = [eq(schema.approvals.tenantId, actor.tenantId)];
    if (status) conditions.push(eq(schema.approvals.status, status));
    const rows = await this.#db
      .select({ approval: schema.approvals, workflowName: schema.runs.workflowName })
      .from(schema.approvals)
      .innerJoin(schema.runs, eq(schema.runs.runId, schema.approvals.runId))
      .where(and(...conditions))
      .orderBy(desc(schema.approvals.requestedAt));
    return rows.map((row) => toApproval(row.approval, row.workflowName));
  }

  async decide(actor: ActorContext, approvalId: string, request: DecisionRequest): Promise<DecisionResponse> {
    const row = await getApprovalRow(this.#db, approvalId);
    if (!row || row.tenantId !== actor.tenantId) {
      throw new NotFoundError(`approval ${approvalId} not found`);
    }
    const authorized = actor.roles.includes(row.requestedFromRole) || actor.roles.includes(row.escalateTo);
    if (!authorized) {
      throw new ForbiddenError(
        `forbidden: deciding approval ${approvalId} requires the ${row.requestedFromRole} role (escalation: ${row.escalateTo})`,
      );
    }

    const decision: 'approved' | 'rejected' = request.decision === 'approve' ? 'approved' : 'rejected';
    const decided = await decideApprovalRow(this.#db, approvalId, decision, actor.userId, request.reason);
    if (!decided) {
      // Already decided: replay the stored decision without resuming the graph.
      this.#logger.info({ tenantId: row.tenantId, approvalId }, 'approval already decided; replaying stored decision');
      const run = await getRunRow(this.#db, row.runId);
      return {
        approvalId,
        runId: row.runId,
        status: row.status,
        runStatus: (run?.status ?? 'running') as RunStatus,
      };
    }

    await appendRunEvent(this.#db, {
      runId: row.runId,
      kind: 'approval_decided',
      nodeId: row.nodeId,
      title: `Approval ${decision} by ${actor.userId}`,
      detail: request.reason,
      data: { approvalId, decision: decided.status, decidedBy: actor.userId },
    });
    await appendAudit(this.#db, {
      tenantId: row.tenantId,
      runId: row.runId,
      workflowId: row.workflowId,
      nodeId: row.nodeId,
      action: 'human_approval.decided',
      actor: actor.userId,
      detail: { approvalId, decision, reason: request.reason, roles: actor.roles },
    });
    const run = await getRunRow(this.#db, row.runId);
    await publishApprovalDecided(this.#bus, {
      tenantId: row.tenantId,
      correlationId: run?.correlationId ?? row.runId,
      causationId: row.approvalId,
      runId: row.runId,
      approvalId,
      decision,
      decidedBy: actor.userId,
      reason: request.reason,
    });

    const runStatus = await this.#orchestrator.resumeAfterDecision(row.runId, {
      decision: request.decision,
      approvalId,
    });
    this.#logger.info({ tenantId: row.tenantId, runId: row.runId, approvalId, decision }, 'approval decided');
    return { approvalId, runId: row.runId, status: decided.status, runStatus };
  }
}
