import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dashboardSchema, type RunStatus } from '@wfm/contracts';
import { createTestDatabase, type TestDatabase } from '@wfm/testkit';
import { connectStudioDb, ensureStudioTables, type StudioDb } from '../src/engine/db.ts';
import * as schema from '../src/db/schema.ts';
import { loadDashboard } from '../src/dashboard/queries.ts';

/**
 * Aggregates are checked against hand-computed expectations over a known set of
 * rows, across three tenants, so a leak between tenants or a wrong join shows up
 * as a wrong number rather than a plausible one.
 */

const MAIN = 'aaaaaaa1-aaaa-4aaa-8aaa-000000000001';
const EVEN = 'aaaaaaa2-aaaa-4aaa-8aaa-000000000002';
const OTHER = 'aaaaaaa3-aaaa-4aaa-8aaa-000000000003';

const COVERAGE = 'bbbbbbb1-bbbb-4bbb-8bbb-000000000001';
const PAYROLL = 'bbbbbbb2-bbbb-4bbb-8bbb-000000000002';
const MEDIAN = 'bbbbbbb3-bbbb-4bbb-8bbb-000000000003';
const IDLE = 'bbbbbbb4-bbbb-4bbb-8bbb-000000000004';
const LONE = 'bbbbbbb5-bbbb-4bbb-8bbb-000000000005';

const FLASH = 'deepseek/deepseek-v4.1-flash';
const V32 = 'deepseek/deepseek-v3.2';

const HOUR_MS = 3_600_000;

interface RunFixture {
  runId: string;
  tenantId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: Date;
  durationMs: number | null;
}

function runFixture(input: RunFixture) {
  return {
    runId: input.runId,
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    workflowVersionId: crypto.randomUUID(),
    workflowName: input.workflowName,
    triggerEventId: crypto.randomUUID(),
    triggerEventType: 'shift.cancelled',
    status: input.status,
    correlationId: crypto.randomUUID(),
    dryRun: false,
    startedAt: input.startedAt,
    finishedAt: input.durationMs === null ? null : new Date(input.startedAt.getTime() + input.durationMs),
    actionsExecuted: 0,
  };
}

const now = Date.now();
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR_MS);

// Main tenant: five finished runs (odd), so the median is the middle one.
const coverageLastRun = at(2);
const payrollLastRun = at(26);
// Even tenant: four finished runs, so the median is the mean of the middle pair.
const medianLastRun = at(1);
// Other tenant: one run still in flight, so there is no median at all.
const loneRun = at(0.5);

let database: TestDatabase;
let studio: StudioDb;

beforeAll(async () => {
  process.env.MODEL_CATALOGUE_PATH = fileURLToPath(new URL('../../../config/models.jsonl', import.meta.url));
  database = await createTestDatabase(
    'postgres://wfm:wfm@127.0.0.1:5433/studio',
    `studio_dashboard_${Math.random().toString(36).slice(2, 10)}`,
  );
  studio = connectStudioDb(database.url);
  await ensureStudioTables(studio.sql);
  await studio.sql.unsafe(await Bun.file(new URL('../drizzle/0002_features.sql', import.meta.url)).text());

  await studio.db.insert(schema.workflows).values([
    { workflowId: COVERAGE, tenantId: MAIN, name: 'Coverage rescue', enabled: true, draftVersionNumber: 3, publishedVersionNumber: 2 },
    { workflowId: PAYROLL, tenantId: MAIN, name: 'Payroll exception', enabled: false, draftVersionNumber: 1, publishedVersionNumber: null },
    { workflowId: MEDIAN, tenantId: EVEN, name: 'Median fixture', enabled: true, draftVersionNumber: 1, publishedVersionNumber: 1 },
    { workflowId: IDLE, tenantId: EVEN, name: 'Idle workflow', enabled: true, draftVersionNumber: 1, publishedVersionNumber: null },
    { workflowId: LONE, tenantId: OTHER, name: 'Other tenant', enabled: true, draftVersionNumber: 1, publishedVersionNumber: null },
  ]);

  await studio.db.insert(schema.runs).values([
    runFixture({ runId: crypto.randomUUID(), tenantId: MAIN, workflowId: COVERAGE, workflowName: 'Coverage rescue', status: 'succeeded', startedAt: coverageLastRun, durationMs: 1_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: MAIN, workflowId: COVERAGE, workflowName: 'Coverage rescue', status: 'succeeded', startedAt: at(3), durationMs: 3_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: MAIN, workflowId: COVERAGE, workflowName: 'Coverage rescue', status: 'failed', startedAt: at(5), durationMs: 5_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: MAIN, workflowId: PAYROLL, workflowName: 'Payroll exception', status: 'awaiting_approval', startedAt: payrollLastRun, durationMs: null }),
    runFixture({ runId: crypto.randomUUID(), tenantId: MAIN, workflowId: PAYROLL, workflowName: 'Payroll exception', status: 'succeeded', startedAt: at(40), durationMs: 7_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: MAIN, workflowId: PAYROLL, workflowName: 'Payroll exception', status: 'cancelled', startedAt: at(50), durationMs: 9_000 }),

    runFixture({ runId: crypto.randomUUID(), tenantId: EVEN, workflowId: MEDIAN, workflowName: 'Median fixture', status: 'succeeded', startedAt: medianLastRun, durationMs: 1_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: EVEN, workflowId: MEDIAN, workflowName: 'Median fixture', status: 'succeeded', startedAt: at(2), durationMs: 2_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: EVEN, workflowId: MEDIAN, workflowName: 'Median fixture', status: 'failed', startedAt: at(3), durationMs: 3_000 }),
    runFixture({ runId: crypto.randomUUID(), tenantId: EVEN, workflowId: MEDIAN, workflowName: 'Median fixture', status: 'succeeded', startedAt: at(4), durationMs: 4_000 }),

    runFixture({ runId: crypto.randomUUID(), tenantId: OTHER, workflowId: LONE, workflowName: 'Other tenant', status: 'running', startedAt: loneRun, durationMs: null }),
  ]);

  const call = (tenantId: string, model: string, inputTokens: number, outputTokens: number) => ({
    tenantId,
    runId: crypto.randomUUID(),
    nodeId: 'assess',
    providerKind: 'openai-compatible',
    model,
    inputTokens,
    outputTokens,
    latencyMs: 900,
    status: 'ok' as const,
  });

  await studio.db.insert(schema.llmCalls).values([
    call(MAIN, FLASH, 1_000_000, 500_000),
    call(MAIN, FLASH, 500_000, 250_000),
    call(MAIN, V32, 2_000_000, 1_000_000),
    call(OTHER, FLASH, 9_000_000, 9_000_000),
  ]);
});

afterAll(async () => {
  await studio.close();
  await database.drop();
});

describe('dashboard aggregates', () => {
  test('a tenant sees its own run counts, median duration and window', async () => {
    const dashboard = await loadDashboard(studio.db, MAIN);

    expect(dashboard.runs.total).toBe(6);
    expect(dashboard.runs.byStatus).toEqual({
      queued: 0,
      running: 0,
      awaiting_approval: 1,
      succeeded: 3,
      failed: 1,
      cancelled: 1,
    });
    expect(dashboard.runs.last24h).toBe(3);
    // 1s, 3s, 5s, 7s, 9s — the middle of an odd count.
    expect(dashboard.runs.medianDurationMs).toBe(5_000);
  });

  test('the median over an even number of finished runs averages the middle pair', async () => {
    const dashboard = await loadDashboard(studio.db, EVEN);

    expect(dashboard.runs.total).toBe(4);
    expect(dashboard.runs.last24h).toBe(4);
    // 1s, 2s, 3s, 4s — (2s + 3s) / 2.
    expect(dashboard.runs.medianDurationMs).toBe(2_500);
  });

  test('a run still in flight leaves the median null', async () => {
    const dashboard = await loadDashboard(studio.db, OTHER);

    expect(dashboard.runs.total).toBe(1);
    expect(dashboard.runs.byStatus['running']).toBe(1);
    expect(dashboard.runs.last24h).toBe(1);
    expect(dashboard.runs.medianDurationMs).toBeNull();
  });

  test('token totals and cost are summed from the catalogue prices', async () => {
    const dashboard = await loadDashboard(studio.db, MAIN);

    expect(dashboard.tokens.inputTokens).toBe(3_500_000);
    expect(dashboard.tokens.outputTokens).toBe(1_750_000);
    expect(dashboard.tokens.calls).toBe(3);
    // flash 15/60 cents per million: 1.5M in + 0.75M out = 22.5 + 45 = 67.5
    // v3.2 28/42 cents per million: 2M in + 1M out = 56 + 42 = 98
    expect(dashboard.tokens.estimatedCostCents).toBe(165.5);

    // No calls at all is zero, not a missing field.
    expect((await loadDashboard(studio.db, EVEN)).tokens).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      estimatedCostCents: 0,
    });
  });

  test('workflow rows carry versions, run counts and last activity', async () => {
    const dashboard = await loadDashboard(studio.db, MAIN);

    expect(dashboard.workflows).toEqual([
      {
        workflowId: COVERAGE,
        name: 'Coverage rescue',
        enabled: true,
        publishedVersion: 2,
        draftVersion: 3,
        runs: 3,
        lastRunAt: coverageLastRun.toISOString(),
      },
      {
        workflowId: PAYROLL,
        name: 'Payroll exception',
        enabled: false,
        publishedVersion: null,
        draftVersion: 1,
        runs: 3,
        lastRunAt: payrollLastRun.toISOString(),
      },
    ]);

    const even = await loadDashboard(studio.db, EVEN);
    expect(even.workflows.map((workflow) => [workflow.name, workflow.runs, workflow.lastRunAt])).toEqual([
      ['Median fixture', 4, medianLastRun.toISOString()],
      ['Idle workflow', 0, null],
    ]);

    const other = await loadDashboard(studio.db, OTHER);
    expect(other.workflows.map((workflow) => workflow.name)).toEqual(['Other tenant']);
  });

  test('every tenant answer satisfies the published DTO', async () => {
    for (const tenantId of [MAIN, EVEN, OTHER]) {
      const parsed = dashboardSchema.safeParse(await loadDashboard(studio.db, tenantId));
      expect(parsed.success, `tenant ${tenantId}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });
});
