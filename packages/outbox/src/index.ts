import { parseEvent, type AnyWfmEvent } from '@wfm/contracts';
import type { EventBus } from '@wfm/eventbus';
import type { SQL } from 'bun';

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
  sql: SQL;
  bus: EventBus;
  pollMs?: number;
  batchSize?: number;
  claimTimeoutSeconds?: number;
  /** Parse or validation failures allowed before the row is poisoned. */
  maxAttempts?: number;
  /** Called once when a row is poisoned, so the owner can raise an alert. */
  onPoison?: (row: { id: string; tenantId: string; eventType: string }, reason: string) => Promise<void>;
  onError?: (error: unknown, event: AnyWfmEvent | null) => void;
}

export async function ensureOutboxTable(sql: SQL, options: OutboxOptions = {}): Promise<void> {
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
      published_at timestamptz,
      poisoned_at timestamptz
    );
    ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS poisoned_at timestamptz;
    CREATE INDEX IF NOT EXISTS ${table}_pending_idx
      ON ${table} (available_at)
      WHERE published_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_event_idx ON ${table} (event_id);
  `);
}

/**
 * The minimum a caller must provide to enqueue: Bun's `unsafe`. Both
 * `SQL` and `TransactionSQL` satisfy it structurally, which is what lets a
 * service pass the transaction it is already inside without a cast.
 */
export interface OutboxExecutor {
  unsafe: SQL['unsafe'];
}

/**
 * Inserts events into the outbox. Call inside the same transaction as the
 * domain write; that is the whole point of the pattern.
 */
export async function enqueueEvents(
  tx: OutboxExecutor,
  events: readonly AnyWfmEvent[],
  options: OutboxOptions = {},
): Promise<void> {
  if (events.length === 0) return;
  const table = options.table ?? 'outbox';
  for (const event of events) {
    await tx.unsafe(
      `INSERT INTO ${table} (id, tenant_id, event_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [crypto.randomUUID(), event.tenantId, event.eventId, event.eventType, event],
    );
  }
}

export class OutboxPublisher {
  readonly #sql: SQL;
  readonly #bus: EventBus;
  readonly #table: string;
  readonly #pollMs: number;
  readonly #batchSize: number;
  readonly #claimTimeoutSeconds: number;
  readonly #maxAttempts: number;
  readonly #onPoison: ((row: { id: string; tenantId: string; eventType: string }, reason: string) => Promise<void>) | undefined;
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
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#onPoison = options.onPoison;
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
    const claimed = await this.#sql<
      Array<{ id: string; tenant_id: string; payload_text: string; attempts: number; event_type: string }>
    >`
      UPDATE ${this.#sql(this.#table)} SET claimed_at = now()
      WHERE id IN (
        SELECT id FROM ${this.#sql(this.#table)}
        WHERE published_at IS NULL
          AND poisoned_at IS NULL
          AND available_at <= now()
          AND (claimed_at IS NULL OR claimed_at < now() - ${`${this.#claimTimeoutSeconds} seconds`}::interval)
        ORDER BY created_at
        LIMIT ${this.#batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tenant_id, payload::text AS payload_text, attempts, event_type
    `;

    if (claimed.length === 0) return 0;

    for (const row of claimed) {
      let event: AnyWfmEvent;
      try {
        // Read the payload as text and parse it here: the driver's jsonb
        // handling varies by runtime, and the envelope must be an object.
        event = parseEvent(JSON.parse(row.payload_text));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A payload that cannot be parsed will never succeed; retrying it
        // forever would be a quiet, permanent leak. Cap the attempts and mark
        // the row poisoned so an operator sees it instead of a log line.
        const attempts = (row.attempts ?? 0) + 1;
        if (attempts >= this.#maxAttempts) {
          await this.#sql`
            UPDATE ${this.#sql(this.#table)}
            SET attempts = ${attempts}, poisoned_at = now(), claimed_at = NULL
            WHERE id = ${row.id}
          `;
          await this.#onPoison?.({ id: row.id, tenantId: row.tenant_id, eventType: row.event_type }, reason);
        } else {
          await this.#sql`
            UPDATE ${this.#sql(this.#table)}
            SET attempts = ${attempts}, claimed_at = NULL, available_at = now() + interval '1 minute'
            WHERE id = ${row.id}
          `;
        }
        this.#onError(error, null);
        continue;
      }

      try {
        await this.#bus.publish(row.tenant_id, event);
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
        this.#onError(error, event);
      }
    }

    return claimed.length;
  }
}
