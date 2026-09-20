import { z } from 'zod';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import type { ModelDescriptor } from '@wfm/contracts';
import {
  applyOperations,
  builderOperationSchema,
  nodePalette,
  portLabels,
  summaryOf,
  type BuilderOperation,
  type CanvasLayout,
  type Diagnostic,
  type OperationOutcome,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@wfm/workflows';
import { buildDataCatalogue } from '../engine/data-catalogue.ts';
import { kindDetail, kindLines } from './catalogue.ts';

/**
 * What the builder agent may do, expressed as tools. Reads answer questions
 * about the graph. Selections ask the canvas to point at something. Writes do
 * not touch the graph at all: they append to a list of operations, and the same
 * applier the server uses decides what that list may become, so a tool call
 * cannot produce a definition the DSL rejects.
 *
 * Every write tool answers with what the applier said about the plan so far,
 * which is what lets the agent correct itself inside a turn instead of
 * discovering a refusal after the user has seen it.
 */

export interface BuilderFocus {
  nodeIds: string[];
  edgeIds: string[];
}

export interface BuilderToolContext {
  definition: WorkflowDefinition;
  layout: CanvasLayout;
  eventType: string | undefined;
  models: readonly ModelDescriptor[];
  diagnostics: readonly Diagnostic[];
  /** Operations proposed so far this turn, in the order they were accepted. */
  proposed: BuilderOperation[];
  /** Nodes and edges the agent has asked the canvas to point at. */
  focus: BuilderFocus;
}

/** The edge id the canvas and the DSL agree on. */
function edgeIdOf(edge: WorkflowEdge): string {
  return `${edge.from}::${edge.port}::${edge.to}`;
}

/** A node as the agent sees it: identity, kind, the user's label, and its own config. */
function nodeView(node: WorkflowNode, layout: CanvasLayout): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    summary: summaryOf(node),
    position: layout.positions[node.id] ?? null,
    config: node.config,
  };
}

function diagnosticsFor(context: BuilderToolContext, nodeId: string): Diagnostic[] {
  return context.diagnostics.filter((diagnostic) => diagnostic.nodeId === nodeId);
}

/** What a change did, in the applier's own words, minus what was already reported. */
function describe(operation: BuilderOperation): string {
  switch (operation.op) {
    case 'add_node':
      return `add_node ${operation.id}`;
    case 'update_node':
      return `update_node ${operation.id}`;
    case 'remove_node':
      return `remove_node ${operation.id}`;
    case 'move_node':
      return `move_node ${operation.id}`;
    case 'connect':
      return `connect ${operation.from.node} --${operation.from.port}--> ${operation.to}`;
    case 'disconnect':
      return `disconnect ${operation.from.node} --${operation.from.port}--> ${operation.to}`;
  }
}

/**
 * Why the graph as a whole is not valid yet, or null when it is. The applier
 * says so by dropping the edit and naming the errors, which is the condition
 * the agent is told about but not stopped by: a node is added before it is
 * wired, so a turn is allowed to be half-finished in the middle and is judged
 * as a whole at the end.
 */
function graphReasonOf(outcome: OperationOutcome): string | null {
  if (!outcome.reverted) return null;
  return outcome.rejected.find((rejection) => rejection.op === 'definition')?.reason ?? 'the graph is not valid yet';
}

export function builderTools(context: BuilderToolContext): StructuredToolInterface[] {
  /**
   * The applier's report on the plan as it stands. Kept beside the plan so each
   * tool call answers with what the applier says now, rather than with a
   * running commentary the agent has to diff itself.
   */
  let committed: OperationOutcome = applyOperations(context.definition, context.layout, context.proposed);

  /**
   * A tool argument is model output, so it arrives here unvalidated and
   * `builderOperationSchema` is the boundary: it narrows the kind and the port
   * into the DSL's own unions, or refuses the call with the reason.
   *
   * The candidate is judged against the committed plan rather than replacing
   * it, so an operation the applier refuses never enters the list: a plan that
   * carried its own mistakes forward would report the first one for every later
   * call and leave the agent fixing something it already fixed.
   */
  const propose = (candidate: unknown): string => {
    const parsed = builderOperationSchema.safeParse(candidate);
    if (!parsed.success) {
      return `refused: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`;
    }

    const previousRefusals = committed.rejected.filter((rejection) => rejection.op !== 'definition').length;
    const outcome = applyOperations(context.definition, context.layout, [...context.proposed, parsed.data]);
    const refusals = outcome.rejected.filter((rejection) => rejection.op !== 'definition').slice(previousRefusals);
    // A refusal about this operation is a refusal of the call; everything else
    // is the graph being mid-edit, which the agent is told about and can fix.
    if (refusals.length > 0) {
      return refusals.map((rejection) => `refused ${rejection.op} ${rejection.target}: ${rejection.reason}`).join('\n');
    }

    context.proposed.push(parsed.data);
    committed = outcome;
    const graphReason = graphReasonOf(outcome);
    const applied = outcome.applied.length === 0 ? [`recorded: ${describe(parsed.data)}`] : outcome.applied.map((line) => `applied: ${line}`);
    return [...applied, ...(graphReason === null ? [] : [`not valid yet: ${graphReason}`])].join('\n');
  };

  return [
    tool(
      async () =>
        JSON.stringify({
          name: context.definition.name,
          enabled: context.definition.enabled,
          nodes: context.definition.nodes.map((node) => nodeView(node, context.layout)),
          edges: context.definition.edges.map((edge) => ({
            id: edgeIdOf(edge),
            from: edge.from,
            to: edge.to,
            port: edge.port,
            label: portLabels[edge.port],
          })),
          diagnostics: context.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            nodeId: diagnostic.nodeId ?? null,
            message: diagnostic.message,
          })),
        }),
      {
        name: 'read_workflow',
        description:
          'Read the workflow the user is looking at: every node with its id, kind, label, summary, position and config, every edge with its port, and the current validation diagnostics. Call this before changing anything and again if you are unsure what is on the canvas.',
        schema: z.object({}),
      },
    ),

    tool(
      async ({ id }) => {
        const node = context.definition.nodes.find((candidate) => candidate.id === id);
        if (node === undefined) {
          return `no node "${id}"; the graph has ${context.definition.nodes.map((candidate) => candidate.id).join(', ')}`;
        }
        return JSON.stringify({
          ...nodeView(node, context.layout),
          edgesFrom: context.definition.edges.filter((edge) => edge.from === id).map(edgeIdOf),
          edgesInto: context.definition.edges.filter((edge) => edge.to === id).map(edgeIdOf),
          diagnostics: diagnosticsFor(context, id),
        });
      },
      {
        name: 'get_node',
        description: 'Read one node in full, including its config, its edges, and any diagnostics about it.',
        schema: z.object({ id: z.string().describe('The node id, as read_workflow reported it.') }),
      },
    ),

    tool(
      async ({ type }) => {
        if (type === undefined) {
          return `Node kinds and the config keys the applier accepts:\n${kindLines(context.models).join('\n')}`;
        }
        const detail = kindDetail(type, context.models);
        if (detail !== null) return detail;
        const known = nodePalette.map((entry) => entry.type).join(', ');
        return `unknown kind "${type}"; the kinds are: ${known}`;
      },
      {
        name: 'list_node_kinds',
        description:
          'The kinds of node you may add, with their legal ports, every config key they accept, the values each key takes, and their default config. Ask for one kind by name, or with no argument for all of them.',
        schema: z.object({
          type: z.string().optional().describe('A single kind to describe, e.g. "human_approval".'),
        }),
      },
    ),

    tool(
      async () => {
        const catalogue = buildDataCatalogue(context.eventType ?? 'shift.cancelled');
        return JSON.stringify(catalogue.roots);
      },
      {
        name: 'read_data_catalogue',
        description:
          'The paths a template may bind to with {{...}} for this workflow\'s trigger event, each with its type and an example value. Call this before writing any template so the reference resolves at save time.',
        schema: z.object({}),
      },
    ),

    tool(
      async ({ ids, reason }) => {
        const known = new Set(context.definition.nodes.map((node) => node.id));
        const unknown = ids.filter((id) => !known.has(id) && !context.proposed.some((op) => op.op === 'add_node' && op.id === id));
        const selected = ids.filter((id) => !unknown.includes(id));
        for (const id of selected) if (!context.focus.nodeIds.includes(id)) context.focus.nodeIds.push(id);
        const lines = selected.length === 0 ? [] : [`showing ${selected.join(', ')}`];
        if (unknown.length > 0) lines.push(`no node ${unknown.join(', ')}`);
        if (reason !== undefined) lines.push(`for: ${reason}`);
        return lines.join('\n');
      },
      {
        name: 'select_nodes',
        description:
          'Point the canvas at nodes so the user can see which ones you mean. This only highlights them; it changes nothing about the graph. Use it when explaining, reviewing, or asking about specific steps.',
        schema: z.object({
          ids: z.array(z.string()).min(1).describe('Node ids to highlight.'),
          reason: z.string().optional().describe('A few words on why, shown to the user.'),
        }),
      },
    ),

    tool(
      async ({ from, port, to }) => {
        const match = context.definition.edges.find(
          (edge) => edge.from === from && edge.to === to && (port === undefined || edge.port === port),
        );
        if (match === undefined) {
          const available = context.definition.edges.map(edgeIdOf);
          return `no edge ${from} -> ${to}${port === undefined ? '' : ` on ${port}`}; the edges are ${available.join(', ') || 'none'}`;
        }
        const id = edgeIdOf(match);
        if (!context.focus.edgeIds.includes(id)) context.focus.edgeIds.push(id);
        return `showing ${id}`;
      },
      {
        name: 'select_edges',
        description:
          'Point the canvas at edges so the user can see which ones you mean. This only highlights them; it changes nothing about the graph.',
        schema: z.object({
          from: z.string().describe('Source node id.'),
          to: z.string().describe('Target node id.'),
          port: z.string().optional().describe('The port the edge leaves from, when the source has more than one.'),
        }),
      },
    ),

    tool(({ id, type, label, config }) => propose({ op: 'add_node', id, type, label, config }), {
      name: 'add_node',
      description:
        'Add a node. The graph must still be valid afterwards, so wire it in with connect in the same turn: an added node that nothing reaches and that reaches nothing is refused and the whole edit is dropped. Read list_node_kinds first so the config keys are the ones the kind accepts.',
      schema: z.object({
        id: z.string().describe('lower_snake_case id, unique in the graph.'),
        type: z.string().describe('The node kind, e.g. human_approval.'),
        label: z.string().optional().describe('What the user will see on the card.'),
        config: z.record(z.string(), z.unknown()).optional().describe('Config keys for that kind; omitted ones keep the defaults.'),
      }),
    }),

    tool(({ id, label, config }) => propose({ op: 'update_node', id, label, config }), {
      name: 'update_node',
      description:
        'Change an existing node\'s label or config. Config is merged into what is there, so pass only the keys you are changing.',
      schema: z.object({
        id: z.string(),
        label: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    }),

    tool(({ id }) => propose({ op: 'remove_node', id }), {
      name: 'remove_node',
      description:
        'Remove a node and every edge touching it. If that leaves a path with no end, the edit is refused; reconnect in the same turn to fix the path.',
      schema: z.object({ id: z.string() }),
    }),

    tool(({ id, x, y }) => propose({ op: 'move_node', id, position: { x, y } }), {
      name: 'move_node',
      description:
        'Move a node on the canvas. Positions belong to the user, so only move a node when they ask you to.',
      schema: z.object({ id: z.string(), x: z.number(), y: z.number() }),
    }),

    tool(({ from, port, to }) => propose({ op: 'connect', from: { node: from, port }, to }), {
      name: 'connect',
      description:
        'Wire an edge from a node\'s port to another node. The port must be one the source kind has, which list_node_kinds reports.',
      schema: z.object({
        from: z.string().describe('Source node id.'),
        port: z.string().describe('Port on the source, e.g. approved, passed, true, always.'),
        to: z.string().describe('Target node id.'),
      }),
    }),

    tool(({ from, port, to }) => propose({ op: 'disconnect', from: { node: from, port }, to }), {
      name: 'disconnect',
      description: 'Remove one edge, named by its source node, port and target node.',
      schema: z.object({ from: z.string(), port: z.string(), to: z.string() }),
    }),
  ];
}
