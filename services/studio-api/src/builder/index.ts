import { ZodError } from 'zod';
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
 * The tenant's provider for one turn. A model the catalogue does not list, and a
 * tenant that has not pointed the studio at a model at all, both stop the turn
 * before it reaches a vendor: each is a request error naming what to fix.
 */
async function tenantProvider(llm: LlmServices, tenantId: string, model: string | undefined): Promise<LlmProvider> {
  if (model !== undefined && llm.catalogue.modelById(model) === undefined) {
    throw new ZodError([
      {
        code: 'custom',
        path: ['model'],
        message: `model "${model}" is not declared in config/models.jsonl, which is the studio's allow-list`,
      },
    ]);
  }
  const provider = await llm.settings.resolveProvider(tenantId, model);
  if (provider === null) {
    throw new ZodError([
      {
        code: 'custom',
        path: [],
        message: `tenant ${tenantId} has no model provider configured; set one under provider settings before using the builder chat`,
      },
    ]);
  }
  return provider;
}
