import { kindOf } from './kinds/registry.ts';
import type { EdgePort } from './primitives.ts';
import type { WorkflowEdge, WorkflowNode } from './dsl.ts';

/** The part of a definition this rule reads, so a draft can be checked too. */
export interface EdgeGraph {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

/**
 * Whether an edge may exist between two nodes, and why not when it may not.
 *
 * Three callers ask this question and each used to answer it its own way: the
 * builder's applier, which has to refuse an operation and explain itself; the
 * validator, which reports on a whole definition; and the canvas, which decides
 * whether a drag is allowed to land. The canvas is the one a test cannot watch,
 * so the rule lives here where it can be.
 *
 * The reasons are written for a person, and for a model reading a tool result:
 * a refusal names what is wrong and what the legal values are.
 */
export function edgeRefusal(
  graph: EdgeGraph,
  edge: WorkflowEdge,
  options: { ignore?: WorkflowEdge } = {},
): string | null {
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  if (!from) return `no node "${edge.from}"`;
  if (!to) return `no node "${edge.to}"`;

  const sourceKind = kindOf(from);
  if (sourceKind.capabilities.terminal === true) {
    return `a ${from.type} node cannot emit an edge; it ends a path`;
  }
  if (kindOf(to).inputs.length === 0) {
    return `a ${to.type} node cannot be targeted by an edge`;
  }
  if (!sourceKind.ports.includes(edge.port as EdgePort)) {
    return `a ${from.type} node has no "${edge.port}" port; it has ${sourceKind.ports.join(', ')}`;
  }
  if (from.id === to.id) return 'a node cannot feed itself';

  const ignore = options.ignore;
  const live = graph.edges.filter(
    (candidate) =>
      ignore === undefined ||
      !(candidate.from === ignore.from && candidate.to === ignore.to && candidate.port === ignore.port),
  );
  const sameEdge = live.some(
    (candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.port === edge.port,
  );
  if (sameEdge) return `already connected to ${edge.to} on ${edge.port}`;

  // The engine routes a node's outgoing edges through a map keyed by port, so a
  // second edge on the same port would replace the first, and the definition
  // that allowed it would fail to compile rather than fail to validate.
  const portTaken = live.find((candidate) => candidate.from === edge.from && candidate.port === edge.port);
  if (portTaken) {
    return `"${edge.port}" already goes to ${portTaken.to}, and a port carries one target`;
  }
  return null;
}
