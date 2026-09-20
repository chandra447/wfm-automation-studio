import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeEvent } from '@wfm/contracts';
import { waitFor } from '@wfm/testkit';
import type { AiDecisionNode, CanvasLayout, WorkflowDefinition } from '@wfm/workflows';
import { getApprovalRow } from '../src/engine/run-store.ts';
import {
  LlmProposer,
  RulesProposer,
  type Proposer,
  type ProposerInput,
  type ProposerResult,
} from '../src/engine/nodes/proposers.ts';
import type { RunMessage } from '../src/engine/state.ts';
import { LlmProvider, type LlmCompletion, type LlmRequest } from '../src/llm/provider.ts';
import { BEST_FIT_ID, candidatesFixture, createHarness, managerActor, SHIFT_ID, TENANT } from './helpers.ts';
import type { Harness } from './helpers.ts';

/**
 * Steering: a human decision that says more than yes or no. The note is stored
 * on the approval, announced on the approval_decided event, appended to the
 * run's messages as a human turn, handed to every later proposer, and readable
 * as {{run.feedback}}.
 */

/** Captures the steering the engine hands each proposal, then defers to the rules proposer. */
class RecordingProposer implements Proposer {
  readonly calls: Array<{ runId: string; nodeId: string; steering: readonly RunMessage[] }> = [];
  readonly #inner = new RulesProposer();

  async propose(input: ProposerInput): Promise<ProposerResult> {
    this.calls.push({ runId: input.runId, nodeId: input.node.id, steering: input.steering });
    return this.#inner.propose(input);
  }
}

const steeringWorkflow: WorkflowDefinition = {
  name: 'Steer a coverage decision',
  description: 'Ranks candidates, asks a manager, then re-decides with whatever the manager told the run.',
  enabled: true,
  nodes: [
    {
      id: 'when_shift_cancelled',
      type: 'trigger',
      label: 'When a shift is cancelled',
      config: { eventType: 'shift.cancelled', conditions: [] },
    },
    {
      id: 'rank_candidates',
      type: 'ai_decision',
      label: 'Rank eligible employees',
      config: {
        goal: 'Choose the employees to offer this shift to, cheapest first.',
        tools: ['shift.get', 'shift.candidates'],
        output: 'candidate_choice',
        mustCiteEvidence: true,
      },
    },
    {
      id: 'manager_approval',
      type: 'human_approval',
      label: 'Roster manager decision',
      config: {
        role: 'roster_manager',
        timeoutMinutes: 240,
        escalateTo: 'operations_lead',
        show: ['rationale', 'evidence', 'payImpact'],
      },
    },
    {
      id: 'revise_offers',
      type: 'ai_decision',
      label: 'Re-rank with the manager note',
      config: {
        goal: 'Re-rank the offer list, following any instruction the reviewer sent this run.',
        tools: ['shift.get', 'shift.candidates'],
        output: 'candidate_choice',
        mustCiteEvidence: true,
      },
    },
    {
      id: 'cover_note',
      type: 'artifact',
      label: 'Cover note',
      config: {
        name: 'Coverage note',
        format: 'markdown',
        body: '# Coverage\n\nReviewer instruction: {{run.feedback}}',
      },
    },
    { id: 'filled_end', type: 'end', label: 'Offers sent', config: { outcome: 'completed' } },
    { id: 'stopped_end', type: 'end', label: 'Left for manual cover', config: { outcome: 'needs_attention' } },
  ],
  edges: [
    { from: 'when_shift_cancelled', to: 'rank_candidates', port: 'always' },
    { from: 'rank_candidates', to: 'manager_approval', port: 'always' },
    { from: 'manager_approval', to: 'revise_offers', port: 'approved' },
    { from: 'manager_approval', to: 'stopped_end', port: 'rejected' },
    { from: 'revise_offers', to: 'cover_note', port: 'always' },
    { from: 'cover_note', to: 'filled_end', port: 'always' },
  ],
};

const steeringLayout: CanvasLayout = {
  viewport: { x: 0, y: 0, zoom: 0.85 },
  positions: {
    when_shift_cancelled: { x: 0, y: 160 },
    rank_candidates: { x: 300, y: 160 },
    manager_approval: { x: 600, y: 160 },
    revise_offers: { x: 900, y: 160 },
    cover_note: { x: 1200, y: 160 },
    filled_end: { x: 1500, y: 160 },
    stopped_end: { x: 900, y: 400 },
  },
};

const proposer = new RecordingProposer();

let harness: Harness;
let workflowId: string;

const cancelledPayload = {
  shiftId: SHIFT_ID,
  locationId: '33333333-3333-4333-8333-000000000001',
  startsAt: '2026-09-21T04:00:00.000Z',
  hoursUntilStart: 7.5,
  reason: 'Sick leave',
  cancelledByEmployeeId: '44444444-4444-4444-8444-000000000001',
  requiredQualificationCodes: ['RN'],
  roleName: 'Registered Nurse',
};

/** Publishes a cancellation and waits until its run is paused on the manager's decision. */
async function pausedRun(reason: string): Promise<{ runId: string; approvalId: string }> {
  const event = makeEvent('shift.cancelled', { ...cancelledPayload, reason }, { tenantId: TENANT });
  await harness.bus.publish(TENANT, event);
  const runId = await waitFor(
    async () => {
      const runs = await harness.engine.listRuns(managerActor, { workflowId, limit: 100 });
      return runs.find((run) => run.triggerEventId === event.eventId)?.runId ?? null;
    },
    { description: 'run created' },
  );
  await waitFor(
    async () => {
      const detail = await harness.engine.getRun(managerActor, runId);
      return detail.run.status === 'awaiting_approval' ? runId : null;
    },
    { description: 'run awaiting approval' },
  );
  const detail = await harness.engine.getRun(managerActor, runId);
  const approvalId = detail.run.pendingApprovalId;
  if (!approvalId) throw new Error('approval not pending');
  return { runId, approvalId };
}

async function artifactContentOf(runId: string, nodeId: string): Promise<string> {
  const detail = await harness.engine.getRun(managerActor, runId);
  const artifact = detail.output.artifacts.find((candidate) => candidate.nodeId === nodeId);
  if (!artifact) throw new Error(`run ${runId} produced no artifact at ${nodeId}`);
  const rendered = await harness.engine.getArtifact(managerActor, artifact.artifactId);
  return rendered.content;
}

beforeAll(async () => {
  harness = await createHarness({ proposer });
  const created = await harness.engine.createWorkflow(managerActor, {
    name: steeringWorkflow.name,
    description: steeringWorkflow.description,
    enabled: true,
    definition: steeringWorkflow,
    layout: steeringLayout,
  });
  workflowId = created.workflowId;
  await harness.engine.publishWorkflow(managerActor, workflowId);
  await harness.engine.start();
});

afterAll(async () => {
  await harness.engine.stop();
  await harness.drop();
});

describe('approval steering', () => {
  test('a decision with feedback stores it on the row and announces it on the approval_decided event', async () => {
    const { runId, approvalId } = await pausedRun('Sick leave, steering case');
    const feedback = 'Offer this to the expensive nurse anyway: we need medication cover tonight.';

    const decision = await harness.engine.decideApproval(managerActor, approvalId, {
      decision: 'approve',
      reason: 'Cover required tonight',
      feedback,
    });
    expect(decision.status).toBe('approved');
    expect(decision.runStatus).toBe('succeeded');

    const row = await getApprovalRow(harness.db, approvalId);
    expect(row?.feedback).toBe(feedback);

    const detail = await harness.engine.getRun(managerActor, runId);
    const decidedEvent = detail.events.find((event) => event.kind === 'approval_decided');
    expect(decidedEvent?.data).toEqual({
      approvalId,
      decision: 'approved',
      decidedBy: managerActor.userId,
      feedback,
    });
    expect(detail.approval?.feedback).toBe(feedback);
  });

  test('the steering becomes one human message that the next ai_decision node proposes with', async () => {
    const { runId, approvalId } = await pausedRun('Sick leave, proposer case');
    const feedback = 'Prefer the cheapest eligible nurse; overtime is already over budget.';

    await harness.engine.decideApproval(managerActor, approvalId, {
      decision: 'approve',
      reason: 'Cover required tonight',
      feedback,
    });

    const before = proposer.calls.find((call) => call.runId === runId && call.nodeId === 'rank_candidates');
    expect(before?.steering).toEqual([]);
    const after = proposer.calls.find((call) => call.runId === runId && call.nodeId === 'revise_offers');
    expect(after?.steering).toEqual([
      {
        role: 'human',
        content: feedback,
        at: expect.any(String),
        nodeId: 'manager_approval',
        approvalId,
        actor: managerActor.userId,
      },
    ]);
  });

  test('{{run.feedback}} in a downstream node renders the most recent human message', async () => {
    const { runId, approvalId } = await pausedRun('Sick leave, template case');
    const feedback = 'Ask Dana first — she has the medication qualification.';

    await harness.engine.decideApproval(managerActor, approvalId, {
      decision: 'approve',
      reason: 'Cover required tonight',
      feedback,
    });

    expect(await artifactContentOf(runId, 'cover_note')).toBe(`# Coverage\n\nReviewer instruction: ${feedback}`);
  });

  test('a decision without feedback appends no message and renders {{run.feedback}} empty', async () => {
    const { runId, approvalId } = await pausedRun('Sick leave, silent case');

    await harness.engine.decideApproval(managerActor, approvalId, {
      decision: 'approve',
      reason: 'Cover required tonight',
    });

    const row = await getApprovalRow(harness.db, approvalId);
    expect(row?.feedback).toBeNull();
    const after = proposer.calls.find((call) => call.runId === runId && call.nodeId === 'revise_offers');
    expect(after?.steering).toEqual([]);
    expect(await artifactContentOf(runId, 'cover_note')).toBe('# Coverage\n\nReviewer instruction: ');
  });
});

/** A model transport that answers like one and keeps the prompt it was sent. */
class PromptRecordingProvider extends LlmProvider {
  readonly kind = 'openai-compatible';
  readonly model = 'recording-model';
  readonly prompts: string[] = [];

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.prompts.push(request.user);
    return {
      content: JSON.stringify({
        employeeIds: [BEST_FIT_ID],
        topCandidateId: BEST_FIT_ID,
        costDeltaCents: 5_000,
        rationale: 'Recording provider kept the top candidate from the tool data.',
        evidence: [{ label: 'Candidates', value: 'from the tool data' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      model: this.model,
    };
  }
}

const promptNode: AiDecisionNode = {
  id: 'revise_offers',
  type: 'ai_decision',
  label: 'Re-rank with the manager note',
  config: {
    goal: 'Re-rank the offer list, following any instruction the reviewer sent this run.',
    tools: ['shift.get', 'shift.candidates'],
    output: 'candidate_choice',
    mustCiteEvidence: true,
  },
};

describe('steering in the model prompt', () => {
  test('the reviewer note is quoted into the prompt, and only when there is one', async () => {
    const provider = new PromptRecordingProvider();
    const llmProposer = new LlmProposer(provider);
    const steering: RunMessage[] = [
      {
        role: 'human',
        content: 'Prefer the cheapest eligible nurse;\novertime is already over budget.',
        at: new Date().toISOString(),
        nodeId: 'manager_approval',
        approvalId: '99999999-9999-4999-8999-000000000001',
        actor: 'manager@demo.test',
      },
    ];
    const input: ProposerInput = {
      runId: '99999999-9999-4999-8999-000000000002',
      node: promptNode,
      event: makeEvent('shift.cancelled', cancelledPayload, { tenantId: TENANT }),
      data: { 'shift.candidates': candidatesFixture },
      steering,
    };

    const result = await llmProposer.propose(input);
    expect(result.proposer).toBe('llm');
    const prompt = provider.prompts[0] ?? '';
    expect(prompt).toContain(
      '--- BEGIN HUMAN REVIEWER INSTRUCTION ---\n' +
        '> Prefer the cheapest eligible nurse;\n' +
        '> overtime is already over budget.\n' +
        '--- END HUMAN REVIEWER INSTRUCTION ---',
    );
    expect(prompt).toContain('takes precedence over your default ranking');
    // Last, so the reviewer's instruction is the final thing the model reads.
    expect(prompt.indexOf('HUMAN REVIEWER INSTRUCTION')).toBeGreaterThan(
      prompt.indexOf('Respond with the structured output'),
    );

    await llmProposer.propose({ ...input, steering: [] });
    expect(provider.prompts[1] ?? '').not.toContain('HUMAN REVIEWER');
  });
});
