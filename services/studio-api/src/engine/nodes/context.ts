import type { EventBus } from '@wfm/eventbus';
import type { Logger } from 'pino';
import type { DomainClients } from '../domain-clients.ts';
import type { QueueGateway, RunScope } from '../scope.ts';
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
