import { InMemoryEventBus } from './memory.ts';
import { RedisStreamsEventBus } from './redis.ts';
import type { EventBus } from './types.ts';

export * from './types.ts';
export { InMemoryEventBus } from './memory.ts';
export { RedisStreamsEventBus } from './redis.ts';

export interface EventBusEnvironment {
  EVENT_BACKBONE?: string;
  REDIS_URL?: string;
  EVENT_STREAM_PREFIX?: string;
}

/**
 * Bindings: `redis` (default, matches production semantics locally) and
 * `memory` (tests, single-process demos). Production swaps in the Event Hubs
 * adapter documented in ADR-0004 without touching call sites.
 */
export function createEventBus(env: EventBusEnvironment): EventBus {
  const binding = env.EVENT_BACKBONE ?? 'redis';
  if (binding === 'memory') return new InMemoryEventBus();
  if (binding !== 'redis') {
    throw new Error(`Unknown EVENT_BACKBONE "${binding}" (expected "redis" or "memory")`);
  }
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required when EVENT_BACKBONE=redis');
  return new RedisStreamsEventBus({
    url: env.REDIS_URL,
    prefix: env.EVENT_STREAM_PREFIX ?? 'wfm.events',
  });
}
