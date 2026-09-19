import { evaluateConditions, type Condition } from '@wfm/contracts';
import type { ConditionNode } from '@wfm/workflows';
import type { RunScope, RunStateFields } from '../state.ts';
import type { ExecutorDeps } from './context.ts';

/**
 * Condition node: evaluates the saved condition list against the trigger
 * envelope with earlier node outputs attached under `nodes.<nodeId>.output`,
 * then routes the `true`/`false` port. Conditions are data — this is the same
 * evaluator the canvas preview and the trigger matcher use.
 */
export async function runConditionNode(
  _scope: RunScope,
  deps: ExecutorDeps,
  node: ConditionNode,
  state: RunStateFields,
): Promise<Pick<RunStateFields, 'nodes' | 'cursor' | 'decision'>> {
  const view = { ...state.event, nodes: state.nodes };
  const evaluation = evaluateConditions(node.config.conditions as Condition[], view);
  for (const result of evaluation.results) {
    deps.logger.debug({
      tenantId: _scope.tenantId,
      runId: _scope.runId,
      nodeId: node.id,
      field: result.condition.field,
      matched: result.matched,
    }, 'condition evaluated');
  }
  return {
    nodes: {
      [node.id]: {
        output: { matched: evaluation.matched, results: evaluation.results },
        summary: `${node.label}: ${evaluation.matched ? 'yes' : 'no'} path`,
      },
    },
    cursor: node.id,
    decision: { nodeId: node.id, port: evaluation.matched ? 'true' : 'false' },
  };
}
