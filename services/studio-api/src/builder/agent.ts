import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createDeepAgent, createSummarizationMiddleware, StateBackend } from 'deepagents';
import { z } from 'zod';
import type { ModelDescriptor, TokenUsage } from '@wfm/contracts';
import type { BuilderChatMessage, BuilderChatResponse, BuilderChatRequest } from '@wfm/workflows';
import { applyOperations, validateWorkflow } from '@wfm/workflows';
import { createLogger } from '@wfm/observability';
import type { LlmServices } from '../llm/index.ts';
import type { LlmProvider } from '../llm/provider.ts';
import { BuilderChatModel } from './chat-model.ts';
import { kindLines } from './catalogue.ts';
import { BuilderMessageStore, type BuilderDb } from './store.ts';
import { builderTools, type BuilderToolContext } from './tools.ts';

/**
 * The builder's agent, running on the Deep Agents harness: the model is given
 * tools and decides for itself what to read, what to point at, and what to
 * change. It cannot change the graph directly — the write tools collect
 * operations and the applier in @wfm/workflows judges the list — so an agent
 * with tools still cannot produce a definition the DSL rejects.
 *
 * The turn is stateless with respect to the harness. The conversation lives in
 * `builder_messages` and the recent turns are handed over in the prompt, so
 * there is one record of what was said rather than a checkpointer's copy and
 * ours drifting apart.
 */

const PROMPT_TURNS = 12;
const TOKENS_PER_PRICE_UNIT = 1_000_000;
const STEP_ARGUMENT_LIMIT = 120;

/**
 * A turn is a dozen model calls over a prompt that carries the kind catalogue,
 * so a conversation that keeps its whole history re-sends all of it every time.
 * These are the numbers a measured turn justified: one live turn cost 137k
 * input tokens, most of it tool results the agent had already read.
 */
const SUMMARIZE_AFTER_TOKENS = 60_000;
const KEEP_RECENT_MESSAGES = 20;
const TRUNCATE_ARGUMENTS_AFTER_TOKENS = 30_000;
const KEEP_ARGUMENTS_FOR_MESSAGES = 12;
const MAX_TOOL_ARGUMENT_CHARS = 4_000;

/**
 * The summarization middleware, with thresholds rather than the harness's
 * defaults: those are computed from a model profile, and our models are
 * described by our own catalogue, not by a profile LangChain ships.
 *
 * The summary is written by the same model that is answering, so no second
 * provider has to resolve, and the history it replaces is offloaded to the
 * harness's own backend: state, not disk.
 */
function summarization() {
  return createSummarizationMiddleware({
    // The backend factory is typed as a union the harness resolves; state-backed
    // is the arm that keeps history in agent state rather than on disk.
    backend: () => new StateBackend(),
    trigger: { type: 'tokens', value: SUMMARIZE_AFTER_TOKENS },
    keep: { type: 'messages', value: KEEP_RECENT_MESSAGES },
    truncateArgsSettings: {
      trigger: { type: 'tokens', value: TRUNCATE_ARGUMENTS_AFTER_TOKENS },
      keep: { type: 'messages', value: KEEP_ARGUMENTS_FOR_MESSAGES },
      maxLength: MAX_TOOL_ARGUMENT_CHARS,
    },
  });
}

/** Where a builder call is filed in the accounting table: no run exists, so the workflow stands in. */
const BUILDER_NODE_ID = 'builder_chat';

export interface BuilderAgentDeps {
  db: BuilderDb;
  llm: LlmServices;
  /** The tenant's provider, with this turn's model override when it asked for one. */
  providerFor: (tenantId: string, model?: string) => Promise<LlmProvider>;
}

export interface BuilderChatInput {
  workflowId: string;
  tenantId: string;
  request: BuilderChatRequest;
}

export class BuilderAgent {
  readonly #store: BuilderMessageStore;
  readonly #llm: LlmServices;
  readonly #providerFor: BuilderAgentDeps['providerFor'];

  constructor(deps: BuilderAgentDeps) {
    this.#store = new BuilderMessageStore(deps.db);
    this.#llm = deps.llm;
    this.#providerFor = deps.providerFor;
  }

  async chat(input: BuilderChatInput): Promise<BuilderChatResponse> {
    const { workflowId, tenantId, request } = input;
    const history = await this.#store.listTurns(workflowId, tenantId, PROMPT_TURNS);
    // Resolved before anything is stored: a turn the studio cannot run, because
    // the tenant has no provider or asked for a model outside the catalogue, is
    // a request error and must not leave an unanswered question in the thread.
    const provider = await this.#providerFor(tenantId, request.model);
    // Past this point the turn is real, so the message the agent was given is
    // stored before the call: a model that never answers still leaves what it saw.
    await this.#store.appendTurn({
      workflowId,
      tenantId,
      role: 'user',
      content: request.message,
      model: null,
      applied: [],
      rejected: [],
    });

    const context = buildContext(request, this.#llm);
    const agent = createDeepAgent({
      model: new BuilderChatModel({ provider }),
      tools: builderTools(context),
      systemPrompt: systemPrompt(this.#llm.catalogue.models()),
      middleware: [summarization()],
    });

    const started = Date.now();
    let messages: BaseMessage[];
    try {
      const result = await agent.invoke({ messages: [new HumanMessage(userContent(request, history))] });
      messages = result.messages;
    } catch (error) {
      await this.#record(provider, { tenantId, workflowId }, undefined, 'error');
      throw error;
    }

    const usage = usageOf(messages, provider, Date.now() - started);
    await this.#record(provider, { tenantId, workflowId }, usage, 'ok');

    const outcome = applyOperations(request.definition, request.layout, context.proposed);
    const reply = replyFor(messages, outcome.applied.length, outcome.rejected.length);

    await this.#store.appendTurn({
      workflowId,
      tenantId,
      role: 'assistant',
      content: reply,
      model: provider.model,
      applied: outcome.applied,
      rejected: outcome.rejected,
    });

    return {
      reply,
      definition: outcome.definition,
      layout: outcome.layout,
      applied: outcome.applied,
      rejected: outcome.rejected,
      diagnostics: outcome.diagnostics,
      focus: context.focus,
      steps: stepsOf(messages),
      model: provider.model,
      tokens: usageOfTokens(usage, this.#llm.catalogue.modelById(provider.model)),
    };
  }

  /** A failed turn is recorded as well as a successful one: the spend is real either way. */
  async #record(
    provider: LlmProvider,
    where: { tenantId: string; workflowId: string },
    usage: TurnUsage | undefined,
    status: 'ok' | 'error',
  ): Promise<void> {
    await this.#llm.accounting.recordCall({
      tenantId: where.tenantId,
      runId: where.workflowId,
      nodeId: BUILDER_NODE_ID,
      providerKind: provider.kind,
      model: provider.model,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      latencyMs: usage?.latencyMs ?? 0,
      status,
    });
  }
}

const logger = createLogger('builder-agent');

/**
 * The graph the tools read and the list they write to. The definition comes
 * from the canvas rather than from the draft, because the user may have dragged
 * or edited something the autosave has not sent yet.
 */
function buildContext(request: BuilderChatRequest, llm: LlmServices): BuilderToolContext {
  const trigger = request.definition.nodes.find((node) => node.type === 'trigger');
  return {
    definition: request.definition,
    layout: request.layout,
    eventType: request.eventType ?? (trigger?.type === 'trigger' ? trigger.config.eventType : undefined),
    models: llm.catalogue.models(),
    diagnostics: validateWorkflow(request.definition),
    proposed: [],
    focus: { nodeIds: [], edgeIds: [] },
  };
}

function systemPrompt(models: readonly ModelDescriptor[]): string {
  return [
    'You are the workflow builder inside the WFM Automation Studio. You change the workflow graph the user is looking at by calling the tools you have been given. The platform applies what you propose, validates the result, and tells you what it refused.',
    '',
    'How to work:',
    '- Read before you write. Call read_workflow to see what is on the canvas, and get_node when you need one node in full.',
    '- Before adding or reconfiguring a node, call list_node_kinds for its ports and the config keys it accepts, so you propose values the platform takes.',
    '- Before writing any {{...}} template, call read_data_catalogue so the path exists at save time.',
    '- The graph must be valid when you finish: exactly one trigger node, and every path reaching an end node. A node you add must be wired in the same turn. The write tools tell you when the graph is not valid yet; keep working until they stop saying so.',
    '- Positions belong to the user. Call move_node only when they ask you to move something.',
    '- Call select_nodes and select_edges to point at what you are talking about. It changes nothing; it is how the user sees which step you mean.',
    '- Prefer updating an existing node over adding a near-duplicate of it.',
    '- If the message is a question, or asks for something these tools cannot express, answer it and change nothing.',
    '',
    'When you are done, reply in one or two sentences: what you changed and why. No markdown, no code fences, no JSON.',
    '',
    'Kinds available to you, for reference. list_node_kinds reports the same thing with the current values:',
    kindLines(models).join('\n'),
  ].join('\n');
}

/**
 * What the agent is handed: the thread so far and the new message. The graph is
 * not pasted in, because reading it is the agent's first tool call and the tools
 * answer with what is on the canvas right now.
 */
function userContent(request: BuilderChatRequest, history: readonly BuilderChatMessage[]): string {
  const thread = history.map((turn) => {
    const changes = [
      ...turn.applied,
      ...turn.rejected.map((rejection) => `refused ${rejection.op} ${rejection.target}: ${rejection.reason}`),
    ];
    return changes.length === 0
      ? `${turn.role}: ${turn.content}`
      : `${turn.role}: ${turn.content}\n  ${changes.join('\n  ')}`;
  });

  return [
    `Workflow: ${request.definition.name}`,
    ...(thread.length === 0 ? [] : ['', 'The thread so far:', ...thread]),
    '',
    `New message: ${request.message}`,
  ].join('\n');
}

/** The tools the agent called, in order, as the transcript shows them. */
function stepsOf(messages: readonly BaseMessage[]): string[] {
  const steps: string[] = [];
  for (const message of messages) {
    if (!(message instanceof AIMessage)) continue;
    for (const call of message.tool_calls ?? []) {
      const args = JSON.stringify(call.args ?? {});
      steps.push(`${call.name} ${args.length > STEP_ARGUMENT_LIMIT ? `${args.slice(0, STEP_ARGUMENT_LIMIT)}…` : args}`);
    }
  }
  return steps;
}

/** The agent's last words, or an account of the turn when it produced none. */
function replyFor(messages: readonly BaseMessage[], appliedCount: number, refusedCount: number): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof AIMessage)) continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (text.trim() !== '') return text.trim();
  }
  if (appliedCount === 0 && refusedCount === 0) return 'I made no change to the graph.';
  return `Applied ${appliedCount} change(s) and refused ${refusedCount}.`;
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  latencyMs: number;
}

/**
 * A tool-using turn is several model calls, so the turn's tokens are the sum of
 * its messages' own usage reports rather than one call's. The report arrives
 * from the vendor through the harness, so it is parsed rather than assumed.
 */
function usageOf(messages: readonly BaseMessage[], provider: LlmProvider, latencyMs: number): TurnUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  for (const message of messages) {
    if (!(message instanceof AIMessage)) continue;
    const parsed = usageMetadataSchema.safeParse(message.usage_metadata);
    if (!parsed.success) continue;
    inputTokens += parsed.data.input_tokens;
    outputTokens += parsed.data.output_tokens;
    calls += 1;
  }
  if (calls === 0) logger.warn({ model: provider.model }, 'a builder turn reported no token usage');
  return { inputTokens, outputTokens, calls, latencyMs };
}

const usageMetadataSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
});

/** The turn's spend, priced from the same catalogue every other view reads. */
function usageOfTokens(usage: TurnUsage, price: ModelDescriptor | undefined): TokenUsage {
  const cents =
    price === undefined
      ? 0
      : (usage.inputTokens * price.inputCentsPerMillion + usage.outputTokens * price.outputCentsPerMillion) /
        TOKENS_PER_PRICE_UNIT;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls: usage.calls,
    estimatedCostCents: Math.round(cents * 1e6) / 1e6,
  };
}
