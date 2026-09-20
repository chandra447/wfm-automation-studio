import { EventValidationError, type AnyWfmEvent } from '@wfm/contracts';
import { PermanentEventFailure, type EventBus, type Subscription } from '@wfm/eventbus';
import type { Logger } from 'pino';
import * as schema from '../db/schema.ts';
import type { Orchestrator } from './orchestrator.ts';
import { ensureStudioTables } from './db.ts';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { eq } from 'drizzle-orm';
import type { SQL } from 'bun';

/**
 * The event router (design §7). For every tenant with an enabled workflow it
 * holds a bus subscription: validate (unknown type/version is permanent —
 * ADR-0007), dedupe through processed_events, match published workflow
 * definitions against the trigger, and create the run (the unique index on
 * (workflow_id, trigger_event_id) makes redelivery a no-op). Permanent
 * failures land in dead_letters.
 */
export interface RouterOptions {
  sql: SQL;
  db: BunSQLDatabase<typeof schema>;
  bus: EventBus;
  orchestrator: Orchestrator;
  logger: Logger;
  /** How often the tenant roster is re-scanned for new subscriptions. */
  scanMs?: number;
}

export class Router {
  readonly #options: RouterOptions;
  #subscriptions: Record<string, Subscription> = {};
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;

  constructor(options: RouterOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await ensureStudioTables(this.#options.sql);
    this.#stopped = false;
    await this.#scan();
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const subscriptions = Object.values(this.#subscriptions);
    this.#subscriptions = {};
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#scan().catch((error) => this.#options.logger.error({ error: String(error) }, 'router scan failed'));
      this.#schedule();
    }, this.#options.scanMs ?? 5_000);
  }

  async #scan(): Promise<void> {
    const { db } = this.#options;
    const rows = await db
      .selectDistinct({ tenantId: schema.workflows.tenantId })
      .from(schema.workflows)
      .where(eq(schema.workflows.enabled, true));
    const active = new Set(rows.map((row) => row.tenantId));

    for (const tenantId of active) {
      if (this.#subscriptions[tenantId]) continue;
      this.#subscriptions[tenantId] = await this.#options.bus.subscribe({
        tenantId,
        group: 'studio-router',
        consumer: `router-${crypto.randomUUID()}`,
        onEvent: (event) => this.#onEvent(event),
        onPermanentFailure: (raw, reason) => this.#deadLetter(raw, reason),
      });
      this.#options.logger.info({ tenantId: tenantId }, 'router subscribed');
    }

    for (const [tenantId, subscription] of Object.entries(this.#subscriptions)) {
      if (active.has(tenantId)) continue;
      await subscription.stop();
      delete this.#subscriptions[tenantId];
      this.#options.logger.info({ tenantId }, 'router unsubscribed');
    }
  }

  async #onEvent(event: AnyWfmEvent): Promise<void> {
    try {
      await this.#options.orchestrator.handleEvent(event);
    } catch (error) {
      if (error instanceof EventValidationError) {
        throw new PermanentEventFailure(`${event.eventType}: ${error.message}`);
      }
      throw error;
    }
  }

  async #deadLetter(raw: string, reason: string): Promise<void> {
    let tenantId: string | null = null;
    let eventType: string | null = null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed['tenantId'] === 'string') tenantId = parsed['tenantId'];
      if (typeof parsed['eventType'] === 'string') eventType = parsed['eventType'];
    } catch {
      // unparsable raw payload; keep both columns null
    }
    await this.#options.sql`
      INSERT INTO dead_letters (tenant_id, event_type, reason, raw)
      VALUES (${tenantId}, ${eventType}, ${reason}, ${raw})
    `;
    this.#options.logger.error({ tenantId, eventType, reason }, 'event dead-lettered');
  }
}
