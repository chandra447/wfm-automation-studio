import type { WorkflowNode } from '@wfm/workflows';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';
import { appendAudit } from '../run-store.ts';

/**
 * End node: terminal. The orchestrator reads the node's outcome to close the
 * run record (completed → succeeded, needs_attention → succeeded with a
 * summary flag, stopped → cancelled).
 */
export async function runEndNode(
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  if (node.type !== 'end') throw new Error(`${node.type} executor reached with a ${node.type} node`);
  await appendAudit(deps.db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
    workflowId: scope.workflowId,
    nodeId: node.id,
    action: 'end.reach',
    actor: 'system',
    detail: { outcome: node.config.outcome, dryRun: scope.dryRun },
  });
  return {
    nodes: { [node.id]: { output: { outcome: node.config.outcome }, summary: `${node.label} (${node.config.outcome})` } },
    cursor: node.id,
    decision: { nodeId: node.id, port: 'always' },
  };
}
