import type { AnyWfmEvent } from '@wfm/contracts';
import { parseEvent } from '@wfm/contracts';
import { Redis } from 'ioredis';
import {
  PermanentEventFailure,
  streamNameFor,
  type EventBus,
  type SubscribeOptions,
  type Subscription,
} from './types.ts';

export interface RedisBusOptions {
  url: string;
  prefix?: string;
  /** How long a message may sit unacknowledged before it is re-claimed. */
  claimIdleMs?: number;
  /** Redis Streams cannot partition: tenant isolation is one stream per tenant. */
  maxStreamLength?: number;
}

const DEFAULT_CLAIM_IDLE_MS = 15_000;
const DEFAULT_MAX_STREAM_LENGTH = 10_000;

/**
 * Redis Streams binding.
 *
 * Mapping to Azure Event Hubs, which is the production binding:
 *   stream                    → event hub (partitioned by tenant key)
 *   consumer group            → consumer group
 *   entry id                  → offset
 *   XACK                      → checkpoint
 *   unacked + XAUTOCLAIM      → redelivery after a consumer dies
 *   `<stream>.dlq`            → dead-letter hub
 */
export class RedisStreamsEventBus implements EventBus {
  readonly #redis: Redis;
  readonly #blocker: Redis;
  readonly #prefix: string;
  readonly #claimIdleMs: number;
  readonly #maxStreamLength: number;

  constructor(options: RedisBusOptions) {
    this.#redis = new Redis(options.url, { maxRetriesPerRequest: null });
    this.#blocker = new Redis(options.url, { maxRetriesPerRequest: null });
    this.#prefix = options.prefix ?? 'wfm.events';
    this.#claimIdleMs = options.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS;
    this.#maxStreamLength = options.maxStreamLength ?? DEFAULT_MAX_STREAM_LENGTH;
  }

  async ping(): Promise<void> {
    await this.#redis.ping();
  }

  async publish(tenantId: string, event: AnyWfmEvent): Promise<void> {
    const stream = streamNameFor(this.#prefix, tenantId);
    await this.#redis.xadd(
      stream,
      'MAXLEN',
      '~',
      String(this.#maxStreamLength),
      '*',
      'event',
      JSON.stringify(event),
    );
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    const stream = streamNameFor(this.#prefix, options.tenantId);
    const deadLetterStream = `${stream}.dlq`;
    await this.#ensureGroup(stream, options.group);

    let stopped = false;
    const loop = this.#consumeLoop({
      stream,
      deadLetterStream,
      options,
      isStopped: () => stopped,
    });

    return {
      stop: async () => {
        stopped = true;
        await loop;
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.#redis.quit(), this.#blocker.quit()]);
  }

  async #ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.#redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  async #consumeLoop(input: {
    stream: string;
    deadLetterStream: string;
    options: SubscribeOptions;
    isStopped: () => boolean;
  }): Promise<void> {
    const { stream, deadLetterStream, options, isStopped } = input;

    while (!isStopped() && !options.signal?.aborted) {
      const reclaimed = await this.#reclaimStale(stream, options);
      if (reclaimed > 0) continue;

      const response = (await this.#blocker.xreadgroup(
        'GROUP',
        options.group,
        options.consumer,
        'COUNT',
        '10',
        'BLOCK',
        '1000',
        'STREAMS',
        stream,
        '>',
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!response) continue;

      for (const [, entries] of response) {
        for (const [entryId, fields] of entries) {
          await this.#handleEntry({ stream, deadLetterStream, options, entryId, fields });
        }
      }
    }
  }

  async #reclaimStale(stream: string, options: SubscribeOptions): Promise<number> {
    const response = (await this.#redis.xautoclaim(
      stream,
      options.group,
      options.consumer,
      String(this.#claimIdleMs),
      '0-0',
      'COUNT',
      '10',
    )) as [string, Array<[string, string[]]>, string[]];

    const entries = response[1] ?? [];
    for (const [entryId, fields] of entries) {
      await this.#handleEntry({
        stream,
        deadLetterStream: `${stream}.dlq`,
        options,
        entryId,
        fields,
      });
    }
    return entries.length;
  }

  async #handleEntry(input: {
    stream: string;
    deadLetterStream: string;
    options: SubscribeOptions;
    entryId: string;
    fields: string[];
  }): Promise<void> {
    const { stream, deadLetterStream, options, entryId, fields } = input;
    const raw = fields[fields.indexOf('event') + 1] ?? '';

    try {
      const event = parseEvent(JSON.parse(raw));
      await options.onEvent(event);
      await this.#redis.xack(stream, options.group, entryId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentEventFailure) {
        await this.#redis.xadd(deadLetterStream, '*', 'event', raw, 'reason', reason);
        await this.#redis.xack(stream, options.group, entryId);
        await options.onPermanentFailure?.(raw, reason);
        return;
      }
      // Transient: leave unacknowledged so it is reclaimed after idleMs.
    }
  }
}
