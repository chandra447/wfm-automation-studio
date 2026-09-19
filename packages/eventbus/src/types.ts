import type { AnyWfmEvent } from '@wfm/contracts';

/**
 * The event backbone port (ADR-0004). Two bindings ship with the repo:
 * Redis Streams for local runs and tests-over-a-broker, and an in-memory bus for
 * unit tests. Azure Event Hubs is the production binding and implements the
 * same three guarantees this interface promises:
 *
 *  1. at-least-once delivery,
 *  2. per-tenant ordering (a tenant's events are consumed in publish order),
 *  3. consumer groups with independent positions.
 */

export interface SubscribeOptions {
  tenantId: string;
  group: string;
  consumer: string;
  onEvent: (event: AnyWfmEvent) => Promise<void>;
  /** Raised for messages that can never succeed; the bus acks and dead-letters them. */
  onPermanentFailure?: (raw: string, reason: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface Subscription {
  stop: () => Promise<void>;
}

export interface EventBus {
  publish: (tenantId: string, event: AnyWfmEvent) => Promise<void>;
  subscribe: (options: SubscribeOptions) => Promise<Subscription>;
  close: () => Promise<void>;
}

/**
 * Throw this from a subscriber for messages that will never succeed
 * (unknown event type, schema violation, unsupported version). Anything else is
 * treated as transient and left unacknowledged for redelivery.
 */
export class PermanentEventFailure extends Error {
  override readonly name = 'PermanentEventFailure';
}

export function streamNameFor(prefix: string, tenantId: string): string {
  return `${prefix}.${tenantId}`;
}
