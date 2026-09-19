import type { WorkflowDefinition, WorkflowNode, WorkflowNodeType } from './dsl.ts';
import { assertValidWorkflow } from './validate.ts';

/**
 * Compiles a validated definition into a GraphSpec: a flat, executable
 * description the engine maps onto its graph runtime. Keeping the spec free of
 * runtime types means the compiler is unit-testable and the graph runtime is
 * replaceable.
 */

export interface GraphSpecNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: WorkflowNode['config'];
  /** Outgoing transitions keyed by port; `always` is the default path. */
  transitions: Array<{ port: string; to: string }>;
}

export interface GraphSpec {
  entry: string;
  nodes: GraphSpecNode[];
  terminals: string[];
  /** Nodes whose outcome a human decides; the orchestrator uses this for SLAs. */
  approvalNodeIds: string[];
  /** Nodes that write to a domain service; used for audit and dry-run handling. */
  actionNodeIds: string[];
}

export class WorkflowCompileError extends Error {
  override readonly name = 'WorkflowCompileError';
}

export function compileWorkflow(definition: WorkflowDefinition): GraphSpec {
  assertValidWorkflow(definition);

  const outgoing: Record<string, Array<{ port: string; to: string }>> = {};
  for (const edge of definition.edges) {
    (outgoing[edge.from] ??= []).push({ port: edge.port, to: edge.to });
  }

  const nodes = definition.nodes.map<GraphSpecNode>((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    config: node.config,
    transitions: outgoing[node.id] ?? [],
  }));

  const trigger = definition.nodes.find((node) => node.type === 'trigger');
  if (!trigger) throw new WorkflowCompileError('definition has no trigger node');

  return {
    entry: trigger.id,
    nodes,
    terminals: nodes.filter((node) => node.type === 'end').map((node) => node.id),
    approvalNodeIds: nodes.filter((node) => node.type === 'human_approval').map((node) => node.id),
    actionNodeIds: nodes.filter((node) => node.type === 'action').map((node) => node.id),
  };
}
