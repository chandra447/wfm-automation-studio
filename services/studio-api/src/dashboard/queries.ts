import { eq, sql as dsql } from 'drizzle-orm';
import { runStatusSchema, type Dashboard, type TokenUsage } from '@wfm/contracts';
import * as schema from '../db/schema.ts';
import type { RunDb } from '../engine/run-store.ts';
import { loadModelCatalogueFromEnv, type ModelCatalogue } from '../llm/catalogue.ts';

/**
 * Dashboard aggregates. Four fixed queries — run counts, run shape, tokens by
 * model, and workflows with their run rollup — so the cost of the page does not
 * grow with the number of workflows or runs.
 */

let cataloguePromise: Promise<ModelCatalogue> | undefined;

/** The allow-list is read once per process; a malformed file fails loudly. */
function modelCatalogue(): Promise<ModelCatalogue> {
  const loaded = (cataloguePromise ??= loadModelCatalogueFromEnv());
  return loaded;
}

export async function loadDashboard(db: RunDb, tenantId: string): Promise<Dashboard> {
  const [statusRows, shapeRows, tokenRows, workflowRows, catalogue] = await Promise.all([
    db
      .select({ status: schema.runs.status, count: dsql<string>`count(*)::text` })
      .from(schema.runs)
      .where(eq(schema.runs.tenantId, tenantId))
      .groupBy(schema.runs.status),
    db
      .select({
        last24h: dsql<string>`count(*) filter (where ${schema.runs.startedAt} >= now() - interval '24 hours')::text`,
        medianDurationMs: dsql<
          string | null
        >`round(percentile_cont(0.5) within group (order by extract(epoch from (${schema.runs.finishedAt} - ${schema.runs.startedAt})) * 1000))::text`,
      })
      .from(schema.runs)
      .where(eq(schema.runs.tenantId, tenantId)),
    db
      .select({
        model: schema.llmCalls.model,
        inputTokens: dsql<string>`coalesce(sum(${schema.llmCalls.inputTokens}), 0)::text`,
        outputTokens: dsql<string>`coalesce(sum(${schema.llmCalls.outputTokens}), 0)::text`,
        calls: dsql<string>`count(*)::text`,
      })
      .from(schema.llmCalls)
      .where(eq(schema.llmCalls.tenantId, tenantId))
      .groupBy(schema.llmCalls.model),
    db
      .select({
        workflowId: schema.workflows.workflowId,
        name: schema.workflows.name,
        enabled: schema.workflows.enabled,
        publishedVersion: schema.workflows.publishedVersionNumber,
        draftVersion: schema.workflows.draftVersionNumber,
        runs: dsql<string>`count(${schema.runs.runId})::text`,
        lastRunAt: dsql<Date | null>`max(${schema.runs.startedAt})`,
      })
      .from(schema.workflows)
      .leftJoin(schema.runs, eq(schema.runs.workflowId, schema.workflows.workflowId))
      .where(eq(schema.workflows.tenantId, tenantId))
      .groupBy(
        schema.workflows.workflowId,
        schema.workflows.name,
        schema.workflows.enabled,
        schema.workflows.publishedVersionNumber,
        schema.workflows.draftVersionNumber,
      )
      .orderBy(dsql`max(${schema.runs.startedAt}) desc nulls last`, schema.workflows.name),
    modelCatalogue(),
  ]);

  const byStatus: Record<string, number> = {};
  for (const status of runStatusSchema.options) byStatus[status] = 0;
  let total = 0;
  for (const row of statusRows) {
    byStatus[row.status] = Number(row.count);
    total += Number(row.count);
  }

  const shape = shapeRows[0];

  const tokens: TokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCostCents: 0 };
  for (const row of tokenRows) {
    const inputTokens = Number(row.inputTokens);
    const outputTokens = Number(row.outputTokens);
    const descriptor = catalogue.modelById(row.model);
    tokens.inputTokens += inputTokens;
    tokens.outputTokens += outputTokens;
    tokens.calls += Number(row.calls);
    tokens.estimatedCostCents +=
      (inputTokens * (descriptor?.inputCentsPerMillion ?? 0) + outputTokens * (descriptor?.outputCentsPerMillion ?? 0)) /
      1_000_000;
  }
  tokens.estimatedCostCents = Math.round(tokens.estimatedCostCents * 1e6) / 1e6;

  return {
    runs: {
      total,
      byStatus,
      last24h: Number(shape?.last24h ?? '0'),
      medianDurationMs: shape?.medianDurationMs == null ? null : Number(shape.medianDurationMs),
    },
    tokens,
    workflows: workflowRows.map((row) => ({
      workflowId: row.workflowId,
      name: row.name,
      enabled: row.enabled,
      publishedVersion: row.publishedVersion,
      draftVersion: row.draftVersion,
      runs: Number(row.runs),
      lastRunAt: row.lastRunAt === null ? null : row.lastRunAt.toISOString(),
    })),
  };
}
