import type { AnyWfmEvent } from '@wfm/contracts';
import { createEventBus, type EventBus, type EventBusEnvironment } from '@wfm/eventbus';
import { createLogger } from '@wfm/observability';
import { OutboxPublisher } from '@wfm/outbox';
import { createDatabase, type Database } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { createAttendanceService, type AttendanceService } from './domain/attendance.ts';

/**
 * Service-relevant env keys; the index signature keeps `process.env` directly
 * assignable (weak-type check otherwise rejects it).
 */
export interface AttendanceEnv {
  [key: string]: string | undefined;
  TIME_ATTENDANCE_DATABASE_URL?: string | undefined;
  EVENT_BACKBONE?: string | undefined;
  REDIS_URL?: string | undefined;
  EVENT_STREAM_PREFIX?: string | undefined;
}

export interface AttendanceRuntime {
  service: AttendanceService;
  publisher: OutboxPublisher;
  bus: EventBus;
  database: Database;
}

const defaultUrl = 'postgres://wfm:wfm@127.0.0.1:5433/time_attendance';

/**
 * One runtime per process: a single OutboxPublisher drains the outbox into the
 * bus; the service publishes into the same transaction as its domain writes.
 */
export async function createAttendanceRuntime(env: AttendanceEnv): Promise<AttendanceRuntime> {
  const url = env.TIME_ATTENDANCE_DATABASE_URL ?? defaultUrl;
  await migrate(url);
  const runtime = buildRuntime(env, url);
  await runtime.publisher.start();
  return runtime;
}

/** Synchronous construction for the lazy HTTP-layer bootstrap. */
export function createServiceFromEnv(env: AttendanceEnv): AttendanceService {
  const url = env.TIME_ATTENDANCE_DATABASE_URL;
  if (!url) throw new Error('TIME_ATTENDANCE_DATABASE_URL is required');
  return buildRuntime(env, url).service;
}

function buildRuntime(env: AttendanceEnv, url: string): AttendanceRuntime {
  const database = createDatabase(url);
  const busEnv: EventBusEnvironment = {};
  if (env.EVENT_BACKBONE) busEnv.EVENT_BACKBONE = env.EVENT_BACKBONE;
  if (env.REDIS_URL) busEnv.REDIS_URL = env.REDIS_URL;
  if (env.EVENT_STREAM_PREFIX) busEnv.EVENT_STREAM_PREFIX = env.EVENT_STREAM_PREFIX;
  const bus = createEventBus(busEnv);
  const logger = createLogger('time-attendance-service');
  const publisher = new OutboxPublisher({
    sql: database.sql,
    bus,
    onError: (error, event: AnyWfmEvent | null) => {
      logger.error({ err: error, eventId: event?.eventId }, 'outbox publish failed');
    },
  });
  return { service: createAttendanceService({ database }), publisher, bus, database };
}
