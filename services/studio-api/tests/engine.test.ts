import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MemorySaver } from '@langchain/langgraph';
import { makeEvent, type AnyWfmEvent } from '@wfm/contracts';
import { compileWorkflow, coverageRescueLayout, coverageRescueWorkflow } from '@wfm/workflows';
import { waitFor } from '@wfm/testkit';
import { buildRunGraph } from '../src/engine/graph.ts';
import {
  BEST_FIT_ID,
  createHarness,
  managerActor,
  peopleOpsActor,
  recorded,
  SHIFT_ID,
  stubDomainClients,
  TENANT,
} from './helpers.ts';
import type { Harness } from './helpers.ts';

let harness: Harness;
let workflowId: string;

function cancelledEvent(eventId: string | undefined, hoursUntilStart: number, startsAt: string, reason: string): AnyWfmEvent {
  return makeEvent(
    'shift.cancelled',
    {
      shiftId: SHIFT_ID,
      locationId: '33333333-3333-4333-8333-000000000001',
      startsAt,
      hoursUntilStart,
      reason,
      cancelledByEmployeeId: '44444444-4444-4444-8444-000000000001',
      requiredQualificationCodes: ['RN'],
      roleName: 'Registered Nurse',
    },
    { tenantId: TENANT, ...(eventId ? { eventId } : {}) },
  );
}

async function runIdForEvent(eventId: string): Promise<string | null> {
  const runs = await harness.engine.listRuns(managerActor, { workflowId, limit: 100 });
  return runs.find((candidate) => candidate.triggerEventId === eventId)?.runId ?? null;
}

beforeAll(async () => {
  harness = await createHarness();
  const created = await harness.engine.createWorkflow(managerActor, {
    name: coverageRescueWorkflow.name,
    description: coverageRescueWorkflow.description,
    enabled: true,
    definition: coverageRescueWorkflow,
    layout: coverageRescueLayout,
  });
  workflowId = created.workflowId;
  await harness.engine.publishWorkflow(managerActor, workflowId);
  await harness.engine.start();
});

afterAll(async () => {
  await harness.engine.stop();
  await harness.drop();
});

describe('studio engine', () => {
  test('the compiled graph exposes every definition transition', async () => {
    const spec = compileWorkflow(coverageRescueWorkflow);
    const graph = buildRunGraph(
      spec,
      coverageRescueWorkflow,
      {
        runId: '99999999-9999-4999-8999-000000000099',
        tenantId: TENANT,
        workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099',
        workflowVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000098',
        workflowName: 'test',
        correlationId: '99999999-9999-4999-8999-000000000099',
        triggerEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000099',
        dryRun: true,
      },
      {
        db: harness.db,
        bus: harness.bus,
        clients: stubDomainClients(),
        queue: {
          enqueueRunStart: async () => {},
          enqueueRunStep: async () => {},
          scheduleApprovalTimeout: async () => {},
          start: async () => {},
          stop: async () => {},
        },
        proposer: harness.proposer,
        logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
      },
      new MemorySaver(),
    );
    const drawable = await graph.getGraphAsync({});
    const pairs = new Set(drawable.edges.map((edge) => `${edge.source}->${edge.target}`));
    for (const edge of coverageRescueWorkflow.edges) {
      expect(pairs.has(`${edge.from}->${edge.to}`)).toBe(true);
    }
  });

  test('a run reaches awaiting_approval and completes after an approve decision', async () => {
    const event = cancelledEvent(undefined, 7.5, '2026-09-21T04:00:00.000Z', 'Sick leave');
    await harness.bus.publish(TENANT, event);

    const runId = await waitFor(() => runIdForEvent(event.eventId), { description: 'run created' });
    await waitFor(
      async () => {
        const detail = await harness.engine.getRun(managerActor, runId);
        return detail.run.status === 'awaiting_approval' ? detail.run.status : null;
      },
      { description: 'run awaiting approval' },
    );

    const detail = await harness.engine.getRun(managerActor, runId);
    expect(detail.approval?.status).toBe('pending');
    expect(detail.approval?.requestedFromRole).toBe('roster_manager');
    expect(detail.approval?.proposal.proposer).toBe('rules');
    const kinds = detail.events.map((runEvent) => runEvent.kind);
    expect(kinds).toContain('event_received');
    expect(kinds).toContain('proposal_created');
    expect(kinds).toContain('policy_evaluated');
    expect(kinds).toContain('approval_requested');

    const approvalId = detail.run.pendingApprovalId;
    if (!approvalId) throw new Error('approval not pending');
    const decision = await harness.engine.decideApproval(managerActor, approvalId, {
      decision: 'approve',
      reason: 'Coverage required for the morning medication round',
    });
    expect(decision.status).toBe('approved');
    expect(decision.runStatus).toBe('succeeded');

    expect(recorded.offers).toHaveLength(1);
    expect(recorded.offers[0]?.idempotencyKey).toBe(`run:${runId}:node:send_offers`);
    expect(recorded.offers[0]?.body.employeeIds).toEqual([BEST_FIT_ID]);
    expect(recorded.offers[0]?.body.reason).toBe('Coverage rescue for a cancelled shift');

    const finished = await harness.engine.getRun(managerActor, runId);
    expect(finished.run.status).toBe('succeeded');
    expect(finished.run.actionsExecuted).toBe(1);
    const finishedKinds = finished.events.map((runEvent) => runEvent.kind);
    expect(finishedKinds).toContain('action_executed');
    expect(finishedKinds).toContain('run_completed');
  });

  test('an approve from an actor without the role is refused', async () => {
    const event = cancelledEvent(undefined, 9, '2026-09-21T08:00:00.000Z', 'Sick leave again');
    await harness.bus.publish(TENANT, event);
    const runId = await waitFor(() => runIdForEvent(event.eventId), { description: 'second run created' });
    const detail = await harness.engine.getRun(peopleOpsActor, runId);
    const approvalId = detail.run.pendingApprovalId;
    if (!approvalId) throw new Error('approval not pending');

    try {
      await harness.engine.decideApproval(peopleOpsActor, approvalId, { decision: 'approve', reason: 'not my call' });
      throw new Error('decision should have been refused');
    } catch (error) {
      expect((error as Error).message.startsWith('forbidden:')).toBe(true);
    }
    const after = await harness.engine.getRun(managerActor, runId);
    expect(after.run.status).toBe('awaiting_approval');
  });

  test('a redelivered trigger event does not create a second run', async () => {
    const event = cancelledEvent(undefined, 11, '2026-09-21T10:00:00.000Z', 'Sick leave');
    await harness.bus.publish(TENANT, event);
    await harness.bus.publish(TENANT, event);

    const runs = await harness.engine.listRuns(managerActor, { workflowId, limit: 100 });
    const matching = runs.filter((candidate) => candidate.triggerEventId === event.eventId);
    expect(matching).toHaveLength(1);
  });

  test('a run keeps executing its pinned version after the workflow is edited', async () => {
    const event = cancelledEvent(undefined, 10, '2026-09-22T04:00:00.000Z', 'Sick leave, third case');
    await harness.bus.publish(TENANT, event);
    const runId = await waitFor(() => runIdForEvent(event.eventId), { description: 'third run created' });
    const before = await harness.engine.getRun(managerActor, runId);
    const approvalId = before.run.pendingApprovalId;
    if (!approvalId) throw new Error('approval not pending');
    expect(before.run.workflowVersionNumber).toBe(1);

    const edited = {
      ...coverageRescueWorkflow,
      nodes: coverageRescueWorkflow.nodes.map((node) =>
        node.type === 'action'
          ? { ...node, config: { ...node.config, input: { ...node.config.input, reason: 'edited reason' } } }
          : node,
      ),
    };
    await harness.engine.saveDraft(managerActor, workflowId, {
      name: coverageRescueWorkflow.name,
      description: coverageRescueWorkflow.description,
      enabled: true,
      definition: edited,
      layout: coverageRescueLayout,
    });
    await harness.engine.publishWorkflow(managerActor, workflowId);

    await harness.engine.decideApproval(managerActor, approvalId, {
      decision: 'approve',
      reason: 'approving the pinned version',
    });
    const after = await harness.engine.getRun(managerActor, runId);
    expect(after.run.status).toBe('succeeded');
    expect(after.run.workflowVersionNumber).toBe(1);
    expect(recorded.offers.at(-1)?.body.reason).toBe('Coverage rescue for a cancelled shift');
  });
});
