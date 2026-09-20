import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Pool } from 'pg';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  triggerCatalog,
  type ActorContext,
  type Approval,
  type DecisionRequest,
  type DecisionResponse,
  type RunDetail,
  type RunEvent,
  type RunSummary,
  type SimulatorResponse,
  type SimulatorScenario,
  type TriggerDescriptor,
} from '@wfm/contracts';
import { createEventBus, type EventBus } from '@wfm/eventbus';
import { createLogger } from '@wfm/observability';
import {
  validateWorkflow,
  validationErrors,
  WorkflowValidationError,
  type Diagnostic,
  type WorkflowDefinition,
} from '@wfm/workflows';
import type { Logger } from 'pino';
import type { SQL } from 'bun';
import * as schema from '../db/schema.ts';
import { ApprovalService } from './approvals.ts';
import { connectStudioDb, ensureStudioTables } from './db.ts';
import type {
  EngineService,
  RunFilter,
  SaveWorkflowRequest,
  WorkflowDetail,
  WorkflowMutationResult,
  WorkflowSummary,
  WorkflowVersion,
} from './contract.ts';
import { createDomainClients, type DomainClients } from './domain-clients.ts';
import { NotFoundError } from './errors.ts';
import { Orchestrator } from './orchestrator.ts';
import { createQueueGateway } from './queue.ts';
import { Router } from './router.ts';
import { Simulator } from './simulator.ts';
import type { QueueGateway } from './scope.ts';
import {
  appendAudit,
  getDecidedApproval,
  getPendingApproval,
  getRunEvents,
  getRunRow,
  toApproval,
  toRunEvent,
  toRunSummary,
  type RunDb,
  type RunRow,
} from './run-store.ts';
import { createProposer, type Proposer } from './nodes/proposers.ts';

/**
 * Engine composition root: builds every binding (Drizzle over Postgres, the
 * event bus, BullMQ queues, the Postgres checkpointer, domain clients) and
 * exposes the EngineService surface the frozen HTTP layer calls. Tests build
 * the same context with an InMemory bus, a test database, and an inline queue
 * gateway instead.
 */

export interface EngineContext {
  sql: SQL;
  db: RunDb;
  bus: EventBus;
  clients: DomainClients;
  proposer: Proposer;
  checkpointer: BaseCheckpointSaver;
  queue: QueueGateway & { close?: () => Promise<void> };
  logger: Logger;
  dryRun: boolean;
  /** Boot hook; the env wiring runs `PostgresSaver.setup()` here. */
  prepare?: () => Promise<void>;
  /** Connections the engine created and must release on stop. */
  dispose?: () => Promise<void>;
}

const TERMINAL_RUN_STATUSES: Record<string, boolean> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

const POLL_INTERVAL_MS = 250;

interface Wiring {
  engine: EngineService;
  orchestrator: Orchestrator;
}

export function createEngine(context: EngineContext): Wiring {
  const orchestrator = new Orchestrator({
    db: context.db,
    bus: context.bus,
    clients: context.clients,
    queue: context.queue,
    proposer: context.proposer,
    checkpointer: context.checkpointer,
    logger: context.logger,
    dryRun: context.dryRun,
  });
  const router = new Router({
    sql: context.sql,
    db: context.db,
    bus: context.bus,
    orchestrator,
    logger: context.logger,
  });
  const approvals = new ApprovalService(context.db, context.bus, context.logger, orchestrator);
  const simulator = new Simulator(context.clients, context.logger);
  return {
    engine: new Engine(context, router, approvals, simulator),
    orchestrator,
  };
}

/**
 * The env wiring required by the frozen HTTP layer: Drizzle over the studio
 * database, the event bus binding, BullMQ on Redis, the Postgres checkpointer
 * (set up once at boot so `interrupt()` survives a process restart), and the
 * two domain clients.
 */
export function createEngineFromEnv(env: NodeJS.ProcessEnv = process.env): EngineService {
  const databaseUrl = env.STUDIO_DATABASE_URL;
  if (!databaseUrl) throw new Error('STUDIO_DATABASE_URL is required');
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');

  const logger = createLogger('studio-engine');
  const studioDb = connectStudioDb(databaseUrl);
  const bus = createEventBus({
    ...(env.EVENT_BACKBONE ? { EVENT_BACKBONE: env.EVENT_BACKBONE } : {}),
    ...(env.REDIS_URL ? { REDIS_URL: env.REDIS_URL } : {}),
    ...(env.EVENT_STREAM_PREFIX ? { EVENT_STREAM_PREFIX: env.EVENT_STREAM_PREFIX } : {}),
  });
  const clients = createDomainClients({
    ...(env.ROSTERING_BASE_URL ? { ROSTERING_BASE_URL: env.ROSTERING_BASE_URL } : {}),
    ...(env.TIME_ATTENDANCE_BASE_URL ? { TIME_ATTENDANCE_BASE_URL: env.TIME_ATTENDANCE_BASE_URL } : {}),
  });
  const proposer = createProposer({
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? '',
    ...(env.OPENAI_MODEL ? { OPENAI_MODEL: env.OPENAI_MODEL } : {}),
    ...(env.LLM_TIMEOUT_MS ? { LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS } : {}),
  });

  const pool = new Pool({ connectionString: databaseUrl });
  const checkpointer = new PostgresSaver(pool);

  const orchestratorRef: { value?: Orchestrator } = {};
  const queue = createQueueGateway({
    redisUrl,
    logger,
    get orchestrator(): Orchestrator {
      const value = orchestratorRef.value;
      if (!value) throw new Error('engine is not initialised yet');
      return value;
    },
  });

  const { engine, orchestrator } = createEngine({
    sql: studioDb.sql,
    db: studioDb.db,
    bus,
    clients,
    proposer,
    checkpointer,
    queue,
    logger,
    dryRun: env.STUDIO_DRY_RUN === 'true',
    prepare: () => checkpointer.setup(),
    dispose: async () => {
      await studioDb.close();
      await pool.end();
      await bus.close();
    },
  });
  orchestratorRef.value = orchestrator;
  return engine;
}

type WorkflowRow = typeof schema.workflows.$inferSelect;
type WorkflowVersionRow = typeof schema.workflowVersions.$inferSelect;

class Engine implements EngineService {
  readonly #context: EngineContext;
  readonly #router: Router;
  readonly #approvals: ApprovalService;
  readonly #simulator: Simulator;
  readonly #db: RunDb;
  readonly #logger: Logger;

  constructor(context: EngineContext, router: Router, approvals: ApprovalService, simulator: Simulator) {
    this.#context = context;
    this.#router = router;
    this.#approvals = approvals;
    this.#simulator = simulator;
    this.#db = context.db;
    this.#logger = context.logger;
  }

  listTriggers(): TriggerDescriptor[] {
    return triggerCatalog();
  }

  async listWorkflows(actor: ActorContext): Promise<WorkflowSummary[]> {
    const rows = await this.#db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.tenantId, actor.tenantId))
      .orderBy(desc(schema.workflows.updatedAt));
    return rows.map(workflowSummaryOf);
  }

  async getWorkflow(actor: ActorContext, workflowId: string): Promise<WorkflowDetail> {
    const row = await this.#workflowRow(actor, workflowId);
    const versions = await this.#db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflowId, workflowId))
      .orderBy(desc(schema.workflowVersions.versionNumber));
    return { workflow: workflowSummaryOf(row), versions: versions.map(workflowVersionOf) };
  }

  async createWorkflow(actor: ActorContext, request: SaveWorkflowRequest): Promise<WorkflowMutationResult> {
    const diagnostics = assertValid(request.definition);
    const workflowId = crypto.randomUUID();
    await this.#db.insert(schema.workflows).values({
      workflowId,
      tenantId: actor.tenantId,
      name: request.name,
      description: request.description,
      enabled: request.enabled,
      draftVersionNumber: 1,
    });
    await this.#db.insert(schema.workflowVersions).values({
      versionId: crypto.randomUUID(),
      workflowId,
      tenantId: actor.tenantId,
      versionNumber: 1,
      status: 'draft',
      definition: request.definition,
      layout: request.layout,
      diagnostics,
      createdBy: actor.userId,
    });
    await appendAudit(this.#db, {
      tenantId: actor.tenantId,
      workflowId,
      action: 'workflow.created',
      actor: actor.userId,
      detail: { name: request.name, enabled: request.enabled },
    });
    return { workflowId, versionNumber: 1, status: 'draft', diagnostics };
  }

  async saveDraft(actor: ActorContext, workflowId: string, request: SaveWorkflowRequest): Promise<WorkflowMutationResult> {
    const row = await this.#workflowRow(actor, workflowId);
    const diagnostics = assertValid(request.definition);
    const versionNumber = row.draftVersionNumber;
    await this.#db
      .insert(schema.workflowVersions)
      .values({
        versionId: crypto.randomUUID(),
        workflowId,
        tenantId: actor.tenantId,
        versionNumber,
        status: 'draft',
        definition: request.definition,
        layout: request.layout,
        diagnostics,
        createdBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: [schema.workflowVersions.workflowId, schema.workflowVersions.versionNumber],
        set: { definition: request.definition, layout: request.layout, diagnostics, createdBy: actor.userId },
      });
    await this.#db
      .update(schema.workflows)
      .set({ name: request.name, description: request.description, enabled: request.enabled, updatedAt: new Date() })
      .where(eq(schema.workflows.workflowId, workflowId));
    await appendAudit(this.#db, {
      tenantId: actor.tenantId,
      workflowId,
      action: 'workflow.draft_saved',
      actor: actor.userId,
      detail: { versionNumber, name: request.name },
    });
    return { workflowId, versionNumber, status: 'draft', diagnostics };
  }

  async publishWorkflow(actor: ActorContext, workflowId: string): Promise<WorkflowMutationResult> {
    const row = await this.#workflowRow(actor, workflowId);
    const versionNumber = row.draftVersionNumber;
    const draftRows = await this.#db
      .select()
      .from(schema.workflowVersions)
      .where(and(eq(schema.workflowVersions.workflowId, workflowId), eq(schema.workflowVersions.versionNumber, versionNumber)))
      .limit(1);
    const draft = draftRows[0];
    if (!draft) throw new NotFoundError(`workflow ${workflowId} has no draft version ${versionNumber} to publish`);
    if (row.publishedVersionNumber === versionNumber && draft.status === 'published') {
      return { workflowId, versionNumber, status: 'published', diagnostics: draft.diagnostics };
    }
    const diagnostics = assertValid(draft.definition);
    await this.#db
      .update(schema.workflowVersions)
      .set({ status: 'published' })
      .where(eq(schema.workflowVersions.versionId, draft.versionId));
    await this.#db
      .update(schema.workflows)
      .set({ publishedVersionNumber: versionNumber, draftVersionNumber: versionNumber + 1, updatedAt: new Date() })
      .where(eq(schema.workflows.workflowId, workflowId));
    await appendAudit(this.#db, {
      tenantId: actor.tenantId,
      workflowId,
      action: 'workflow.published',
      actor: actor.userId,
      detail: { versionNumber },
    });
    return { workflowId, versionNumber, status: 'published', diagnostics };
  }

  async deleteWorkflow(actor: ActorContext, workflowId: string): Promise<void> {
    await this.#workflowRow(actor, workflowId);
    await this.#db.delete(schema.workflowVersions).where(eq(schema.workflowVersions.workflowId, workflowId));
    await this.#db.delete(schema.workflows).where(eq(schema.workflows.workflowId, workflowId));
    await appendAudit(this.#db, {
      tenantId: actor.tenantId,
      workflowId,
      action: 'workflow.deleted',
      actor: actor.userId,
      detail: {},
    });
  }

  async listRuns(actor: ActorContext, filter: RunFilter): Promise<RunSummary[]> {
    const conditions = [eq(schema.runs.tenantId, actor.tenantId)];
    if (filter.workflowId) conditions.push(eq(schema.runs.workflowId, filter.workflowId));
    if (filter.status) conditions.push(eq(schema.runs.status, filter.status));
    const rows = await this.#db
      .select({ run: schema.runs, versionNumber: schema.workflowVersions.versionNumber })
      .from(schema.runs)
      .innerJoin(schema.workflowVersions, eq(schema.workflowVersions.versionId, schema.runs.workflowVersionId))
      .where(and(...conditions))
      .orderBy(desc(schema.runs.startedAt))
      .limit(filter.limit ?? 50);
    const runIds = rows.map((row) => row.run.runId);
    const pending =
      runIds.length > 0
        ? await this.#db
            .select({ runId: schema.approvals.runId, approvalId: schema.approvals.approvalId })
            .from(schema.approvals)
            .where(
              and(
                eq(schema.approvals.tenantId, actor.tenantId),
                eq(schema.approvals.status, 'pending'),
                inArray(schema.approvals.runId, runIds),
              ),
            )
        : [];
    const pendingByRun: Record<string, string> = {};
    for (const pendingApproval of pending) pendingByRun[pendingApproval.runId] = pendingApproval.approvalId;
    return rows.map((row) => toRunSummary(row.run, row.versionNumber, pendingByRun[row.run.runId] ?? null));
  }

  async getRun(actor: ActorContext, runId: string): Promise<RunDetail> {
    const run = await this.#runRow(actor, runId);
    const versionRows = await this.#db
      .select({ versionNumber: schema.workflowVersions.versionNumber })
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.versionId, run.workflowVersionId))
      .limit(1);
    const events = await getRunEvents(this.#db, runId);
    const approval = (await getPendingApproval(this.#db, runId)) ?? (await getDecidedApproval(this.#db, runId));
    return {
      run: toRunSummary(run, versionRows[0]?.versionNumber ?? 1, approval?.status === 'pending' ? approval.approvalId : null),
      events: events.map(toRunEvent),
      approval: approval ? toApproval(approval, run.workflowName) : null,
    };
  }

  async *streamRun(actor: ActorContext, runId: string, signal: AbortSignal): AsyncIterable<RunEvent> {
    await this.#runRow(actor, runId);
    let lastId = 0;
    for (;;) {
      if (signal.aborted) return;
      const events = await getRunEvents(this.#db, runId, lastId);
      for (const row of events) {
        lastId = row.id;
        yield toRunEvent(row);
      }
      if (events.length === 0) {
        const current = await getRunRow(this.#db, runId);
        if (!current || TERMINAL_RUN_STATUSES[current.status]) return;
      }
      await sleepAbortable(POLL_INTERVAL_MS, signal);
    }
  }

  async listApprovals(actor: ActorContext, status?: Approval['status']): Promise<Approval[]> {
    return this.#approvals.list(actor, status);
  }

  async decideApproval(actor: ActorContext, approvalId: string, request: DecisionRequest): Promise<DecisionResponse> {
    return this.#approvals.decide(actor, approvalId, request);
  }

  async simulate(actor: ActorContext, scenario: SimulatorScenario): Promise<SimulatorResponse> {
    return this.#simulator.run(actor, scenario);
  }

  async start(): Promise<void> {
    await ensureStudioTables(this.#context.sql);
    await this.#context.prepare?.();
    await this.#context.queue.start();
    await this.#router.start();
    this.#logger.info('studio engine started');
  }

  async stop(): Promise<void> {
    await this.#router.stop();
    await this.#context.queue.stop();
    await this.#context.queue.close?.();
    await this.#context.dispose?.();
    this.#logger.info('studio engine stopped');
  }

  async #workflowRow(actor: ActorContext, workflowId: string): Promise<WorkflowRow> {
    const rows = await this.#db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workflowId, workflowId), eq(schema.workflows.tenantId, actor.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError(`workflow ${workflowId} not found`);
    return row;
  }

  async #runRow(actor: ActorContext, runId: string): Promise<RunRow> {
    const run = await getRunRow(this.#db, runId);
    if (!run || run.tenantId !== actor.tenantId) throw new NotFoundError(`run ${runId} not found`);
    return run;
  }
}

function workflowSummaryOf(row: WorkflowRow): WorkflowSummary {
  return {
    workflowId: row.workflowId,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    draftVersionNumber: row.draftVersionNumber,
    publishedVersionNumber: row.publishedVersionNumber,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function workflowVersionOf(row: WorkflowVersionRow): WorkflowVersion {
  return {
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    status: row.status as WorkflowVersion['status'],
    definition: row.definition,
    layout: row.layout,
    diagnostics: row.diagnostics,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function assertValid(definition: WorkflowDefinition): Diagnostic[] {
  const diagnostics = validateWorkflow(definition);
  const errors = validationErrors(diagnostics);
  if (errors.length > 0) throw new WorkflowValidationError(errors);
  return diagnostics;
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await promise;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
