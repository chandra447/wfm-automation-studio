import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { InMemoryEventBus } from '@wfm/eventbus';
import { createLogger } from '@wfm/observability';
import { createTestDatabase, type TestDatabase } from '@wfm/testkit';
import type { AnyWfmEvent } from '@wfm/contracts';
import { candidateChoiceOutputSchema, coverageRescueWorkflow, type AgentNode } from '@wfm/workflows';
import { connectStudioDb, ensureStudioTables, type StudioDb } from '../src/engine/db.ts';
import { createLlmServices } from '../src/llm/index.ts';
import type { LlmAccounting } from '../src/llm/accounting.ts';
import { LlmProvider } from '../src/llm/provider.ts';
import type { LlmCompletion, LlmRequest, ProviderKind } from '../src/llm/provider.ts';
import type { ExecutorDeps } from '../src/engine/nodes/context.ts';
import type { RunScope, RunStateFields } from '../src/engine/state.ts';
import { RulesProposer } from '../src/engine/nodes/proposers.ts';
import { ResolvingAgentRunner, type AgentRunner } from '../src/engine/nodes/agent-runner.ts';
import { runAgentNode } from '../src/engine/nodes/agent.ts';
import { readDomainTool } from '../src/engine/nodes/domain-tools.ts';
import { getRunEvents, toRunEvent } from '../src/engine/run-store.ts';
import { BEST_FIT_ID, EXPENSIVE_ID, SHIFT_ID, stubDomainClients, TENANT, TIMESHEET_ID, timesheetFixture } from './helpers.ts';

/**
 * The agent node end to end over the real loop, with the model faked at the
 * provider boundary and the real database behind the audit, event and
 * accounting writes. What these hold is the contract that matters: the agent
 * calls the tools its author declared and no others, its answer is validated
 * against the node's output schema and policy-filtered, the whole loop is one
 * accounting row, the tool trail survives into the run event, and a tenant with
 * no provider fails instead of silently proposing something deterministic.
 */

const MODEL = 'deepseek/deepseek-v4.1-flash';
const INPUT_TOKENS = 120;
const OUTPUT_TOKENS = 40;

const agentNode: AgentNode = {
  id: 'cover_shift',
  type: 'agent',
  label: 'Cover the cancelled shift',
  config: {
    goal: 'Decide who to offer this cancelled shift to, looking up the shift and its candidates first.',
    tools: ['shift.get', 'shift.candidates'],
    output: 'candidate_choice',
    mustCiteEvidence: true,
    maxSteps: 6,
  },
};

/** One model response in the loop: prose, explicit tool calls, or the output. */
interface Step {
  content?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: string }>;
  /** Call the runtime's structured-output tool with these arguments. */
  output?: Record<string, unknown>;
}

const calls = (...entries: ReadonlyArray<readonly [string, string, Record<string, unknown>]>): Step => ({
  toolCalls: entries.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
});

const says = (content: string): Step => ({ content });

/**
 * A scripted transport. The structured-output tool is named by the runtime
 * (`extract-N`), so a step that answers with structured output calls whichever
 * offered tool is not one the node declared.
 */
class ScriptedProvider extends LlmProvider {
  readonly kind: ProviderKind = 'platform';
  readonly model = MODEL;
  readonly requests: LlmRequest[] = [];
  readonly #steps: Step[];
  readonly #declared: ReadonlySet<string>;

  constructor(steps: readonly Step[], declared: readonly string[]) {
    super();
    this.#steps = [...steps];
    this.#declared = new Set(declared);
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    const step = this.#steps.shift() ?? { content: 'Done.' };
    const toolCalls = step.output === undefined ? step.toolCalls : this.#outputCall(request, step.output);
    return {
      content: step.content ?? '',
      ...(toolCalls === undefined ? {} : { toolCalls }),
      inputTokens: INPUT_TOKENS,
      outputTokens: OUTPUT_TOKENS,
      latencyMs: 5,
      model: this.model,
    };
  }

  #outputCall(request: LlmRequest, output: Record<string, unknown>): LlmCompletion['toolCalls'] {
    const extract = request.tools?.find((spec) => !this.#declared.has(spec.name));
    if (extract === undefined) throw new Error('the runtime offered no structured-output tool');
    return [{ id: `output_${this.requests.length}`, name: extract.name, arguments: JSON.stringify(output) }];
  }
}

let database: TestDatabase;
let studio: StudioDb;
let accounting: LlmAccounting;

const logger = createLogger('agent-node-test', 'warn');

const shiftEvent: AnyWfmEvent = {
  eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000090',
  eventType: 'shift.cancelled',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  tenantId: TENANT,
  aggregate: { type: 'shift', id: SHIFT_ID },
  actor: null,
  correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000090',
  causationId: null,
  traceparent: null,
  payload: {
    shiftId: SHIFT_ID,
    locationId: '33333333-3333-4333-8333-000000000001',
    startsAt: '2026-09-21T04:00:00.000Z',
    hoursUntilStart: 7.5,
    reason: 'test',
    cancelledByEmployeeId: null,
    requiredQualificationCodes: ['RN'],
    roleName: 'Registered Nurse',
  },
};

/** The timesheet exception event, which carries its own award rule code. */
const exceptionEvent: AnyWfmEvent = {
  eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000091',
  eventType: 'timesheet.exception_raised',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  tenantId: TENANT,
  aggregate: { type: 'timesheet', id: TIMESHEET_ID },
  actor: null,
  correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000091',
  causationId: null,
  traceparent: null,
  payload: {
    timesheetId: TIMESHEET_ID,
    employeeId: BEST_FIT_ID,
    shiftId: null,
    exceptionType: 'missed_break',
    awardRuleCode: 'MA000034',
    detail: 'Unpaid 30 minute break not recorded',
    overtimeMinutes: 75,
    estimatedPayImpactCents: 8_240,
  },
};

/** A run id per test, so audit rows, events and accounting rows cannot leak. */
function stateFor(runId: string): RunStateFields {
  return {
    runId,
    tenantId: TENANT,
    definition: coverageRescueWorkflow,
    event: shiftEvent,
    nodes: {},
    messages: [],
    cursor: '',
    decision: null,
  };
}

function scopeFor(runId: string): RunScope {
  return {
    runId,
    tenantId: TENANT,
    workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099',
    workflowVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000098',
    workflowName: 'Agent node test',
    correlationId: runId,
    triggerEventId: shiftEvent.eventId,
    dryRun: false,
  };
}

function depsFor(agent: AgentRunner | null): ExecutorDeps {
  return {
    db: studio.db,
    bus: new InMemoryEventBus(),
    clients: stubDomainClients(),
    queue: {
      enqueueRunStart: async () => {},
      enqueueRunStep: async () => {},
      scheduleApprovalTimeout: async () => {},
      start: async () => {},
      stop: async () => {},
    },
    proposer: new RulesProposer(),
    agent,
    logger,
  };
}

function runnerFor(provider: LlmProvider | null): ResolvingAgentRunner {
  return new ResolvingAgentRunner({
    settings: { resolveProvider: async () => provider },
    accounting,
  });
}

const VALID_CHOICE: Record<string, unknown> = {
  // The expensive candidate is ineligible (high overtime risk), so the node
  // must drop it and move the top pick to the survivor.
  employeeIds: [EXPENSIVE_ID, BEST_FIT_ID],
  topCandidateId: EXPENSIVE_ID,
  costDeltaCents: 5_000,
  rationale: 'Picked from the candidates in the tool data.',
  evidence: [{ label: 'Candidates read', value: 'three' }],
};

async function llmRows(runId: string): Promise<Array<{ node_id: string; input_tokens: number; output_tokens: number; status: string }>> {
  return studio.sql<Array<{ node_id: string; input_tokens: number; output_tokens: number; status: string }>>`
    select node_id, input_tokens, output_tokens, status from llm_calls where run_id = ${runId}`;
}

beforeAll(async () => {
  database = await createTestDatabase(
    'postgres://wfm:wfm@127.0.0.1:5433/studio',
    `studio_agent_${Math.random().toString(36).slice(2, 8)}`,
  );
  studio = connectStudioDb(database.url);
  await ensureStudioTables(studio.sql);
  const llm = await createLlmServices(studio.db, { ...process.env, MODEL_CATALOGUE_PATH: 'config/models.jsonl' });
  accounting = llm.accounting;
});

afterAll(async () => {
  await studio.close();
  await database.drop();
});

describe('agent node', () => {
  test('calls a declared tool, feeds the result back to the model, and returns a schema-valid filtered proposal', async () => {
    const provider = new ScriptedProvider(
      [calls(['c1', 'shift.candidates', {}]), { output: VALID_CHOICE }],
      agentNode.config.tools,
    );
    const runId = crypto.randomUUID();
    const result = await runAgentNode(scopeFor(runId), depsFor(runnerFor(provider)), agentNode, stateFor(runId));

    const output = candidateChoiceOutputSchema.parse(result.nodes[agentNode.id]?.output);
    expect(output.employeeIds).toEqual([BEST_FIT_ID]);
    expect(output.topCandidateId).toBe(BEST_FIT_ID);

    // The declared tools were offered, and the tool's answer came back as a
    // tool turn carrying the candidate list, not as prose.
    const offered = provider.requests[0]?.tools?.map((spec) => spec.name) ?? [];
    expect(offered).toContain('shift.get');
    expect(offered).toContain('shift.candidates');
    const toolTurn = provider.requests[1]?.messages?.find((turn) => turn.role === 'tool');
    expect(toolTurn?.name).toBe('shift.candidates');
    expect(toolTurn?.content).toContain(BEST_FIT_ID);
  });

  test('never offers the model a tool the node did not declare', async () => {
    const singleToolNode: AgentNode = { ...agentNode, config: { ...agentNode.config, tools: ['shift.get'] } };
    const provider = new ScriptedProvider(
      [calls(['c1', 'shift.get', {}]), { output: { ...VALID_CHOICE, employeeIds: [BEST_FIT_ID], topCandidateId: BEST_FIT_ID } }],
      singleToolNode.config.tools,
    );
    const runId = crypto.randomUUID();
    await runAgentNode(scopeFor(runId), depsFor(runnerFor(provider)), singleToolNode, stateFor(runId));

    // Everything offered is the declared tool plus the runtime's own
    // structured-output tool; no other domain read is reachable.
    const offered = provider.requests[0]?.tools?.map((spec) => spec.name) ?? [];
    const domainTools = offered.filter((name) => name !== 'extract' && !name.startsWith('extract-'));
    expect(domainTools).toEqual(['shift.get']);
    for (const undeclared of ['shift.candidates', 'employee.availability', 'timesheet.get', 'award_rule.get']) {
      expect(offered).not.toContain(undeclared);
    }
  });

  test('retries an unusable reply once and then fails loudly', async () => {
    const provider = new ScriptedProvider(
      [calls(['c1', 'shift.get', {}]), says('I could not decide from what I read.'), says('Still undecided.')],
      agentNode.config.tools,
    );
    const runId = crypto.randomUUID();
    const deps = depsFor(runnerFor(provider));

    await runAgentNode(scopeFor(runId), deps, agentNode, stateFor(runId)).then(
      () => {
        throw new Error('the agent node should have refused an unusable reply');
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain(agentNode.label);
        expect(message).toContain('unusable candidate_choice');
      },
    );

    // The first attempt's tool call and prose, then the single retry.
    expect(provider.requests).toHaveLength(3);
    const retryTurn = provider.requests[2]?.messages?.find(
      (turn) => turn.role === 'user' && turn.content.includes('did not match the required output'),
    );
    expect(retryTurn).toBeDefined();

    const rows = await llmRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node_id: agentNode.id, status: 'error', input_tokens: INPUT_TOKENS * 3 });
  });

  test('sums a multi-call loop into one accounting row', async () => {
    const provider = new ScriptedProvider(
      [calls(['c1', 'shift.get', {}]), calls(['c2', 'shift.candidates', {}]), { output: VALID_CHOICE }],
      agentNode.config.tools,
    );
    const runId = crypto.randomUUID();
    await runAgentNode(scopeFor(runId), depsFor(runnerFor(provider)), agentNode, stateFor(runId));

    const rows = await llmRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      node_id: agentNode.id,
      status: 'ok',
      input_tokens: INPUT_TOKENS * 3,
      output_tokens: OUTPUT_TOKENS * 3,
    });
  });

  test('carries the tool trail in call order into the run event', async () => {
    const provider = new ScriptedProvider(
      [calls(['c1', 'shift.candidates', {}]), calls(['c2', 'shift.get', {}]), { output: VALID_CHOICE }],
      agentNode.config.tools,
    );
    const runId = crypto.randomUUID();
    await runAgentNode(scopeFor(runId), depsFor(runnerFor(provider)), agentNode, stateFor(runId));

    const events = (await getRunEvents(studio.db, runId)).map(toRunEvent);
    const proposal = events.find((event) => event.kind === 'proposal_created');
    expect(proposal?.nodeId).toBe(agentNode.id);
    expect(proposal?.data).toMatchObject({ proposer: 'agent', toolTrail: ['shift.candidates', 'shift.get'] });
  });

  test('resolves the goal’s {{...}} references before the model sees them', async () => {
    const goalNode: AgentNode = {
      ...agentNode,
      config: { ...agentNode.config, goal: 'Offer shift {{input.payload.shiftId}} to the best candidate.' },
    };
    const provider = new ScriptedProvider(
      [{ output: { ...VALID_CHOICE, employeeIds: [BEST_FIT_ID], topCandidateId: BEST_FIT_ID } }],
      goalNode.config.tools,
    );
    const runId = crypto.randomUUID();
    await runAgentNode(scopeFor(runId), depsFor(runnerFor(provider)), goalNode, stateFor(runId));

    const prompt = (provider.requests[0]?.messages ?? []).map((turn) => turn.content).join('\n');
    expect(prompt).toContain(`Offer shift ${SHIFT_ID} to the best candidate.`);
    expect(prompt).not.toContain('{{');
  });

  test('a tenant with no provider fails the node instead of proposing deterministically', async () => {
    const runId = crypto.randomUUID();
    const providerless = runnerFor(null);

    await runAgentNode(scopeFor(runId), depsFor(providerless), agentNode, stateFor(runId)).then(
      () => {
        throw new Error('the agent node should have refused to run without a provider');
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain(agentNode.label);
        expect(message).toContain('has no model provider configured');
        expect(message).toContain('Configure a provider for this tenant');
      },
    );

    // Nothing was proposed, audited or billed: a loop with no model has no
    // deterministic equivalent to fall back to.
    expect(await llmRows(runId)).toEqual([]);
    expect(await getRunEvents(studio.db, runId)).toEqual([]);

    // The same refusal when the engine itself was built without a model layer.
    await runAgentNode(scopeFor(crypto.randomUUID()), depsFor(null), agentNode, stateFor(runId)).then(
      () => {
        throw new Error('the agent node should have refused to run without a runner');
      },
      (error: unknown) => {
        expect(error instanceof Error ? error.message : String(error)).toContain('has no model provider configured');
      },
    );
  });
});

describe('domain tool ordering', () => {
  test('award_rule.get reads its code from the event, then an already-read timesheet, and never throws', async () => {
    const requested: string[] = [];
    const clients = stubDomainClients();
    clients.attendance.getAwardRule = async (_tenantId, ruleCode) => {
      requested.push(ruleCode);
      return timesheetFixture.awardRule;
    };
    const deps: ExecutorDeps = { ...depsFor(null), clients };
    const scope = scopeFor(crypto.randomUUID());
    const nodeId = agentNode.id;

    // Called before timesheet.get: the event's own awardRuleCode is used.
    const fromEvent = await readDomainTool({
      nodeId,
      toolId: 'award_rule.get',
      scope,
      deps,
      state: { ...stateFor(scope.runId), event: exceptionEvent },
      fetched: {},
    });
    expect(requested).toEqual(['MA000034']);
    expect(fromEvent).toMatchObject({ ruleCode: 'MA000034' });

    // No code on the event, but the timesheet was read first: the timesheet's
    // own award rule answers.
    const readTimesheet = {
      ...timesheetFixture,
      awardRule: { ...timesheetFixture.awardRule, ruleCode: 'MA000099' },
    };
    await readDomainTool({
      nodeId,
      toolId: 'award_rule.get',
      scope,
      deps,
      state: stateFor(scope.runId),
      fetched: { 'timesheet.get': readTimesheet },
    });
    expect(requested).toEqual(['MA000034', 'MA000099']);

    // Neither source has a code: an error object, not a thrown error.
    const nothing = await readDomainTool({
      nodeId,
      toolId: 'award_rule.get',
      scope,
      deps,
      state: stateFor(scope.runId),
      fetched: {},
    });
    expect(nothing).toEqual({ error: 'no award rule code available on shift.cancelled' });
  });
});
