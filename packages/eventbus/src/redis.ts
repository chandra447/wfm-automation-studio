import { RedisClient } from 'bun';
import type { AnyWfmEvent } from '@wfm/contracts';
import { parseEvent } from '@wfm/contracts';
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

/** The reply Redis sends for one stream read, which Bun hands back as written. */
type StreamReadReply = Record<string, Array<[string, string[]]>> | null;

/** `[next cursor, entries, ids that no longer exist]`. */
type AutoClaimReply = [string, Array<[string, string[]]>, string[]];

/**
 * Redis Streams binding over Bun's own client, so the bus carries no vendor
 * package. The client types most commands but not the stream ones, so those go
 * through `send` with the command and its arguments, which is the same wire
 * protocol and the same reply shape.
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
  readonly #redis: RedisClient;
  readonly #blocker: RedisClient;
  /** Both sockets before the first command; the constructor cannot await. */
  readonly #ready: Promise<void>;
  readonly #prefix: string;
  readonly #claimIdleMs: number;
  readonly #maxStreamLength: number;

  constructor(options: RedisBusOptions) {
    this.#redis = new RedisClient(options.url);
    this.#blocker = new RedisClient(options.url);
    this.#ready = Promise.all([this.#redis.connect(), this.#blocker.connect()]).then(() => undefined);
    this.#prefix = options.prefix ?? 'wfm.events';
    this.#claimIdleMs = options.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS;
    this.#maxStreamLength = options.maxStreamLength ?? DEFAULT_MAX_STREAM_LENGTH;
  }

  async ping(): Promise<void> {
    await this.#send('PING', []);
  }

  async publish(tenantId: string, event: AnyWfmEvent): Promise<void> {
    await this.#send('XADD', [
      streamNameFor(this.#prefix, tenantId),
      'MAXLEN',
      '~',
      String(this.#maxStreamLength),
      '*',
      'event',
      JSON.stringify(event),
    ]);
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    const stream = streamNameFor(this.#prefix, options.tenantId);
    const deadLetterStream = `${stream}.dlq`;
    await this.#ensureGroup(stream, options.group);

    let stopped = false;
    const loop = this.#consumeLoop({ stream, deadLetterStream, options, isStopped: () => stopped });

    return {
      stop: async () => {
        stopped = true;
        await loop;
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.#redis.close(), this.#blocker.close()]);
  }

  /** A command on the client that is never blocked, which every write uses. */
  async #send(command: string, args: string[]): Promise<unknown> {
    await this.#ready;
    return this.#redis.send(command, args);
  }

  async #ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.#send('XGROUP', ['CREATE', stream, group, '$', 'MKSTREAM']);
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

      await this.#ready;
      const reply = (await this.#blocker.send('XREADGROUP', [
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
      ])) as StreamReadReply;

      for (const entries of Object.values(reply ?? {})) {
        for (const [entryId, fields] of entries) {
          await this.#handleEntry({ stream, deadLetterStream, options, entryId, fields });
        }
      }
    }
  }

  async #reclaimStale(stream: string, options: SubscribeOptions): Promise<number> {
    const reply = (await this.#send('XAUTOCLAIM', [
      stream,
      options.group,
      options.consumer,
      String(this.#claimIdleMs),
      '0-0',
      'COUNT',
      '10',
    ])) as AutoClaimReply;

    const entries = reply[1] ?? [];
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
      await this.#send('XACK', [stream, options.group, entryId]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentEventFailure) {
        await this.#send('XADD', [deadLetterStream, '*', 'event', raw, 'reason', reason]);
        await this.#send('XACK', [stream, options.group, entryId]);
        await options.onPermanentFailure?.(raw, reason);
        return;
      }
      // Transient: leave unacknowledged so it is reclaimed after idleMs.
    }
  }
}
