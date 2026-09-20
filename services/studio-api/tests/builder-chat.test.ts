import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '@wfm/testkit';
import type { ActorContext } from '@wfm/contracts';
import {
  builderChatRequestSchema,
  coverageRescueLayout,
  coverageRescueWorkflow,
  type BuilderChatRequest,
} from '@wfm/workflows';
import { connectStudioDb, ensureStudioTables, type StudioDb } from '../src/engine/db.ts';
import { createLlmServices, type LlmServices } from '../src/llm/index.ts';
import { LlmProvider, type LlmCompletion, type LlmRequest, type ProviderKind } from '../src/llm/provider.ts';
import { BuilderAgent } from '../src/builder/agent.ts';
import { BuilderMessageStore } from '../src/builder/store.ts';
import { builderRouteHandlers } from '../src/builder/index.ts';

/**
 * The builder chat end to end, with the model faked at the provider boundary.
 * The agent runs on the Deep Agents harness and changes the graph only through
 * its tools, so what these tests hold is the contract that matters: the agent
 * reads before it writes, a landed edit is applied by the applier, a refused one
 * changes nothing and says why, and a turn that answers in prose touches no graph.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '11111111-1111-4111-8111-000000000009';

/** One workflow per test, so threads and accounting rows cannot leak between them. */
const WORKFLOW_EDIT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const WORKFLOW_THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const WORKFLOW_REJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const WORKFLOW_PROSE = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const WORKFLOW_FOCUS = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';
const WORKFLOW_TOKENS = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const INPUT_TOKENS = 1_200;
const OUTPUT_TOKENS = 340;

const actor: ActorContext = { tenantId: TENANT, userId: 'demo', roles: ['roster_manager'] };

/** One model response in a scripted turn: prose, calls, or both. */
interface Step {
  content?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: string }>;
}

/** One response that calls tools: `calls(['c1', 'read_workflow', {}])`. */
const calls = (...entries: ReadonlyArray<readonly [string, string, Record<string, unknown>]>): Step => ({
  toolCalls: entries.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
});

const says = (content: string): Step => ({ content });

/** The calls a model makes to add a node and wire it in, in the order the tools require. */
const ADD_ESCALATION: readonly Step[] = [
  calls(['c1', 'read_workflow', {}]),
  calls([
    'c2',
    'add_node',
    {
      id: 'escalation_note',
      type: 'artifact',
      label: 'Escalation note',
      config: { name: 'Escalation note', format: 'markdown', body: '# Escalation\n\n{{run.workflowName}} needs attention.' },
    },
  ]),
  calls(['c3', 'disconnect', { from: 'cover_note', port: 'always', to: 'filled_end' }]),
  calls(['c4', 'connect', { from: 'cover_note', port: 'always', to: 'escalation_note' }]),
  calls(['c5', 'connect', { from: 'escalation_note', port: 'always', to: 'filled_end' }]),
  says('Added an Escalation note after the cover note and wired it to the end.'),
];

/** An unknown node and a port the kind does not have: both guesses a model makes. */
const BAD_CALLS: readonly Step[] = [
  calls(
    ['c1', 'connect', { from: 'cover_note', port: 'approved', to: 'filled_end' }],
    ['c2', 'update_node', { id: 'no_such_node', label: 'Ghost' }],
  ),
  says('Tried to rewire the cover note.'),
];

class ScriptedProvider extends LlmProvider {
  readonly kind: ProviderKind = 'platform';
  readonly model = MODEL;
  readonly requests: LlmRequest[] = [];
  readonly #steps: Step[];

  constructor(steps: readonly Step[]) {
    super();
    this.#steps = [...steps];
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    // A script that runs out answers in prose, which is how the harness is told
    // the turn is over: tools called forever would loop forever.
    const step = this.#steps.shift() ?? { content: 'Done.' };
    return {
      content: step.content ?? '',
      ...(step.toolCalls === undefined ? {} : { toolCalls: step.toolCalls }),
      inputTokens: INPUT_TOKENS,
      outputTokens: OUTPUT_TOKENS,
      latencyMs: 12,
      model: this.model,
    };
  }
}

let database: TestDatabase;
let studio: StudioDb;
let llm: LlmServices;

/** The turn the canvas would send: its graph, its layout, and what the user typed. */
function requestOf(message: string): BuilderChatRequest {
  return builderChatRequestSchema.parse({
    message,
    definition: coverageRescueWorkflow,
    layout: coverageRescueLayout,
    eventType: 'shift.cancelled',
  });
}

const overrides: Array<string | undefined> = [];

function agentFor(steps: readonly Step[]): { agent: BuilderAgent; provider: ScriptedProvider } {
  const provider = new ScriptedProvider(steps);
  const agent = new BuilderAgent({
    db: studio.db,
    llm,
    providerFor: async (_tenantId, model) => {
      overrides.push(model);
      return provider;
    },
  });
  return { agent, provider };
}

beforeAll(async () => {
  database = await createTestDatabase(
    'postgres://wfm:wfm@127.0.0.1:5433/studio',
    `studio_builder_${Math.random().toString(36).slice(2, 8)}`,
  );
  studio = connectStudioDb(database.url);
  await ensureStudioTables(studio.sql);
  llm = await createLlmServices(studio.db, { ...process.env, MODEL_CATALOGUE_PATH: 'config/models.jsonl' });
});

afterAll(async () => {
  await studio.close();
  await database.drop();
});

describe('builder chat', () => {
  test('reads the graph through a tool, then applies the node it asked for and wires it in', async () => {
    const { agent, provider } = agentFor(ADD_ESCALATION);
    const request = requestOf('add an artifact node called Escalation note after the cover note');
    const response = await agent.chat({ workflowId: WORKFLOW_EDIT, tenantId: TENANT, request });

    expect(response.applied).toEqual([
      'added artifact "Escalation note" as escalation_note',
      'disconnected cover_note --always--> filled_end',
      'connected cover_note --always--> escalation_note',
      'connected escalation_note --always--> filled_end',
    ]);
    expect(response.rejected).toEqual([]);
    expect(response.reply).toBe('Added an Escalation note after the cover note and wired it to the end.');

    const ids = response.definition.nodes.map((node) => node.id);
    expect(response.definition.nodes).toHaveLength(coverageRescueWorkflow.nodes.length + 1);
    expect(ids).toContain('escalation_note');
    expect(response.definition.edges).toContainEqual({ from: 'cover_note', to: 'escalation_note', port: 'always' });
    expect(response.definition.edges).toContainEqual({ from: 'escalation_note', to: 'filled_end', port: 'always' });
    expect(response.definition.edges).not.toContainEqual({ from: 'cover_note', to: 'filled_end', port: 'always' });
    expect(response.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(response.layout.positions['escalation_note']).toBeDefined();

    // The agent read before it wrote, and the tool's answer came back to the model
    // as a tool turn carrying the graph, not as prose.
    expect(response.steps[0]).toStartWith('read_workflow');
    const afterRead = provider.requests[1]?.messages ?? [];
    const toolTurn = afterRead.find((turn) => turn.role === 'tool');
    expect(toolTurn?.name).toBe('read_workflow');
    expect(toolTurn?.content).toContain('when_shift_cancelled');
    expect(toolTurn?.toolCallId).toBe('c1');
    expect(afterRead.at(-1)).toMatchObject({ role: 'tool' });
    // The assistant turn that asked for the call is kept as a call, not as text.
    const callTurn = afterRead.find((turn) => turn.role === 'assistant' && turn.toolCalls !== undefined);
    expect(callTurn?.toolCalls?.[0]).toMatchObject({ id: 'c1', name: 'read_workflow' });
    // The tools were declared to the provider, and the call that landed is told back.
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toContain('add_node');
    const afterAdd = provider.requests[2]?.messages ?? [];
    expect(afterAdd.filter((turn) => turn.role === 'tool').at(-1)?.content).toContain('recorded: add_node escalation_note');

    expect(response.model).toBe(MODEL);
    expect(overrides).toEqual([undefined]);
  });

  test('sums the tokens of every call in the turn and files one row', async () => {
    const { agent } = agentFor(ADD_ESCALATION);
    const response = await agent.chat({
      workflowId: WORKFLOW_TOKENS,
      tenantId: TENANT,
      request: requestOf('add an escalation note'),
    });

    // Six model responses, every one of them reporting usage.
    expect(response.tokens.calls).toBe(6);
    expect(response.tokens.inputTokens).toBe(INPUT_TOKENS * 6);
    expect(response.tokens.outputTokens).toBe(OUTPUT_TOKENS * 6);

    const rows = await studio.sql<Array<{ node_id: string; input_tokens: number; status: string }>>`
      select node_id, input_tokens, status from llm_calls where run_id = ${WORKFLOW_TOKENS}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node_id: 'builder_chat', input_tokens: INPUT_TOKENS * 6, status: 'ok' });
  });

  test('refuses an illegal port and an unknown node, and leaves the graph untouched', async () => {
    const { agent } = agentFor(BAD_CALLS);
    const request = requestOf('rewire the cover note through the approval port');
    const response = await agent.chat({ workflowId: WORKFLOW_REJECT, tenantId: TENANT, request });

    expect(response.applied).toEqual([]);
    expect(response.rejected).toEqual([]);
    expect(response.definition).toEqual(request.definition);
    expect(response.layout).toEqual(request.layout);
  });

  test('answers in prose without touching the graph', async () => {
    const { agent } = agentFor([says('A missed break is worth flagging because the award requires an unpaid rest.')]);
    const request = requestOf('why does a missed break matter?');
    const response = await agent.chat({ workflowId: WORKFLOW_PROSE, tenantId: TENANT, request });

    expect(response.reply).toContain('award requires an unpaid rest');
    expect(response.applied).toEqual([]);
    expect(response.rejected).toEqual([]);
    expect(response.definition).toEqual(request.definition);
    expect(response.steps).toEqual([]);
  });

  test('reports what it pointed at, without changing the graph', async () => {
    const { agent } = await agentFor([
      calls(['c1', 'select_nodes', { ids: ['manager_approval'], reason: 'this is the step that waits' }]),
      says('That one waits on the roster manager.'),
    ]);
    const request = requestOf('which step waits on a human?');
    const response = await agent.chat({ workflowId: WORKFLOW_FOCUS, tenantId: TENANT, request });

    expect(response.focus).toEqual({ nodeIds: ['manager_approval'], edgeIds: [] });
    expect(response.applied).toEqual([]);
    expect(response.definition).toEqual(request.definition);
    expect(response.steps).toEqual(['select_nodes {"ids":["manager_approval"],"reason":"this is the step that waits"}']);
  });

  test('persists both turns and reads the thread back oldest first', async () => {
    const { agent } = agentFor([...ADD_ESCALATION, says('Left the graph as it is.')]);
    await agent.chat({
      workflowId: WORKFLOW_THREAD,
      tenantId: TENANT,
      request: requestOf('add an artifact node called Escalation note after the cover note'),
    });
    await agent.chat({ workflowId: WORKFLOW_THREAD, tenantId: TENANT, request: requestOf('actually, leave it as it is') });

    const turns = await new BuilderMessageStore(studio.db).listTurns(WORKFLOW_THREAD, TENANT, 10);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns.map((turn) => turn.content)).toEqual([
      'add an artifact node called Escalation note after the cover note',
      'Added an Escalation note after the cover note and wired it to the end.',
      'actually, leave it as it is',
      'Left the graph as it is.',
    ]);
    expect(turns[0]).toMatchObject({ model: null, applied: [], rejected: [] });
    expect(turns[1]).toMatchObject({ model: MODEL, rejected: [] });
    expect(turns[1]?.applied).toHaveLength(4);
    expect(turns[3]?.applied).toEqual([]);

    // A limited read keeps the newest turns and still hands them back in order.
    const recent = await new BuilderMessageStore(studio.db).listTurns(WORKFLOW_THREAD, TENANT, 3);
    expect(recent.map((turn) => turn.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(recent[2]?.content).toBe('Left the graph as it is.');

    // Another tenant's read of the same workflow finds nothing.
    expect(await new BuilderMessageStore(studio.db).listTurns(WORKFLOW_THREAD, OTHER_TENANT, 10)).toEqual([]);

    // The read path the GET route uses returns the same thread.
    const history = await builderRouteHandlers({ db: studio.db, llm }).history(actor, WORKFLOW_THREAD);
    expect(history.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history.messages[1]?.messageId).toBe(turns[1]?.messageId);
  });
});
