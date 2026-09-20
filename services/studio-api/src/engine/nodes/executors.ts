import type { WorkflowNode, WorkflowNodeType } from '@wfm/workflows';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';
import { runActionNode } from './action.ts';
import { runAgentNode } from './agent.ts';
import { runApprovalNode } from './approval.ts';
import { runArtifactNode } from './artifact.ts';
import { runConditionNode } from './condition.ts';
import { runEndNode } from './end.ts';
import { runPolicyNode } from './policy.ts';
import { runProposeNode } from './propose.ts';
import { runTriggerNode } from './trigger.ts';

/**
 * One executor per node kind, in one table. The graph runtime looks a node's
 * executor up by type instead of switching on it, so adding a kind means
 * writing its executor and adding the line here.
 *
 * The signature is uniform on purpose: a union of per-kind signatures cannot be
 * called with the union node type, because the parameter types intersect to
 * never. Executors that need their config narrowed use the isNode predicate
 * from @wfm/workflows.
 */

export interface NodeOutcome extends Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'> {}

export type NodeExecutor = (
  scope: RunScope,
  deps: ExecutorDeps,
  node: WorkflowNode,
  state: RunStateFields,
) => Promise<NodeOutcome>;

export const nodeExecutors: { [K in WorkflowNodeType]: NodeExecutor } = {
  trigger: (scope, deps, node, state) => runTriggerNode(scope, deps, node, state),
  condition: (scope, deps, node, state) => runConditionNode(scope, deps, node, state),
  ai_decision: (scope, deps, node, state) => runProposeNode(scope, deps, node, state),
  agent: (scope, deps, node, state) => runAgentNode(scope, deps, node, state),
  policy_check: (scope, deps, node, state) => runPolicyNode(scope, deps, node, state),
  human_approval: (scope, deps, node, state) => runApprovalNode(scope, deps, node, state),
  action: (scope, deps, node, state) => runActionNode(scope, deps, node, state),
  artifact: (scope, deps, node, state) => runArtifactNode(scope, deps, node, state),
  end: (scope, deps, node) => runEndNode(scope, deps, node),
};

export function executorFor(type: WorkflowNodeType): NodeExecutor {
  return nodeExecutors[type];
}
