import { describe, expect, test } from 'bun:test';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { makeEvent, type AnyWfmEvent } from '@wfm/contracts';
import { coverageRescueLayout, coverageRescueWorkflow } from '@wfm/workflows';
import { createTestDatabase, waitFor } from '@wfm/testkit';
import { createHarness, managerActor, recorded, SHIFT_ID, TENANT, type Harness } from './helpers.ts';

/**
 * The load-bearing durability claim: an approval can sit for hours, and the
 * process that started the run may be gone by the time a human decides. This
 * proves it by parking a run on one engine instance, throwing that instance
 * away, and finishing the run on a second one that shares nothing but Postgres.
 */

function cancelledEvent(): AnyWfmEvent {
  return makeEvent(
    'shift.cancelled',
    {
      shiftId: SHIFT_ID,
      locationId: '33333333-3333-4333-8333-000000000001',
      startsAt: '2026-09-21T04:00:00.000Z',
      hoursUntilStart: 7.5,
      reason: 'Sick leave',
      cancelledByEmployeeId: '44444444-4444-4444-8444-000000000001',
      requiredQualificationCodes: ['RN'],
      roleName: 'Registered Nurse',
    },
    { tenantId: TENANT },
  );
}

async function seedWorkflow(harness: Harness): Promise<string> {
  const created = await harness.engine.createWorkflow(managerActor, {
    name: coverageRescueWorkflow.name,
    description: coverageRescueWorkflow.description,
    enabled: true,
    definition: coverageRescueWorkflow,
    layout: coverageRescueLayout,
  });
  await harness.engine.publishWorkflow(managerActor, created.workflowId);
  return created.workflowId;
}

describe('durability across engine instances', () => {
  test('a run parked in Postgres resumes under a new engine instance', async () => {
    const database = await createTestDatabase(
      'postgres://wfm:wfm@127.0.0.1:5433/studio',
      `studio_restart_${Math.random().toString(36).slice(2, 8)}`,
    );

    try {
      const saverBefore = PostgresSaver.fromConnString(database.url);
      await saverBefore.setup();
      const first = await createHarness({ databaseUrl: database.url, checkpointer: saverBefore });
      const workflowId = await seedWorkflow(first);
      await first.engine.start();

      const event = cancelledEvent();
      await first.bus.publish(TENANT, event);
      const runId = await waitFor(
        async () =>
          (await first.engine.listRuns(managerActor, { workflowId })).find(
            (run) => run.triggerEventId === event.eventId,
          )?.runId ?? null,
        { description: 'run created' },
      );
      await waitFor(
        async () => ((await first.engine.getRun(managerActor, runId)).run.status === 'awaiting_approval' ? true : null),
        { description: 'run parked for approval' },
      );
      const parked = await first.engine.getRun(managerActor, runId);
      const approvalId = parked.approval?.approvalId;
      if (!approvalId) throw new Error('the run parked without an approval');

      // The process that started the run goes away.
      await first.engine.stop();
      await first.drop();

      const second = await createHarness({
        databaseUrl: database.url,
        checkpointer: PostgresSaver.fromConnString(database.url),
      });
      await second.engine.start();

      const offersBefore = recorded.offers.length;
      const decision = await second.engine.decideApproval(managerActor, approvalId, {
        decision: 'approve',
        reason: 'resuming after the original process is gone',
      });

      expect(decision.runStatus).toBe('succeeded');
      const finished = await second.engine.getRun(managerActor, runId);
      expect(finished.run.status).toBe('succeeded');
      expect(finished.events.map((runEvent) => runEvent.kind)).toContain('action_executed');
      expect(recorded.offers.length).toBe(offersBefore + 1);

      await second.drop();
    } finally {
      await database.drop();
    }
  }, 60_000);
});
