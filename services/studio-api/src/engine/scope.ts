/**
 * Per-run execution scope carried through graph nodes and executors. Built by
 * the orchestrator from the runs row so nodes never re-query identity.
 */
export interface RunScope {
  runId: string;
  tenantId: string;
  workflowId: string;
  workflowVersionId: string;
  workflowName: string;
  correlationId: string;
  triggerEventId: string;
  dryRun: boolean;
}

/**
 * Job gateway port. The shipped binding is BullMQ on Redis (queue.ts); tests
 * and the engine can bind an inline executor instead.
 */
export interface QueueGateway {
  enqueueRunStart: (tenantId: string, runId: string) => Promise<void>;
  enqueueRunStep: (tenantId: string, runId: string) => Promise<void>;
  scheduleApprovalTimeout: (job: { tenantId: string; runId: string; approvalId: string; runAt: Date }) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

