import type { EventBus } from '@wfm/eventbus';
import type { Logger } from 'pino';
import type { DomainClients } from '../domain-clients.ts';
import type { TemplateScope } from '@wfm/workflows';
import type { QueueGateway, RunScope } from '../scope.ts';
import type { RunStateFields } from '../state.ts';
import type { RunDb } from '../run-store.ts';
import type { Proposer } from './proposers.ts';

/**
 * Everything a node executor may touch. The proposer is injected (LLM when a
 * key is configured, rules otherwise) so executors never import model clients
 * directly.
 */
export interface ExecutorDeps {
  db: RunDb;
  bus: EventBus;
  clients: DomainClients;
  queue: QueueGateway;
  proposer: Proposer;
  logger: Logger;
}

export type { RunScope };

/**
 * The {{...}} scope for one node execution. One builder so every executor that
 * resolves references sees the same roots, including the run metadata that
 * artifact bodies use.
 */
export function templateScopeOf(scope: RunScope, state: RunStateFields): TemplateScope {
  return {
    input: state.event,
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([id, value]) => [id, { output: value?.output }]),
    ),
    run: {
      runId: scope.runId,
      tenantId: scope.tenantId,
      workflowId: scope.workflowId,
      workflowName: scope.workflowName,
      correlationId: scope.correlationId,
      triggerEventId: scope.triggerEventId,
      // The most recent human turn, so a downstream node can render the
      // reviewer's instruction; empty until an approver sends one.
      feedback: state.messages.at(-1)?.content ?? '',
    },
    now: new Date(),
  };
}
