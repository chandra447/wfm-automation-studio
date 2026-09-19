import type { AnyWfmEvent } from '@wfm/contracts';
import { PermanentEventFailure, type EventBus, type SubscribeOptions, type Subscription } from './types.ts';

interface Queued {
  raw: string;
  event: AnyWfmEvent;
}

/**
 * In-memory binding used by unit and service tests. Delivery is synchronous and
 * fail-fast: the handler runs inside `publish`, so a test can assert effects
 * immediately after publishing without polling.
 */
export class InMemoryEventBus implements EventBus {
  readonly #streams: Record<string, Queued[]> = {};
  readonly #deadLetters: Record<string, Array<{ raw: string; reason: string }>> = {};

  published(tenantId: string): AnyWfmEvent[] {
    return (this.#streams[tenantId] ?? []).map((entry) => entry.event);
  }

  deadLetters(tenantId: string): Array<{ raw: string; reason: string }> {
    return this.#deadLetters[tenantId] ?? [];
  }

  async publish(tenantId: string, event: AnyWfmEvent): Promise<void> {
    const queue = (this.#streams[tenantId] ??= []);
    queue.push({ raw: JSON.stringify(event), event });

    for (const subscription of this.#subscribers) {
      if (subscription.tenantId !== tenantId || subscription.stopped) continue;
      try {
        await subscription.onEvent(event);
      } catch (error) {
        if (error instanceof PermanentEventFailure) {
          const deadLetters = (this.#deadLetters[tenantId] ??= []);
          deadLetters.push({ raw: JSON.stringify(event), reason: error.message });
          await subscription.onPermanentFailure?.(JSON.stringify(event), error.message);
          continue;
        }
        throw error;
      }
    }
  }

  readonly #subscribers: Array<SubscribeOptions & { stopped: boolean }> = [];

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    const record = { ...options, stopped: false };
    this.#subscribers.push(record);
    return {
      stop: async () => {
        record.stopped = true;
      },
    };
  }

  async close(): Promise<void> {
    this.#subscribers.length = 0;
  }
}
