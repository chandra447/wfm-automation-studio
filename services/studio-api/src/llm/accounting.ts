import { eq, inArray, sql as dsql, type SQL } from 'drizzle-orm';
import type { TokenUsage } from '@wfm/contracts';
import * as schema from '../db/schema.ts';
import type { ModelCatalogue } from './catalogue.ts';
import type { ProviderKind } from './provider.ts';
import type { LlmDb } from './settings.ts';

/**
 * One row per model call, so a run's tokens and cost are auditable back to the
 * call that produced them. A tenant total is a sum over the same rows, priced
 * from the catalogue, never from a number the provider reported.
 */

export interface LlmCall {
  tenantId: string;
  runId: string;
  nodeId: string;
  providerKind: ProviderKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: 'ok' | 'error';
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

export interface LlmAccountingDeps {
  db: LlmDb;
  catalogue: ModelCatalogue;
}

export class LlmAccounting {
  readonly #db: LlmDb;
  readonly #catalogue: ModelCatalogue;

  constructor(deps: LlmAccountingDeps) {
    this.#db = deps.db;
    this.#catalogue = deps.catalogue;
  }

  async recordCall(call: LlmCall): Promise<void> {
    await this.#db.insert(schema.llmCalls).values(call);
  }

  tokensForRun(runId: string): Promise<TokenUsage> {
    return this.#totals(eq(schema.llmCalls.runId, runId));
  }

  /** Totals for many runs at once, so a list endpoint does not query per row. */
  async tokensForRuns(runIds: readonly string[]): Promise<Record<string, TokenUsage>> {
    const totals: Record<string, TokenUsage> = {};
    for (const runId of runIds) totals[runId] = { inputTokens: 0, outputTokens: 0, calls: 0, estimatedCostCents: 0 };
    if (runIds.length === 0) return totals;

    const rows = await this.#db
      .select({
        runId: schema.llmCalls.runId,
        model: schema.llmCalls.model,
        inputTokens: dsql<number>`coalesce(sum(${schema.llmCalls.inputTokens}), 0)::int`,
        outputTokens: dsql<number>`coalesce(sum(${schema.llmCalls.outputTokens}), 0)::int`,
        calls: dsql<number>`count(*)::int`,
      })
      .from(schema.llmCalls)
      .where(inArray(schema.llmCalls.runId, [...runIds]))
      .groupBy(schema.llmCalls.runId, schema.llmCalls.model);

    for (const row of rows) {
      const total = totals[row.runId];
      if (total === undefined) continue;
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.calls += row.calls;
      const price = this.#catalogue.modelById(row.model);
      if (price === undefined) continue;
      total.estimatedCostCents +=
        (row.inputTokens * price.inputCentsPerMillion + row.outputTokens * price.outputCentsPerMillion) /
        TOKENS_PER_PRICE_UNIT;
    }
    for (const total of Object.values(totals)) {
      total.estimatedCostCents = Math.round(total.estimatedCostCents * 1e6) / 1e6;
    }
    return totals;
  }

  tokensForTenant(tenantId: string): Promise<TokenUsage> {
    return this.#totals(eq(schema.llmCalls.tenantId, tenantId));
  }

  async #totals(where: SQL): Promise<TokenUsage> {
    const rows = await this.#db
      .select({
        model: schema.llmCalls.model,
        inputTokens: dsql<number>`coalesce(sum(${schema.llmCalls.inputTokens}), 0)::int`,
        outputTokens: dsql<number>`coalesce(sum(${schema.llmCalls.outputTokens}), 0)::int`,
        calls: dsql<number>`count(*)::int`,
      })
      .from(schema.llmCalls)
      .where(where)
      .groupBy(schema.llmCalls.model);

    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    let cents = 0;
    for (const row of rows) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      calls += row.calls;
      // A model the catalogue does not know is not free, it is unpriced.
      const price = this.#catalogue.modelById(row.model);
      if (price === undefined) continue;
      cents +=
        (row.inputTokens * price.inputCentsPerMillion + row.outputTokens * price.outputCentsPerMillion) /
        TOKENS_PER_PRICE_UNIT;
    }
    return { inputTokens, outputTokens, calls, estimatedCostCents: Math.round(cents * 1e6) / 1e6 };
  }
}
