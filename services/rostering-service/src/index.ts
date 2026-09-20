import { createEventBus } from '@wfm/eventbus';
import { ensureOutboxTable, OutboxPublisher } from '@wfm/outbox';
import { createLogger } from '@wfm/observability';
import { SQL } from 'bun';
import { createRosteringApp } from './app.ts';

const logger = createLogger('rostering-service');
const port = Number(process.env.ROSTERING_PORT ?? 4101);
const databaseUrl = process.env.ROSTERING_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/rostering';

const sql = new SQL(databaseUrl, { max: 10 });
await ensureOutboxTable(sql);

const publisher = new OutboxPublisher({
  sql,
  bus: createEventBus({
    ...(process.env.EVENT_BACKBONE === undefined ? {} : { EVENT_BACKBONE: process.env.EVENT_BACKBONE }),
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    ...(process.env.EVENT_STREAM_PREFIX === undefined ? {} : { EVENT_STREAM_PREFIX: process.env.EVENT_STREAM_PREFIX }),
  }),
  onError: (error, event) => logger.error({ err: error, eventId: event?.eventId }, 'outbox publish failed'),
});
await publisher.start();

const app = createRosteringApp(sql);
app.listen(port);

logger.info({ port, database: new URL(databaseUrl).pathname }, 'rostering-service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'shutting down');
    await publisher.stop();
    await sql.close({ timeout: 5 });
    process.exit(0);
  });
}
