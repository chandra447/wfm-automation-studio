import { z } from 'zod';
import { triggerCatalog, type ModelDescriptor, type TokenUsage } from '@wfm/contracts';
import {
  applyOperations,
  builderOperationSchema,
  commandCatalog,
  defaultNodeOf,
  fieldsOf,
  isNode,
  kindFor,
  legalPortsByNodeType,
  nodePalette,
  toolCatalog,
  type BuilderChatMessage,
  type BuilderChatRequest,
  type BuilderChatResponse,
  type BuilderOperation,
  type ControlSource,
  type FieldSpec,
  type OperationOutcome,
} from '@wfm/workflows';
import { buildDataCatalogue } from '../engine/data-catalogue.ts';
import type { LlmServices } from '../llm/index.ts';
import type { LlmCompletion, LlmProvider } from '../llm/provider.ts';
import { BuilderMessageStore, type BuilderDb } from './store.ts';

/**
 * The builder's agent. It reads the graph the canvas is showing, asks the
 * tenant's model for a reply and a list of operations, and hands that list to
 * the applier in @wfm/workflows. The model proposes; the applier decides what a
 * graph may become, so nothing here can write a definition the DSL rejects.
 *
 * The definition in the request is the whole state of the conversation. The
 * canvas is the system of record, so a turn reasons about what is on the screen
 * right now, including nodes the user dragged by hand.
 */

const PROMPT_TURNS = 12;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Where a builder call is filed in the accounting table: no run exists, so the workflow stands in. */
const BUILDER_NODE_ID = 'builder_chat';

const UNREADABLE_REPLY = "I could not read the model's answer, so the graph is unchanged.";

/** The operation list, mirroring the six shapes builderOperationSchema accepts. */
const OPERATION_LINES: readonly string[] = [
  '{ "op": "add_node", "id": string, "type": <kind>, "label"?: string, "config"?: object, "position"?: { "x": number, "y": number }, "note"?: string }',
  '{ "op": "update_node", "id": string, "label"?: string, "config"?: object, "note"?: string }',
  '{ "op": "remove_node", "id": string, "note"?: string }',
  '{ "op": "move_node", "id": string, "position": { "x": number, "y": number }, "note"?: string }',
  '{ "op": "connect", "from": { "node": string, "port": <port> }, "to": string, "note"?: string }',
  '{ "op": "disconnect", "from": { "node": string, "port": <port> }, "to": string, "note"?: string }',
];

/** The id a kind's defaults are read under; it never reaches a prompt. */
const CATALOGUE_PLACEHOLDER_ID = 'example';

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
  /** Built once: the palette and the contract do not change between turns. */
  readonly #system: string;

  constructor(deps: BuilderAgentDeps) {
    this.#store = new BuilderMessageStore(deps.db);
    this.#llm = deps.llm;
    this.#providerFor = deps.providerFor;
    this.#system = systemPrompt(deps.llm.catalogue.models());
  }

  async chat(input: BuilderChatInput): Promise<BuilderChatResponse> {
    const { workflowId, tenantId, request } = input;
    const history = await this.#store.listTurns(workflowId, tenantId, PROMPT_TURNS);
    // The user's turn is stored before the model is called, so a turn that never
    // answers still leaves the message the agent was given.
    await this.#store.appendTurn({
      workflowId,
      tenantId,
      role: 'user',
      content: request.message,
      model: null,
      applied: [],
      rejected: [],
    });

    const provider = await this.#providerFor(tenantId, request.model);
    const completion = await this.#complete(provider, { tenantId, workflowId }, {
      system: this.#system,
      user: userContent(request, history),
    });

    const answer = readAnswer(completion.content);
    const outcome = applyOperations(request.definition, request.layout, answer?.operations ?? []);
    const reply = replyFor(answer, outcome);

    await this.#store.appendTurn({
      workflowId,
      tenantId,
      role: 'assistant',
      content: reply,
      model: completion.model,
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
      model: completion.model,
      tokens: usageOf(completion, this.#llm.catalogue.modelById(completion.model)),
    };
  }

  /** A failed turn is recorded as well as a successful one: the spend is real either way. */
  async #complete(
    provider: LlmProvider,
    where: { tenantId: string; workflowId: string },
    prompt: { system: string; user: string },
  ): Promise<LlmCompletion> {
    let completion: LlmCompletion;
    try {
      completion = await provider.complete(prompt);
    } catch (error) {
      await this.#record(provider, where, undefined, 'error');
      throw error;
    }
    await this.#record(provider, where, completion, 'ok');
    return completion;
  }

  async #record(
    provider: LlmProvider,
    where: { tenantId: string; workflowId: string },
    completion: LlmCompletion | undefined,
    status: 'ok' | 'error',
  ): Promise<void> {
    await this.#llm.accounting.recordCall({
      tenantId: where.tenantId,
      runId: where.workflowId,
      nodeId: BUILDER_NODE_ID,
      providerKind: provider.kind,
      model: completion?.model ?? provider.model,
      inputTokens: completion?.inputTokens ?? 0,
      outputTokens: completion?.outputTokens ?? 0,
      latencyMs: completion?.latencyMs ?? 0,
      status,
    });
  }
}

interface ModelAnswer {
  reply: string;
  operations: BuilderOperation[];
}

const modelAnswerSchema = z.object({
  reply: z.string().default(''),
  operations: z.array(builderOperationSchema).default([]),
});

/**
 * A model that wrapped its JSON in prose or fences is still usable, so the
 * outermost object is taken out of whatever it sent. An answer that is not an
 * object at all is a turn with no edit rather than an error: the caller gets a
 * reply that says so and the graph it already had.
 */
function readAnswer(content: string): ModelAnswer | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let body: unknown;
  try {
    body = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = modelAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** The model's own words, or a plain account of what happened when it sent none. */
function replyFor(answer: ModelAnswer | null, outcome: OperationOutcome): string {
  if (answer === null) return UNREADABLE_REPLY;
  if (answer.reply.trim() !== '') return answer.reply;
  if (outcome.applied.length === 0 && outcome.rejected.length === 0) return 'I made no change to the graph.';
  return `Applied ${outcome.applied.length} change(s) and refused ${outcome.rejected.length}.`;
}

/**
 * This turn's own call. The accounting row feeds the tenant and workflow totals;
 * the response reports the call the user just paid for, priced from the same
 * catalogue and by the same formula.
 */
function usageOf(completion: LlmCompletion, price: ModelDescriptor | undefined): TokenUsage {
  const cents =
    price === undefined
      ? 0
      : (completion.inputTokens * price.inputCentsPerMillion +
          completion.outputTokens * price.outputCentsPerMillion) /
        TOKENS_PER_PRICE_UNIT;
  return {
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    calls: 1,
    estimatedCostCents: Math.round(cents * 1e6) / 1e6,
  };
}

function systemPrompt(models: readonly ModelDescriptor[]): string {
  return [
    'You are the workflow builder inside the WFM Automation Studio. You change the workflow graph the user is looking at by proposing a short list of operations. The platform applies them, validates the result, and reports what it refused, so propose only changes you would defend.',
    '',
    'Rules you cannot break:',
    '- The graph must still be valid after your edit: exactly one trigger node, and every path must still reach an end node.',
    '- A node you add must be wired into the graph in the same turn, or the whole edit is dropped.',
    '- Use only the node kinds, config keys and ports listed below. An unknown key or an illegal port is refused, with the list of what the kind accepts.',
    '- Positions belong to the user. Move a node only when the message asks you to.',
    '- Prefer updating an existing node over adding a near-duplicate of it.',
    '- If the message is a question, or asks for something these operations cannot express, answer it in `reply` and return no operations.',
    '',
    'Node kinds:',
    ...kindLines(models),
    '',
    'Answer with one JSON object and nothing else:',
    '{ "reply": string, "operations": Operation[] }',
    '`reply` is one or two sentences to the user: what you changed and why. No markdown, no code fences.',
    'Each operation is exactly one of:',
    ...OPERATION_LINES,
    'Return an empty operations list when nothing should change.',
  ].join('\n');
}

/**
 * The palette as prose, derived from the same declarations the canvas reads, so
 * a kind added tomorrow teaches the agent about it with no prompt edit. The
 * values a config key accepts come from the kind's own schema, and the option
 * lists that live in the platform's catalogues are resolved alongside it.
 */
function kindLines(models: readonly ModelDescriptor[]): string[] {
  const sources: Partial<Record<ControlSource, readonly string[]>> = {
    triggerEvents: triggerCatalog().map((trigger) => trigger.eventType),
    // A command's input fields are the config the model must write for it, so the
    // id is offered together with the fields the chosen command requires.
    commands: commandCatalog.map(
      (command) => `${command.id} (input fields: ${command.inputs.map((input) => input.field).join(', ')})`,
    ),
    tools: toolCatalog.map((tool) => tool.id),
    models: models.map((model) => model.id),
  };
  return nodePalette.flatMap((entry) => {
    const shape: z.ZodRawShape = kindFor(entry.type).schema.shape;
    const defaults = defaultNodeOf(entry.type, CATALOGUE_PLACEHOLDER_ID).config;
    return [
      `- ${entry.type} — "${entry.label}": ${entry.description}`,
      `  ports: ${legalPortsByNodeType[entry.type].join(', ') || 'none (terminal)'}`,
      '  config keys:',
      ...fieldsOf(entry.type).map((field) => {
        const declared = shape[field.key];
        // A key wrapped in `.optional()` or `.default()` may be left out, and the
        // applier merges what is left with the kind's own defaults.
        const optional = declared instanceof z.ZodOptional || declared instanceof z.ZodDefault;
        const template = field.template === true ? ', {{...}} allowed' : '';
        const allowed = allowedValuesFor(shape, field, sources);
        const values = allowed.length === 0 ? '' : ` — one of: ${allowed.join(', ')}`;
        return `    ${field.key} (${field.control.kind}, ${optional ? 'optional' : 'required'}${template}): ${field.label}${values}`;
      }),
      `  default config: ${JSON.stringify(defaults)}`,
    ];
  });
}

/**
 * The values a config key accepts: the kind's own enum when the key has one,
 * otherwise the catalogue its control names. The applier refuses anything else,
 * so the model is told exactly what will be taken.
 */
function allowedValuesFor(
  shape: z.ZodRawShape,
  field: FieldSpec,
  sources: Partial<Record<ControlSource, readonly string[]>>,
): readonly string[] {
  const declared = enumValuesOf(shape, field.key);
  if (declared.length > 0) return declared;
  if (field.control.kind !== 'select' && field.control.kind !== 'checklist') return [];
  const { options, optionsFrom } = field.control;
  if (options !== undefined) return options.map((option) => option.value);
  return optionsFrom === undefined ? [] : (sources[optionsFrom] ?? []);
}

/** An enum config key's legal values, unwrapped from the array or default around it. */
function enumValuesOf(shape: z.ZodRawShape, key: string): readonly string[] {
  let declared = shape[key];
  while (declared instanceof z.ZodArray || declared instanceof z.ZodOptional || declared instanceof z.ZodDefault) {
    declared = declared.unwrap();
  }
  return declared instanceof z.ZodEnum
    ? declared.options.filter((value): value is string => typeof value === 'string')
    : [];
}

function userContent(request: BuilderChatRequest, history: readonly BuilderChatMessage[]): string {
  const trigger = request.definition.nodes.find((node) => isNode(node, 'trigger'));
  const eventType = request.eventType ?? trigger?.config.eventType;
  // The paths a template may name, one line each, grouped by the root they hang off.
  const fields =
    eventType === undefined
      ? []
      : buildDataCatalogue(eventType).roots.flatMap((root) => [
          `${root.label}:`,
          ...root.paths.map(
            (path) =>
              `  {{${path.path}}}: ${path.label} (${path.type})${path.sample === '' ? '' : `, e.g. ${path.sample}`}`,
          ),
        ]);
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
    'The graph on the canvas now:',
    JSON.stringify(request.definition),
    '',
    'Where the canvas has placed its nodes:',
    JSON.stringify(request.layout.positions),
    '',
    `Trigger event: ${eventType ?? 'none set'}`,
    ...(fields.length === 0 ? [] : ['', 'Fields a template can bind to, as {{...}}:', ...fields]),
    '',
    ...(thread.length === 0 ? [] : ['The thread so far:', ...thread, '']),
    `New message: ${request.message}`,
  ].join('\n');
}
