import type { WorkflowNode } from '@wfm/workflows';
import { appendRunEvent, getFirstRunEvent } from '../run-store.ts';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';

/**
 * Trigger node: records the event as the run's input. The write is guarded by
 * an existence check so a crash-recovery re-execution of the graph cannot
 * append the same `event_received` timeline row twice.
 */
export async function runTriggerNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (node.type !== 'trigger') throw new Error(`${node.type} executor reached with a ${node.type} node`);
  const existing = await getFirstRunEvent(deps.db, scope.runId, 'event_received');
  if (!existing) {
    await appendRunEvent(deps.db, {
      runId: scope.runId,
      kind: 'event_received',
      nodeId: node.id,
      title: `Event ${node.config.eventType} received`,
      detail: node.label,
      data: state.event,
    });
  }
  return {
    nodes: { [node.id]: { output: state.event, summary: `Trigger matched: ${node.config.eventType}` } },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'always' },
  };
}
