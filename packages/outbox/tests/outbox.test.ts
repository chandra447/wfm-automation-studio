/**
 * Transactional outbox against a real Postgres. Skips when the database is not
 * running. The properties asserted here are the ones the design leans on:
 * atomic write, at-least-once publication, retry with backoff, and no
 * duplicate publication after success.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeEvent, type AnyWfmEvent } from '@wfm/contracts';
import { InMemoryEventBus } from '@wfm/eventbus';
import { SQL } from 'bun';
import { enqueueEvents, ensureOutboxTable, OutboxPublisher } from '../src/index.ts';

const adminUrl = process.env.ROSTERING_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/rostering';

async function reachable(): Promise<boolean> {
  const probe = new SQL(adminUrl, { max: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close({ timeout: 2 });
  }
}

const available = await reachable();
const table = `outbox_test_${crypto.randomUUID().slice(0, 8)}`;
const tenantId = crypto.randomUUID();

function shiftUnfilled(): AnyWfmEvent {
  return makeEvent(
    'shift.unfilled',
    {
      shiftId: crypto.randomUUID(),
      locationId: crypto.randomUUID(),
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      hoursUntilStart: 24,
    },
    { tenantId },
  );
}

describe.skipIf(!available)('transactional outbox', () => {
  let sql: SQL;

  beforeAll(async () => {
    sql = new SQL(adminUrl, { max: 2 });
    await ensureOutboxTable(sql, { table });
  });

  afterAll(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await sql.close({ timeout: 5 });
  });

  test('a rolled back transaction leaves no event behind', async () => {
    const event = shiftUnfilled();
    await expect(
      sql.begin(async (tx) => {
        await enqueueEvents(tx, [event], { table });
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');

    const rows = await sql`SELECT count(*)::int AS count FROM ${sql(table)} WHERE event_id = ${event.eventId}`;
    expect(rows[0]?.count).toBe(0);
  });

  test('a committed transaction publishes the event and marks the row sent', async () => {
    const bus = new InMemoryEventBus();
    const event = shiftUnfilled();

    await sql.begin(async (tx) => {
      await enqueueEvents(tx, [event], { table });
    });

    const publisher = new OutboxPublisher({ sql, bus, table, pollMs: 10 });
    const published = await publisher.drain();
    await publisher.stop();

    expect(published).toBeGreaterThanOrEqual(1);
    expect(bus.published(tenantId).map((entry) => entry.eventId)).toContain(event.eventId);

    const rows = await sql<Array<{ published_at: Date | null }>>`
      SELECT published_at FROM ${sql(table)} WHERE event_id = ${event.eventId}
    `;
    expect(rows[0]?.published_at).not.toBeNull();
  });

  test('a second drain does not republish an already published event', async () => {
    const bus = new InMemoryEventBus();
    const publisher = new OutboxPublisher({ sql, bus, table, pollMs: 10 });

    const published = await publisher.drain();
    await publisher.stop();

    expect(published).toBe(0);
    expect(bus.published(tenantId).length).toBe(0);
  });

  test('an unparseable row is poisoned instead of retried forever', async () => {
    const poisonId = crypto.randomUUID();
    await sql`
      INSERT INTO ${sql(table)} (id, tenant_id, event_id, event_type, payload)
      VALUES (${poisonId}, ${tenantId}, ${crypto.randomUUID()}, 'shift.cancelled', ${{ not: 'an envelope' }})
    `;

    const poisoned: Array<{ id: string; eventType: string }> = [];
    const bus = new InMemoryEventBus();
    const publisher = new OutboxPublisher({
      sql,
      bus,
      table,
      pollMs: 10,
      maxAttempts: 2,
      onPoison: async (row) => {
        poisoned.push({ id: row.id, eventType: row.eventType });
      },
    });

    await publisher.drain();
    // The backoff window keeps it out of the second pass, so bring it due.
    await sql`UPDATE ${sql(table)} SET available_at = now(), claimed_at = NULL WHERE id = ${poisonId}`;
    await publisher.drain();
    await publisher.stop();

    const rows = await sql<Array<{ poisoned_at: Date | null; attempts: number }>>`
      SELECT poisoned_at, attempts FROM ${sql(table)} WHERE id = ${poisonId}
    `;
    expect(rows[0]?.poisoned_at).not.toBeNull();
    expect(poisoned.map((entry) => entry.id)).toEqual([poisonId]);

    // Poisoned rows leave the claim window entirely.
    const third = new OutboxPublisher({ sql, bus, table, pollMs: 10, maxAttempts: 2 });
    const published = await third.drain();
    await third.stop();
    expect(published).toBe(0);
  });

  test('a failing publish is retried later rather than dropped', async () => {
    const event = shiftUnfilled();
    await sql.begin(async (tx) => {
      await enqueueEvents(tx, [event], { table });
    });

    const failing = {
      publish: async () => {
        throw new Error('broker down');
      },
      subscribe: async () => ({ stop: async () => {} }),
      close: async () => {},
    };

    const firstPublisher = new OutboxPublisher({ sql, bus: failing, table, pollMs: 10 });
    await firstPublisher.drain();
    await firstPublisher.stop();

    const pending = await sql<Array<{ attempts: number; published_at: Date | null; available_at: Date }>>`
      SELECT attempts, published_at, available_at FROM ${sql(table)} WHERE event_id = ${event.eventId}
    `;
    expect(pending[0]?.published_at).toBeNull();
    expect(pending[0]?.attempts).toBeGreaterThanOrEqual(1);
    expect(pending[0]!.available_at.getTime()).toBeGreaterThan(Date.now());

    // Bring the row back into the claim window instead of sleeping through the
    // backoff: the property under test is "retried", not "retried after 2s".
    await sql`
      UPDATE ${sql(table)} SET available_at = now(), claimed_at = NULL WHERE event_id = ${event.eventId}
    `;

    const bus = new InMemoryEventBus();
    const secondPublisher = new OutboxPublisher({ sql, bus, table, pollMs: 10 });
    await secondPublisher.drain();
    await secondPublisher.stop();

    expect(bus.published(tenantId).map((entry) => entry.eventId)).toContain(event.eventId);
  });
});
