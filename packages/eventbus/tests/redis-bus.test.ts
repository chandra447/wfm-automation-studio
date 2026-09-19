/**
 * Redis Streams binding, exercised against the real broker. Skips cleanly when
 * Redis is not running so unit runs stay green on a laptop without infra.
 *
 * Delivery is awaited as a signal from the handler, never by sleeping. The
 * timeout is a failure guard that names what never happened.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeEvent, type AnyWfmEvent } from '@wfm/contracts';
import { PermanentEventFailure, RedisStreamsEventBus, streamNameFor } from '../src/index.ts';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const prefix = `wfm.test.bus.${crypto.randomUUID().slice(0, 8)}`;
const tenantId = crypto.randomUUID();

function signal<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

async function withGuard<T>(promise: Promise<T>, what: string, ms = 15_000): Promise<T> {
  const guard = Promise.withResolvers<never>();
  const timer = setTimeout(() => guard.reject(new Error(`timed out waiting for ${what}`)), ms);
  try {
    return await Promise.race([promise, guard.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function redisReachable(): Promise<boolean> {
  const probe = new RedisStreamsEventBus({ url: redisUrl, prefix });
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

const available = await redisReachable();

function shiftCancelled(): AnyWfmEvent {
  return makeEvent(
    'shift.cancelled',
    {
      shiftId: crypto.randomUUID(),
      locationId: crypto.randomUUID(),
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      hoursUntilStart: 1,
      reason: 'test',
      cancelledByEmployeeId: null,
      requiredQualificationCodes: ['RN'],
      roleName: 'Registered Nurse',
    },
    { tenantId },
  );
}

describe.skipIf(!available)('redis streams event bus', () => {
  let bus: RedisStreamsEventBus;

  beforeAll(() => {
    bus = new RedisStreamsEventBus({ url: redisUrl, prefix, claimIdleMs: 500 });
  });

  afterAll(async () => {
    await bus.close();
  });

  test('delivers a published event to a subscriber in the same consumer group', async () => {
    const delivered = signal<AnyWfmEvent>();
    const subscription = await bus.subscribe({
      tenantId,
      group: 'test-group',
      consumer: 'consumer-a',
      onEvent: async (event) => {
        delivered.resolve(event);
      },
    });

    const event = shiftCancelled();
    await bus.publish(tenantId, event);

    const received = await withGuard(delivered.promise, 'the published event to be consumed');
    await subscription.stop();

    expect(received.eventId).toBe(event.eventId);
    expect(received.eventType).toBe('shift.cancelled');
    expect(streamNameFor(prefix, tenantId)).toContain(tenantId);
  });

  test('leaves a transiently failing message unacknowledged so it is redelivered', async () => {
    const redelivered = signal<number>();
    let attempts = 0;
    const subscription = await bus.subscribe({
      tenantId,
      group: 'retry-group',
      consumer: 'consumer-b',
      onEvent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
        redelivered.resolve(attempts);
      },
    });

    await bus.publish(tenantId, shiftCancelled());

    const count = await withGuard(redelivered.promise, 'the message to be redelivered after a transient failure');
    await subscription.stop();

    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('dead-letters a permanent failure instead of redelivering it', async () => {
    const deadLettered = signal<string>();
    let deliveries = 0;
    const subscription = await bus.subscribe({
      tenantId,
      group: 'dlq-group',
      consumer: 'consumer-c',
      onEvent: async () => {
        deliveries += 1;
        throw new PermanentEventFailure('unknown event type');
      },
      onPermanentFailure: async (raw) => {
        deadLettered.resolve(raw);
      },
    });

    await bus.publish(tenantId, shiftCancelled());

    const raw = await withGuard(deadLettered.promise, 'the message to be dead-lettered');
    await subscription.stop();

    expect(raw).toContain('shift.cancelled');
    expect(deliveries).toBe(1);
  });
});
