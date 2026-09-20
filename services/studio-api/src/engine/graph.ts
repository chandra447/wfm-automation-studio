import { END, START, StateGraph, Annotation } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { AnyWfmEvent } from '@wfm/contracts';
import type { GraphSpec, WorkflowDefinition, WorkflowNode } from '@wfm/workflows';
import type { RunScope, RunStateFields } from './state.ts';
import type { ExecutorDeps } from './nodes/context.ts';
import { executorFor } from './nodes/executors.ts';

/**
 * The LangGraph runtime mapping (ADR-0005). The compiled GraphSpec is built
 * into a StateGraph dynamically: one node per definition node, conditional
 * edges where a node has ported transitions. State persists through the
 * Postgres checkpointer so `interrupt()` survives a process restart.
 */

const RunState = Annotation.Root({
  runId: Annotation<string>,
  tenantId: Annotation<string>,
  definition: Annotation<WorkflowDefinition>,
  event: Annotation<AnyWfmEvent>,
  nodes: Annotation<RunStateFields['nodes']>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  cursor: Annotation<string>({ reducer: (_current, update) => update, default: () => '' }),
  decision: Annotation<RunStateFields['decision']>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
});

type RunState = typeof RunState.State;

export const END_SENTINEL = '__end__';

export function buildRunGraph(
  spec: GraphSpec,
  definition: WorkflowDefinition,
  scope: RunScope,
  deps: ExecutorDeps,
  checkpointer: BaseCheckpointSaver,
) {
  const nodesById: Record<string, WorkflowNode> = Object.fromEntries(
    definition.nodes.map((node) => [node.id, node]),
  );
  const graph = new StateGraph<typeof RunState, typeof RunState.State, typeof RunState.Update, string>(RunState);

  for (const specNode of spec.nodes) {
    const node = nodesById[specNode.id];
    if (!node) throw new Error(`spec node ${specNode.id} is missing from the definition`);
    graph.addNode(specNode.id, (state: RunState) => executorFor(node.type)(scope, deps, node, state));
  }

  for (const specNode of spec.nodes) {
    if (specNode.type === 'end') {
      graph.addEdge(specNode.id, END);
      continue;
    }
    const transitions = specNode.transitions;
    if (transitions.length === 1 && transitions[0]?.port === 'always') {
      graph.addEdge(specNode.id, transitions[0].to);
      continue;
    }
    const route: Record<string, string> = {};
    for (const transition of transitions) {
      route[transition.port] = transition.to;
    }
    graph.addConditionalEdges(
      specNode.id,
      (state: RunState) => {
        const decision = state.decision;
        if (decision && decision.nodeId === specNode.id && decision.port in route) {
          return decision.port;
        }
        return END_SENTINEL;
      },
      { ...route, [END_SENTINEL]: END },
    );
  }

  graph.addEdge(START, spec.entry);
  return graph.compile({ checkpointer });
}
