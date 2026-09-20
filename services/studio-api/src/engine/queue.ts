import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Orchestrator } from './orchestrator.ts';
import type { QueueGateway } from './scope.ts';

export const RUN_QUEUE = 'studio-runs';
const JOB_RUN_START = 'run.start';
const JOB_RUN_STEP = 'run.step';
const JOB_APPROVAL_TIMEOUT = 'approval.timeout';
const ATTEMPTS = 4;

export interface QueueOptions {
  redisUrl: string;
  orchestrator: Orchestrator;
  logger: Logger;
  /** Worker concurrency for the whole process. */
  concurrency?: number;
  /** Max in-flight jobs per tenant; the queue itself is shared (ADR-0005). */
  perTenantConcurrency?: number;
}

const jobDataSchema = z.object({
  tenantId: z.uuid(),
  runId: z.uuid(),
  approvalId: z.uuid().optional(),
});

/**
 * BullMQ binding of the job gateway (ADR-0005): one queue, three job kinds
 * (run.start, run.step, approval.timeout), attempts capped at 4 with
 * exponential backoff, delayed jobs for approval timeouts. OSS BullMQ has no
 * tenant groups, so per-tenant concurrency is enforced with an in-process
 * gate; the commands themselves are idempotent, so a skewed schedule is safe.
 */
export function createQueueGateway(options: QueueOptions): QueueGateway & { close: () => Promise<void> } {
  const connection = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
  const gate = new PerTenantGate(options.perTenantConcurrency ?? 2);
  const defaultJobOptions = {
    attempts: ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 2_000 },
  };

  const queue = new Queue(RUN_QUEUE, { connection });
  const worker = new Worker(
    RUN_QUEUE,
    async (job: Job): Promise<unknown> => {
      const data = jobDataSchema.parse(job.data);
      await gate.acquire(data.tenantId);
      try {
        switch (job.name) {
          case JOB_RUN_START:
          case JOB_RUN_STEP:
            return await runStepOrThrow(options.orchestrator, options.logger, job, data);
          case JOB_APPROVAL_TIMEOUT: {
            const result = await options.orchestrator.expireApproval(data.runId, data.approvalId ?? '');
            options.logger.info({ runId: data.runId, approvalId: data.approvalId, result }, 'approval timeout handled');
            return result;
          }
          default:
            throw new Error(`unknown job kind "${job.name}" on the ${RUN_QUEUE} queue`);
        }
      } finally {
        gate.release(data.tenantId);
      }
    },
    { connection, concurrency: options.concurrency ?? 8 },
  );

  worker.on('failed', (job, error) => {
    options.logger.error(
      { queue: RUN_QUEUE, jobId: job?.id, jobName: job?.name, attempts: job?.attemptsMade, error: error.message },
      'queue job failed',
    );
  });

  const gateway: QueueGateway & { close: () => Promise<void> } = {
    enqueueRunStart: async (tenantId, runId) => {
      await queue.add(JOB_RUN_START, { tenantId, runId }, { jobId: `run-start-${runId}`, ...defaultJobOptions });
    },
    enqueueRunStep: async (tenantId, runId) => {
      await queue.add(JOB_RUN_STEP, { tenantId, runId }, { jobId: `run-recover-${runId}`, ...defaultJobOptions });
    },
    scheduleApprovalTimeout: async (job) => {
      const delay = Math.max(0, job.runAt.getTime() - Date.now());
      await queue.add(
        JOB_APPROVAL_TIMEOUT,
        { tenantId: job.tenantId, runId: job.runId, approvalId: job.approvalId },
        { jobId: `approval-timeout-${job.approvalId}`, delay, ...defaultJobOptions },
      );
    },
    start: async () => {
      await worker.resume();
    },
    stop: async () => {
      await worker.close();
      await queue.close();
    },
    close: async () => {
      await connection.quit();
    },
  };
  return gateway;
}

async function runStepOrThrow(
  orchestrator: Orchestrator,
  logger: Logger,
  job: Job,
  data: z.infer<typeof jobDataSchema>,
): Promise<unknown> {
  try {
    return await orchestrator.runStep(data.runId);
  } catch (error) {
    if (isLastAttempt(job)) {
      logger.warn({ runId: data.runId }, 'final attempt failed; marking run failed');
      await orchestrator.failRun(data.runId, error);
    }
    throw error;
  }
}

function isLastAttempt(job: Job): boolean {
  const maxAttempts = job.opts?.attempts ?? 1;
  return job.attemptsStarted >= maxAttempts;
}

/** In-process gate enforcing a concurrency cap per tenant. */
class PerTenantGate {
  readonly #limit: number;
  readonly #inFlight: Record<string, number> = {};
  readonly #waiters: Record<string, Array<() => void>> = {};

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  async acquire(tenantId: string): Promise<void> {
    const count = (this.#inFlight[tenantId] ?? 0) + 1;
    this.#inFlight[tenantId] = count;
    if (count <= this.#limit) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    (this.#waiters[tenantId] ??= []).push(resolve);
    await promise;
  }

  release(tenantId: string): void {
    const next = (this.#inFlight[tenantId] ?? 1) - 1;
    this.#inFlight[tenantId] = Math.max(0, next);
    const waiter = this.#waiters[tenantId]?.shift();
    waiter?.();
  }
}
