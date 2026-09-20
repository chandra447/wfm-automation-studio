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
 * What the test is really holding is the contract the applier promises a model:
 * a good edit lands, a bad one is refused with a reason and changes nothing, and
 * an answer that cannot be read is a reply rather than a crash.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '11111111-1111-4111-8111-000000000009';

/** One workflow per test, so threads and accounting rows cannot leak between them. */
const WORKFLOW_EDIT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const WORKFLOW_THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const WORKFLOW_REJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const WORKFLOW_GARBAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const INPUT_TOKENS = 1_200;
const OUTPUT_TOKENS = 340;

const actor: ActorContext = { tenantId: TENANT, userId: 'demo', roles: ['roster_manager'] };

/** What the fake model answers when it is asked to add a node and wire it in. */
const ADD_ESCALATION = JSON.stringify({
  reply: 'Added an Escalation note after the cover note and wired it to the end.',
  operations: [
    { op: 'disconnect', from: { node: 'cover_note', port: 'always' }, to: 'filled_end' },
    {
      op: 'add_node',
      id: 'escalation_note',
      type: 'artifact',
      label: 'Escalation note',
      config: {
        name: 'Escalation note',
        format: 'markdown',
        body: '# Escalation\n\n{{run.workflowName}} needs attention.',
      },
    },
    { op: 'connect', from: { node: 'cover_note', port: 'always' }, to: 'escalation_note' },
    { op: 'connect', from: { node: 'escalation_note', port: 'always' }, to: 'filled_end' },
  ],
});

/** An unknown node and a port the kind does not have: both guesses a model makes. */
const BAD_OPERATIONS = JSON.stringify({
  reply: 'Tried to rewire the cover note.',
  operations: [
    { op: 'connect', from: { node: 'cover_note', port: 'approved' }, to: 'filled_end' },
    { op: 'update_node', id: 'no_such_node', label: 'Ghost' },
  ],
});

const NO_CHANGE = JSON.stringify({ reply: 'Left the graph as it is.', operations: [] });
const GARBAGE = 'Sorry — here is a haiku: nodes drift like autumn leaves.';

class CannedProvider extends LlmProvider {
  readonly kind: ProviderKind = 'platform';
  readonly model = MODEL;
  readonly requests: LlmRequest[] = [];
  readonly #answer: string;

  constructor(answer: string) {
    super();
    this.#answer = answer;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    return {
      content: this.#answer,
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
const providers: CannedProvider[] = [];

function agentFor(...answers: readonly string[]): BuilderAgent {
  let turn = 0;
  return new BuilderAgent({
    db: studio.db,
    llm,
    providerFor: async (_tenantId, model) => {
      overrides.push(model);
      // One answer per turn, the last one repeating if the test asks for more.
      const provider = new CannedProvider(answers[turn++] ?? answers.at(-1) ?? '');
      providers.push(provider);
      return provider;
    },
  });
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
  test('applies the node the model asked for, wires it in, and reports the call', async () => {
    const agent = agentFor(ADD_ESCALATION);
    const request = requestOf('add an artifact node called Escalation note after the cover note');
    const response = await agent.chat({ workflowId: WORKFLOW_EDIT, tenantId: TENANT, request });

    expect(response.applied).toEqual([
      'disconnected cover_note --always--> filled_end',
      'added artifact "Escalation note" as escalation_note',
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
    // The node the model added lands somewhere the canvas can draw it.
    expect(response.layout.positions['escalation_note']).toBeDefined();

    expect(response.model).toBe(MODEL);
    expect(response.tokens).toEqual({
      inputTokens: INPUT_TOKENS,
      outputTokens: OUTPUT_TOKENS,
      calls: 1,
      estimatedCostCents: expect.closeTo(0.0384, 6),
    });

    const calls = await studio.sql<Array<{ run_id: string; node_id: string; model: string; input_tokens: number }>>`
      select run_id, node_id, model, input_tokens from llm_calls where run_id = ${WORKFLOW_EDIT}`;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ node_id: 'builder_chat', model: MODEL, input_tokens: INPUT_TOKENS });

    // The turn carries the canvas's own graph, the paths a template can bind to
    // for that trigger event, and the message the user just sent.
    const prompt = providers.at(-1)?.requests.at(0);
    expect(prompt?.user).toContain(JSON.stringify(request.definition));
    expect(prompt?.user).toContain(JSON.stringify(request.layout.positions));
    expect(prompt?.user).toContain('{{input.payload.shiftId}}');
    expect(prompt?.user).toContain(`New message: ${request.message}`);
    expect(prompt?.system).toContain('"op": "connect"');
    expect(overrides).toEqual([undefined]);
  });

  test('persists both turns and reads the thread back oldest first', async () => {
    const agent = agentFor(ADD_ESCALATION, NO_CHANGE);
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

  test('refuses an unknown node and an illegal port, and leaves the graph untouched', async () => {
    const agent = agentFor(BAD_OPERATIONS);
    const request = requestOf('rewire the cover note through the approval port');
    const response = await agent.chat({ workflowId: WORKFLOW_REJECT, tenantId: TENANT, request });

    expect(response.applied).toEqual([]);
    expect(response.rejected.map((rejection) => rejection.op)).toEqual(['connect', 'update_node']);
    expect(response.rejected[0]?.reason).toContain('no "approved" port');
    expect(response.rejected[0]?.reason).toContain('always');
    expect(response.rejected[1]?.reason).toBe('no node "no_such_node"');

    expect(response.definition).toEqual(request.definition);
    expect(response.layout).toEqual(request.layout);
  });

  test('answers an unreadable model response with a reply and no graph change', async () => {
    const agent = agentFor(GARBAGE);
    const request = requestOf('add an escalation note');
    const response = await agent.chat({ workflowId: WORKFLOW_GARBAGE, tenantId: TENANT, request });

    expect(response.reply).toContain('could not read');
    expect(response.applied).toEqual([]);
    expect(response.rejected).toEqual([]);
    expect(response.definition).toEqual(request.definition);
    expect(response.tokens.calls).toBe(1);
  });
});
