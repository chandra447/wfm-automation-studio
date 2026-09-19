import type { AnyWfmEvent } from '@wfm/contracts';
import type { EventBus } from '@wfm/eventbus';
import type { Sql } from 'postgres';

/**
 * Transactional outbox (ADR-0007). The service writes its domain row and the
 * outbox row in one transaction; a publisher loop claims due rows with
 * FOR UPDATE SKIP LOCKED and pushes them to the backbone. Delivery is
 * at-least-once, so consumers dedupe on eventId.
 */

export interface OutboxOptions {
  table?: string;
}

export interface OutboxPublisherOptions extends OutboxOptions {
  sql: Sql;
  bus: EventBus;
  pollMs?: number;
  batchSize?: number;
  claimTimeoutSeconds?: number;
  onError?: (error: unknown, event: AnyWfmEvent | null) => void;
}

export async function ensureOutboxTable(sql: Sql, options: OutboxOptions = {}): Promise<void> {
  const table = options.table ?? 'outbox';
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      event_id uuid NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      available_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS ${table}_pending_idx
      ON ${table} (available_at)
      WHERE published_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_event_idx ON ${table} (event_id);
  `);
}

/**
 * Inserts events into the outbox. Call inside the same transaction as the
 * domain write; that is the whole point of the pattern.
 */
export async function enqueueEvents(
  tx: Sql,
  events: readonly AnyWfmEvent[],
  options: OutboxOptions = {},
): Promise<void> {
  if (events.length === 0) return;
  const table = options.table ?? 'outbox';
  const rows = events.map((event) => ({
    id: crypto.randomUUID(),
    tenant_id: event.tenantId,
    event_id: event.eventId,
    event_type: event.eventType,
    payload: event,
  }));
  await tx`
    INSERT INTO ${tx(table)} ${tx(rows, 'id', 'tenant_id', 'event_id', 'event_type', 'payload')}
    ON CONFLICT (event_id) DO NOTHING
  `;
}

export class OutboxPublisher {
  readonly #sql: Sql;
  readonly #bus: EventBus;
  readonly #table: string;
  readonly #pollMs: number;
  readonly #batchSize: number;
  readonly #claimTimeoutSeconds: number;
  readonly #onError: (error: unknown, event: AnyWfmEvent | null) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = true;

  constructor(options: OutboxPublisherOptions) {
    this.#sql = options.sql;
    this.#bus = options.bus;
    this.#table = options.table ?? 'outbox';
    this.#pollMs = options.pollMs ?? 250;
    this.#batchSize = options.batchSize ?? 50;
    this.#claimTimeoutSeconds = options.claimTimeoutSeconds ?? 30;
    this.#onError = options.onError ?? (() => {});
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Publishes everything currently pending. Used by tests and by graceful shutdown. */
  async drain(limit = 1_000): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.#publishBatch();
      total += published;
      if (published === 0 || total >= limit) return total;
    }
  }

  async #scheduleNext(delayMs: number): Promise<void> {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      const published = await this.#publishBatch();
      await this.#scheduleNext(published > 0 ? 0 : this.#pollMs);
    } catch (error) {
      this.#onError(error, null);
      await this.#scheduleNext(this.#pollMs);
    } finally {
      this.#running = false;
    }
  }

  async #publishBatch(): Promise<number> {
    const claimed = await this.#sql<Array<{ id: string; tenant_id: string; payload: AnyWfmEvent }>>`
      UPDATE ${this.#sql(this.#table)} SET claimed_at = now()
      WHERE id IN (
        SELECT id FROM ${this.#sql(this.#table)}
        WHERE published_at IS NULL
          AND available_at <= now()
          AND (claimed_at IS NULL OR claimed_at < now() - ${`${this.#claimTimeoutSeconds} seconds`}::interval)
        ORDER BY created_at
        LIMIT ${this.#batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tenant_id, payload
    `;

    if (claimed.length === 0) return 0;

    for (const row of claimed) {
      try {
        await this.#bus.publish(row.tenant_id, row.payload);
        await this.#sql`
          UPDATE ${this.#sql(this.#table)} SET published_at = now(), attempts = attempts + 1
          WHERE id = ${row.id}
        `;
      } catch (error) {
        await this.#sql`
          UPDATE ${this.#sql(this.#table)}
          SET attempts = attempts + 1,
              claimed_at = NULL,
              available_at = now() + (least(60, power(2, least(attempts, 6))) || ' seconds')::interval
          WHERE id = ${row.id}
        `;
        this.#onError(error, row.payload);
      }
    }

    return claimed.length;
  }
}
