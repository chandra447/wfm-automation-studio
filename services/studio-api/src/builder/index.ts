import type { ActorContext } from '@wfm/contracts';
import type { BuilderChatHistory, BuilderChatRequest, BuilderChatResponse } from '@wfm/workflows';
import type { LlmProvider } from '../llm/provider.ts';
import type { LlmServices } from '../llm/index.ts';
import { BuilderAgent } from './agent.ts';
import { BuilderMessageStore, type BuilderDb } from './store.ts';

/**
 * The builder chat's composition root: the agent over the studio database, and
 * the two HTTP operations app.ts wires. Transport and authorization stay with
 * the HTTP layer; this owns the conversation.
 */

export * from './agent.ts';
export * from './store.ts';

/** How many turns the panel reads back. The prompt keeps a shorter window of them. */
const HISTORY_LIMIT = 200;

export interface BuilderRouteHandlers {
  chat: (actor: ActorContext, workflowId: string, request: BuilderChatRequest) => Promise<BuilderChatResponse>;
  history: (actor: ActorContext, workflowId: string) => Promise<BuilderChatHistory>;
}

export function builderRouteHandlers(deps: { db: BuilderDb; llm: LlmServices }): BuilderRouteHandlers {
  const store = new BuilderMessageStore(deps.db);
  const agent = new BuilderAgent({
    db: deps.db,
    llm: deps.llm,
    providerFor: (tenantId, model) => tenantProvider(deps.llm, tenantId, model),
  });

  return {
    chat: (actor, workflowId, request) => agent.chat({ workflowId, tenantId: actor.tenantId, request }),
    history: async (actor, workflowId) => ({
      messages: await store.listTurns(workflowId, actor.tenantId, HISTORY_LIMIT),
    }),
  };
}

/**
 * A turn the studio cannot run at all: no provider for the tenant, or a model
 * outside the catalogue or outside the tenant's provider family. Distinct from
 * a ZodError so the HTTP layer can return the message as written, since the
 * message is the whole value of the error.
 */
export class BuilderRequestError extends Error {
  override readonly name = 'BuilderRequestError';
}

/**
 * The tenant's provider for one turn. A model the catalogue does not list, a
 * model whose vendor differs from the tenant's, and a tenant that has not
 * pointed the studio at a model at all all stop the turn before it reaches a
 * vendor: each is a request error naming what to fix.
 */
async function tenantProvider(llm: LlmServices, tenantId: string, model: string | undefined): Promise<LlmProvider> {
  const settings = await llm.settings.getSettings(tenantId);
  if (model !== undefined) {
    const descriptor = llm.catalogue.modelById(model);
    if (descriptor === undefined) {
      throw new BuilderRequestError(
        `model "${model}" is not declared in config/models.jsonl, which is the studio's allow-list`,
      );
    }
    // A catalogue id from the other family would be sent to this tenant's own
    // vendor, which answers with a 404 that says nothing useful.
    const family = settings.kind === 'anthropic' ? 'anthropic' : 'openai-compatible';
    if (descriptor.provider !== family) {
      throw new BuilderRequestError(
        `model "${model}" is a ${descriptor.provider} model and this tenant's provider is ${settings.kind}; choose an ${family} model`,
      );
    }
  }
  const provider = await llm.settings.resolveProvider(tenantId, model);
  if (provider === null) {
    throw new BuilderRequestError(
      `tenant ${tenantId} has no model provider configured; set one under provider settings before using the builder chat`,
    );
  }
  return provider;
}
