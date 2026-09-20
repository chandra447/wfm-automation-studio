import { createHash } from 'node:crypto';
import type { AnyWfmEvent } from '@wfm/contracts';
import { enqueueEvents } from '@wfm/outbox';
import type { Sql } from 'postgres';
import type { Tx } from '../db/rows.ts';
import { IdempotencyMismatchError } from './errors.ts';

/**
 * Command idempotency (ADR-0007). The keyed response is stored in the same
 * transaction as the domain change and its outbox rows, so a retry replays the
 * original outcome instead of applying a second effect.
 */

export interface CommandOutcome {
  status: number;
  body: unknown;
  events: AnyWfmEvent[];
}

export interface CommandResult {
  status: number;
  body: unknown;
  events: AnyWfmEvent[];
  replayed: boolean;
}

interface IdempotencyRow {
  requestHash: string;
  response: unknown;
}

/** Key-order-independent so a retry with the same body always hashes the same. */
export function requestHashOf(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function withIdempotency(
  sql: Sql,
  tenantId: string,
  key: string,
  requestHash: string,
  run: (tx: Tx) => Promise<CommandOutcome>,
): Promise<CommandResult> {
  return sql.begin(async (tx) => {
    const existing = await tx<IdempotencyRow[]>`
      SELECT request_hash AS "requestHash", response
      FROM idempotency_keys
      WHERE tenant_id = ${tenantId} AND key = ${key}
      FOR UPDATE
    `;
    const replay = existing[0];
    if (replay) {
      if (replay.requestHash !== requestHash) throw new IdempotencyMismatchError('idempotency key already used with a different request');
      return { status: 200, body: replay.response, events: [], replayed: true };
    }

    const outcome = await run(tx);
    await enqueueEvents(tx, outcome.events);
    await tx`
      INSERT INTO idempotency_keys (tenant_id, key, request_hash, response)
      VALUES (${tenantId}, ${key}, ${requestHash}, ${tx.json(outcome.body as never)})
    `;
    return { status: outcome.status, body: outcome.body, events: outcome.events, replayed: false };
  });
}

export async function withoutIdempotency(sql: Sql, run: (tx: Tx) => Promise<CommandOutcome>): Promise<CommandResult> {
  return sql.begin(async (tx) => {
    const outcome = await run(tx);
    await enqueueEvents(tx, outcome.events);
    return { status: outcome.status, body: outcome.body, events: outcome.events, replayed: false };
  });
}

export async function runKeyed(
  sql: Sql,
  tenantId: string,
  idempotencyKey: string | undefined,
  body: unknown,
  run: (tx: Tx) => Promise<CommandOutcome>,
): Promise<CommandResult> {
  if (idempotencyKey === undefined) return withoutIdempotency(sql, run);
  return withIdempotency(sql, tenantId, idempotencyKey, requestHashOf(body), run);
}
