import { Command } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { evaluateConditions, parseEvent, type AnyWfmEvent, type RunStatus } from '@wfm/contracts';
import type { EventBus } from '@wfm/eventbus';
import { compileWorkflow, type WorkflowDefinition } from '@wfm/workflows';
import * as schema from '../db/schema.ts';
import { publishRunCompleted, publishRunStarted } from './events.ts';
import { buildRunGraph } from './graph.ts';
import type { ExecutorDeps } from './nodes/context.ts';
import type { QueueGateway } from './scope.ts';
import {
  appendAudit,
  appendRunEvent,
  decideApprovalRow,
  getApprovalRow,
  getFirstRunEvent,
  getRunRow,
  updateRun,
  type RunDb,
} from './run-store.ts';
import { NotFoundError } from './errors.ts';
import type { RunScope } from './scope.ts';
import type { ResumePayload } from './state.ts';
import type { Proposer } from './nodes/proposers.ts';
import type { AgentRunner } from './nodes/agent-runner.ts';

export const ROUTER_CONSUMER_GROUP = 'studio-router';

const TERMINAL_STATUSES: Readonly<Record<string, boolean>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

const STATUS_BY_END_OUTCOME: Record<string, RunStatus> = {
  completed: 'succeeded',
  needs_attention: 'succeeded',
  stopped: 'cancelled',
};

export interface OrchestratorDeps {
  db: RunDb;
  bus: EventBus;
  clients: ExecutorDeps['clients'];
  queue: QueueGateway;
  proposer: Proposer;
  /** Null only when the engine was built without a model layer. */
  agent: AgentRunner | null;
  checkpointer: BaseCheckpointSaver;
  logger: Logger;
  dryRun?: boolean;
}

export interface EventMatchResult {
  matched: number;
  runIds: string[];
}

/**
 * The run state machine owner (design §7.2). Nothing else writes run status:
 * the router creates runs, this module drives queued → running →
 * awaiting_approval → running → succeeded | failed | cancelled, appends the
 * audit trail, and publishes the studio's own events onto the backbone.
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  async handleEvent(event: AnyWfmEvent): Promise<EventMatchResult> {
    const { db } = this.#deps;
    const dedupe = await db
      .insert(schema.processedEvents)
      .values({ eventId: event.eventId, consumer: ROUTER_CONSUMER_GROUP })
      .onConflictDoNothing({ target: [schema.processedEvents.eventId, schema.processedEvents.consumer] })
      .returning();
    if (dedupe.length === 0) {
      // The event was handled before. If the run it created never left the
      // queue (an enqueue that failed after the dedupe row was written), this
      // redelivery is the only chance to recover it. The recover job id is
      // deterministic, so re-enqueuing cannot double-run a healthy run.
      const stranded = await db
        .select({ runId: schema.runs.runId })
        .from(schema.runs)
        .where(and(eq(schema.runs.triggerEventId, event.eventId), eq(schema.runs.status, 'queued')));
      for (const run of stranded) {
        await this.#deps.queue.enqueueRunStep(event.tenantId, run.runId);
      }
      this.#deps.logger[stranded.length > 0 ? 'warn' : 'info'](
        { tenantId: event.tenantId, eventId: event.eventId, stranded: stranded.length },
        stranded.length > 0 ? 're-enqueued stranded runs for a redelivered event' : 'duplicate delivery skipped',
      );
      return { matched: 0, runIds: stranded.map((run) => run.runId) };
    }

    const candidates = await db
      .select({ workflow: schema.workflows, version: schema.workflowVersions })
      .from(schema.workflows)
      .innerJoin(
        schema.workflowVersions,
        and(
          eq(schema.workflowVersions.workflowId, schema.workflows.workflowId),
          eq(schema.workflowVersions.versionNumber, schema.workflows.publishedVersionNumber),
          eq(schema.workflowVersions.status, 'published'),
        ),
      )
      .where(and(eq(schema.workflows.tenantId, event.tenantId), eq(schema.workflows.enabled, true)));

    const runIds: string[] = [];
    for (const candidate of candidates) {
      const triggerNode = candidate.version.definition.nodes.find((node) => node.type === 'trigger');
      if (!triggerNode || triggerNode.config.eventType !== event.eventType) continue;
      if (!evaluateConditions(triggerNode.config.conditions, event).matched) continue;
      const runId = await this.#createRun(candidate, event);
      if (runId) runIds.push(runId);
    }
    return { matched: runIds.length, runIds };
  }

  async #createRun(
    candidate: { workflow: typeof schema.workflows.$inferSelect; version: typeof schema.workflowVersions.$inferSelect },
    event: AnyWfmEvent,
  ): Promise<string | null> {
    const { db } = this.#deps;
    const runId = crypto.randomUUID();
    const inserted = await db
      .insert(schema.runs)
      .values({
        runId,
        tenantId: event.tenantId,
        workflowId: candidate.workflow.workflowId,
        workflowVersionId: candidate.version.versionId,
        workflowName: candidate.workflow.name,
        triggerEventId: event.eventId,
        triggerEventType: event.eventType,
        status: 'queued',
        correlationId: event.correlationId,
        dryRun: this.#deps.dryRun ?? false,
      })
      .onConflictDoNothing({ target: [schema.runs.workflowId, schema.runs.triggerEventId] })
      .returning();
    if (inserted.length === 0) {
      this.#deps.logger.info(
        { tenantId: event.tenantId, workflowId: candidate.workflow.workflowId, eventId: event.eventId },
        'run already exists for this trigger event',
      );
      return null;
    }
    await appendAudit(db, {
      tenantId: event.tenantId,
      runId,
      workflowId: candidate.workflow.workflowId,
      nodeId: null,
      action: 'run.created',
      actor: 'studio-engine',
      detail: {
        triggerEventId: event.eventId,
        triggerEventType: event.eventType,
        workflowVersionId: candidate.version.versionId,
        dryRun: this.#deps.dryRun ?? false,
      },
    });
    const triggerNode = candidate.version.definition.nodes.find((node) => node.type === 'trigger');
    await appendRunEvent(db, {
      runId,
      kind: 'event_received',
      ...(triggerNode ? { nodeId: triggerNode.id } : {}),
      title: `Event ${event.eventType} received`,
      detail: triggerNode?.label ?? '',
      data: event,
    });
    await publishRunStarted(this.#deps.bus, {
      tenantId: event.tenantId,
      correlationId: event.correlationId,
      causationId: event.eventId,
      runId,
      workflowId: candidate.workflow.workflowId,
      triggerEventId: event.eventId,
      triggerEventType: event.eventType,
    });
    await this.#deps.queue.enqueueRunStart(event.tenantId, runId);
    this.#deps.logger.info(
      { tenantId: event.tenantId, runId, workflowId: candidate.workflow.workflowId, eventId: event.eventId },
      'run created',
    );
    return runId;
  }

  /** Drives one execution pass of the graph, resuming an interrupt when asked. */
  async runStep(runId: string, resume?: ResumePayload): Promise<RunStatus> {
    const { db } = this.#deps;
    const run = await getRunRow(db, runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    if (TERMINAL_STATUSES[run.status]) return run.status as RunStatus;

    const version = await this.#version(run.workflowVersionId);
    const eventEnvelope = await this.#eventEnvelope(runId);
    const scope: RunScope = {
      runId: run.runId,
      tenantId: run.tenantId,
      workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId,
      workflowName: run.workflowName,
      correlationId: run.correlationId,
      triggerEventId: run.triggerEventId,
      dryRun: run.dryRun,
    };
    const spec = compileWorkflow(version.definition);
    const graph = buildRunGraph(spec, version.definition, scope, this.#nodeDeps(), this.#deps.checkpointer);

    if (run.status !== 'running') {
      await updateRun(db, runId, { status: 'running' });
    }
    const input = resume
      ? new Command({ resume })
      : {
          runId,
          tenantId: run.tenantId,
          definition: version.definition,
          event: eventEnvelope,
          nodes: {},
          messages: [],
          cursor: '',
          decision: null,
        };
    const result = await graph.invoke(input, { configurable: { thread_id: runId } });

    if ('__interrupt__' in result && Array.isArray(result.__interrupt__) && result.__interrupt__.length > 0) {
      await updateRun(db, runId, { status: 'awaiting_approval' });
      return 'awaiting_approval';
    }

    return this.#finalize(runId, version.definition, result.cursor);
  }

  async #finalize(runId: string, definition: WorkflowDefinition, cursor: string): Promise<RunStatus> {
    const { db } = this.#deps;
    const current = await getRunRow(db, runId);
    if (!current || TERMINAL_STATUSES[current.status]) return (current?.status ?? 'succeeded') as RunStatus;

    const reached = definition.nodes.find((node) => node.id === cursor);
    const outcome = reached?.type === 'end' ? reached.config.outcome : 'completed';
    const status = STATUS_BY_END_OUTCOME[outcome] ?? 'succeeded';
    const summary = reached ? `${reached.label} (${outcome})` : `run finished at ${cursor}`;
    const startedAt = current.startedAt.getTime();
    const finishedAt = new Date();
    await updateRun(db, runId, { status, summary, finishedAt });
    await appendRunEvent(db, {
      runId,
      kind: 'run_completed',
      nodeId: cursor,
      title: `Run ${status}`,
      detail: summary,
      data: { outcome, actionsExecuted: current.actionsExecuted, durationMs: finishedAt.getTime() - startedAt },
    });
    await appendAudit(db, {
      tenantId: current.tenantId,
      runId,
      workflowId: current.workflowId,
      nodeId: cursor,
      action: 'run.completed',
      actor: 'studio-engine',
      detail: { status, outcome, durationMs: finishedAt.getTime() - startedAt },
    });
    await publishRunCompleted(this.#deps.bus, {
      tenantId: current.tenantId,
      correlationId: current.correlationId,
      causationId: current.triggerEventId,
      runId,
      workflowId: current.workflowId,
      status: status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
      actionsExecuted: current.actionsExecuted,
      durationMs: finishedAt.getTime() - startedAt,
    });
    return status;
  }

  /** Marks a run failed after its last retry attempt. */
  async failRun(runId: string, error: unknown): Promise<RunStatus> {
    const { db } = this.#deps;
    const run = await getRunRow(db, runId);
    if (!run || TERMINAL_STATUSES[run.status]) return (run?.status ?? 'failed') as RunStatus;
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(db, runId, { status: 'failed', error: message, finishedAt: new Date() });
    await appendRunEvent(db, {
      runId,
      kind: 'run_failed',
      title: 'Run failed',
      detail: message,
    });
    await appendAudit(db, {
      tenantId: run.tenantId,
      runId,
      workflowId: run.workflowId,
      nodeId: null,
      action: 'run.failed',
      actor: 'studio-engine',
      detail: { error: message },
    });
    return 'failed';
  }

  /** Timeout path for an approval: expire it, publish, and let the graph escalate. */
  async expireApproval(runId: string, approvalId: string): Promise<'expired' | 'skipped'> {
    const { db } = this.#deps;
    const row = await getApprovalRow(db, approvalId);
    if (!row || row.runId !== runId) throw new NotFoundError(`approval ${approvalId} not found for run ${runId}`);
    if (row.status !== 'pending') return 'skipped';

    const reason = `Approval timed out for ${row.requestedFromRole}; escalating to ${row.escalateTo}.`;
    const decided = await decideApprovalRow(db, approvalId, 'timed_out', 'system:timeout', reason);
    if (!decided) return 'skipped';
    await appendRunEvent(db, {
      runId,
      kind: 'approval_decided',
      nodeId: row.nodeId,
      title: 'Approval timed out',
      detail: reason,
      data: { approvalId, decision: 'timed_out' },
    });
    await appendAudit(db, {
      tenantId: row.tenantId,
      runId,
      workflowId: row.workflowId,
      nodeId: row.nodeId,
      action: 'human_approval.timeout',
      actor: 'system:timeout',
      detail: { approvalId, reason },
    });
    await this.resumeAfterDecision(runId, { decision: 'timeout', approvalId });
    return 'expired';
  }

  /** Called by the approvals service after a human decision is written. */
  async resumeAfterDecision(runId: string, payload: ResumePayload): Promise<RunStatus> {
    return this.runStep(runId, payload);
  }

  async #version(versionId: string): Promise<typeof schema.workflowVersions.$inferSelect> {
    const rows = await this.#deps.db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.versionId, versionId))
      .limit(1);
    const version = rows[0];
    if (!version) throw new NotFoundError(`workflow version ${versionId} not found`);
    return version;
  }

  async #eventEnvelope(runId: string): Promise<AnyWfmEvent> {
    const event = await getFirstRunEvent(this.#deps.db, runId, 'event_received');
    if (!event) throw new NotFoundError(`run ${runId} has no stored trigger event`);
    return parseEvent(event.data);
  }

  #nodeDeps(): ExecutorDeps {
    const deps = this.#deps;
    return {
      db: deps.db,
      bus: deps.bus,
      clients: deps.clients,
      queue: deps.queue,
      proposer: deps.proposer,
      agent: deps.agent,
      logger: deps.logger,
    };
  }
}
