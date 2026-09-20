import { cors } from '@elysiajs/cors';
import {
  ActorContextError,
  apiError,
  createWorkflowBodySchema,
  errorCodes,
  parseActorContext,
  type ActorContext,
} from '@wfm/contracts';
import { emptyLayout, workflowDefinitionSchema, WorkflowValidationError, type CanvasLayout } from '@wfm/workflows';
import { Elysia, t } from 'elysia';
import { ZodError } from 'zod';
import type { EngineService, SaveWorkflowRequest } from './engine/contract.ts';
import { engineOf } from './engine/runtime.ts';
import { createEngineFromEnv } from './engine/index.ts';
import { createLlmServices, llmRouteHandlers, type LlmRouteHandlers } from './llm/index.ts';
import { connectStudioDb } from './engine/db.ts';
import { dashboardHandler } from './dashboard/index.ts';

/**
 * Transport only. Every handler parses the actor, delegates to the engine, and
 * maps domain errors to status codes. Logic lives in engine/**.
 */

function actorOf(headers: Record<string, string | undefined>): ActorContext {
  return parseActorContext(headers);
}

const definitionBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  description: t.Optional(t.String({ maxLength: 500 })),
  enabled: t.Optional(t.Boolean()),
  nodes: t.Array(t.Any()),
  edges: t.Array(t.Any()),
});

const layoutBody = t.Object({
  viewport: t.Object({ x: t.Number(), y: t.Number(), zoom: t.Number() }),
  positions: t.Record(t.String(), t.Object({ x: t.Number(), y: t.Number() })),
});

const providerSettingsBody = t.Object({
  kind: t.Union([t.Literal('platform'), t.Literal('openai-compatible'), t.Literal('anthropic'), t.Literal('none')]),
  baseUrl: t.Optional(t.String({ maxLength: 400 })),
  apiKey: t.Optional(t.String({ minLength: 8, maxLength: 400 })),
  model: t.Optional(t.String({ maxLength: 200 })),
});

const workflowBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  description: t.Optional(t.String({ maxLength: 500 })),
  enabled: t.Optional(t.Boolean()),
  definition: t.Optional(definitionBody),
  layout: t.Optional(layoutBody),
  fromWorkflowId: t.Optional(t.String({ format: 'uuid' })),
});

/**
 * The canvas posts loose JSON; the DSL schema is the boundary. Parsing here
 * means the engine only ever sees a WorkflowDefinition it can trust.
 */
function toSaveRequest(body: {
  name: string;
  description?: string;
  enabled?: boolean;
  definition?: { name?: string; description?: string; enabled?: boolean; nodes: unknown[]; edges: unknown[] };
  layout?: { viewport: CanvasLayout['viewport']; positions: CanvasLayout['positions'] };
}): SaveWorkflowRequest {
  if (body.definition === undefined) {
    throw new Error('workflow body must carry a definition');
  }
  const definition = workflowDefinitionSchema.parse({
    name: body.definition.name ?? body.name,
    description: body.definition.description ?? body.description ?? '',
    enabled: body.definition.enabled ?? body.enabled ?? true,
    nodes: body.definition.nodes,
    edges: body.definition.edges,
  });
  return {
    name: body.name,
    description: body.description ?? '',
    enabled: body.enabled ?? true,
    definition,
    layout: body.layout ?? emptyLayout(),
  };
}

/** The model layer, built once per process from the studio database. */
let llmHandlersPromise: Promise<LlmRouteHandlers> | null = null;
function llmHandlers(): Promise<LlmRouteHandlers> {
  llmHandlersPromise ??= createLlmServices(
    connectStudioDb(process.env.STUDIO_DATABASE_URL ?? '').db,
    process.env,
  ).then(llmRouteHandlers);
  return llmHandlersPromise;
}

export const app = new Elysia()
  .use(cors())
  .onError(({ error, set }) => {
    if (error instanceof ActorContextError) {
      set.status = 401;
      return apiError(errorCodes.invalidActorContext, error.message);
    }
    if (error instanceof WorkflowValidationError) {
      set.status = 422;
      return { error: { code: 'WORKFLOW_INVALID', message: error.message, details: { diagnostics: error.diagnostics } } };
    }
    if (error instanceof ZodError) {
      set.status = 422;
      return apiError(errorCodes.validation, 'Request body failed schema validation', {
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('forbidden:')) {
      set.status = 403;
      return apiError(errorCodes.forbidden, message.slice('forbidden:'.length).trim());
    }
    set.status = message.includes('not found') ? 404 : 500;
    return apiError(message.includes('not found') ? errorCodes.notFound : errorCodes.validation, message);
  })
  .get('/health', () => ({ status: 'ok', service: 'studio-api' }))
  .get('/triggers', async () => (await engineOf(createEngineFromEnv)).listTriggers())
  .get('/workflows', async ({ headers }) => (await engineOf(createEngineFromEnv)).listWorkflows(actorOf(headers)))
  .get('/workflows/:workflowId', async ({ headers, params }) =>
    (await engineOf(createEngineFromEnv)).getWorkflow(actorOf(headers), params.workflowId),
  )
  .post(
    '/workflows',
    async ({ headers, body }) => {
      const engine = await engineOf(createEngineFromEnv);
      const actor = actorOf(headers);
      const source = body as { fromWorkflowId?: unknown };
      if (typeof source.fromWorkflowId === 'string') {
        const from = createWorkflowBodySchema.parse(body);
        if (!('fromWorkflowId' in from)) throw new Error('workflow body failed schema validation');
        return engine.createWorkflowFrom(actor, {
          name: from.name,
          ...(from.description === undefined ? {} : { description: from.description }),
          fromWorkflowId: from.fromWorkflowId,
          ...(from.versionNumber === undefined ? {} : { versionNumber: from.versionNumber }),
        });
      }
      return engine.createWorkflow(actor, toSaveRequest(body));
    },
    { body: workflowBody },
  )
  .put(
    '/workflows/:workflowId/draft',
    async ({ headers, params, body }) =>
      (await engineOf(createEngineFromEnv)).saveDraft(actorOf(headers), params.workflowId, toSaveRequest(body)),
    { body: workflowBody },
  )
  .post('/workflows/:workflowId/publish', async ({ headers, params }) =>
    (await engineOf(createEngineFromEnv)).publishWorkflow(actorOf(headers), params.workflowId),
  )
  .delete('/workflows/:workflowId', async ({ headers, params }) => {
    await (await engineOf(createEngineFromEnv)).deleteWorkflow(actorOf(headers), params.workflowId);
    return { deleted: true };
  })
  .get('/runs', async ({ headers, query }) =>
    (await engineOf(createEngineFromEnv)).listRuns(actorOf(headers), {
      ...(query.workflowId ? { workflowId: String(query.workflowId) } : {}),
      ...(query.status ? { status: String(query.status) as never } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    }),
  )
  .get('/runs/:runId', async ({ headers, params }) =>
    (await engineOf(createEngineFromEnv)).getRun(actorOf(headers), params.runId),
  )
  .get('/runs/:runId/stream', async function* streamRun({ headers, params, request }) {
    const engine: EngineService = await engineOf(createEngineFromEnv);
    const controller = new AbortController();
    request.signal.addEventListener('abort', () => controller.abort());
    for await (const event of engine.streamRun(actorOf(headers), params.runId, controller.signal)) {
      yield `data: ${JSON.stringify(event)}\n\n`;
    }
  })
  .get('/approvals', async ({ headers, query }) =>
    (await engineOf(createEngineFromEnv)).listApprovals(
      actorOf(headers),
      query.status ? (String(query.status) as never) : undefined,
    ),
  )
  .post(
    '/approvals/:approvalId/decision',
    async ({ headers, params, body }) =>
      (await engineOf(createEngineFromEnv)).decideApproval(actorOf(headers), params.approvalId, body),
    { body: t.Object({ decision: t.Union([t.Literal('approve'), t.Literal('reject')]), reason: t.String({ minLength: 1, maxLength: 500 }) }) },
  )
  .post('/simulator/:scenario', async ({ headers, params }) =>
    (await engineOf(createEngineFromEnv)).simulate(actorOf(headers), params.scenario as never),
  )
  .get('/models', async () => (await llmHandlers()).models())
  .get('/provider-settings', async ({ headers }) =>
    (await llmHandlers()).providerSettings(actorOf(headers).tenantId),
  )
  .put(
    '/provider-settings',
    async ({ headers, body }) => {
      const actor = actorOf(headers);
      return (await llmHandlers()).saveProviderSettings(actor.tenantId, body, actor.userId);
    },
    { body: providerSettingsBody },
  )
  .get('/dashboard', async ({ headers }) => dashboardHandler(headers))
  .get('/artifacts/:artifactId', async ({ headers, params }) =>
    (await engineOf(createEngineFromEnv)).getArtifact(actorOf(headers), params.artifactId),
  )
  .get('/data-catalogue', async ({ headers, query }) =>
    (await engineOf(createEngineFromEnv)).dataCatalogue(actorOf(headers), String(query.eventType ?? 'shift.cancelled')),
  );

export type StudioApi = typeof app;
