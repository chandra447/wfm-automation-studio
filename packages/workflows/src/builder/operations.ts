import { z } from 'zod';
import { defaultValidationContext, type Diagnostic, type ValidationContext } from '../diagnostics.ts';
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from '../dsl.ts';
import { defaultNodeOf, kindFor, workflowNodeSchema, workflowNodeTypeSchema } from '../kinds/registry.ts';
import { edgeRefusal } from '../edge-rules.ts';
import { NODE_HEIGHT, NODE_WIDTH, edgePortSchema, nodeIdSchema } from '../primitives.ts';
import type { CanvasLayout } from '../templates/layout.ts';
import { validateWorkflow, validationErrors } from '../validate.ts';

/**
 * The builder's edit language. A chat turn, a template, or a test all describe a
 * change to the graph as a list of these operations, and one applier turns them
 * into a definition. The edit surface stays this small on purpose: nothing here
 * can express a node shape, a port, or an edge the DSL does not already allow,
 * so a model can propose a change without being able to invent one.
 */

const positionSchema = z.object({ x: z.number(), y: z.number() });

const portRefSchema = z.object({ node: nodeIdSchema, port: edgePortSchema });

export const builderOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_node'),
    id: nodeIdSchema,
    type: workflowNodeTypeSchema,
    label: z.string().min(1).max(80).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    position: positionSchema.optional(),
  }),
  z.object({
    op: z.literal('update_node'),
    id: nodeIdSchema,
    label: z.string().min(1).max(80).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    op: z.literal('remove_node'),
    id: nodeIdSchema,
  }),
  z.object({
    op: z.literal('move_node'),
    id: nodeIdSchema,
    position: positionSchema,
  }),
  z.object({
    op: z.literal('connect'),
    from: portRefSchema,
    to: nodeIdSchema,
  }),
  z.object({
    op: z.literal('disconnect'),
    from: portRefSchema,
    to: nodeIdSchema,
  }),
]);

export type BuilderOperation = z.infer<typeof builderOperationSchema>;

export interface OperationRejection {
  /** The operation that was refused, or `definition` when the whole edit was. */
  op: BuilderOperation['op'] | 'definition';
  target: string;
  reason: string;
}

export interface OperationOutcome {
  definition: WorkflowDefinition;
  layout: CanvasLayout;
  /** One line per accepted operation, in the order they were asked for. */
  applied: string[];
  rejected: OperationRejection[];
  /** Diagnostics for the definition this call returns. */
  diagnostics: Diagnostic[];
  /** True when every operation was dropped because the edit made the graph worse. */
  reverted: boolean;
}

interface Draft {
  nodes: Map<string, WorkflowNode>;
  edges: WorkflowEdge[];
  positions: Record<string, { x: number; y: number }>;
  applied: string[];
  rejected: OperationRejection[];
  slot: number;
}

function reject(draft: Draft, op: OperationRejection['op'], target: string, reason: string): void {
  draft.rejected.push({ op, target, reason });
}

/** Zod's first issue, phrased so the caller can act on it. */
function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'the value does not match the schema';
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/**
 * The config keys a kind accepts, read off its own schema. The parse would drop
 * an unknown key silently, which for a caller that is guessing at field names
 * looks like success and teaches nothing, so the applier checks first and says
 * what the kind actually takes.
 */
function configKeysOf(type: WorkflowNodeType): string[] {
  const schema = kindFor(type).schema;
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

function unknownConfigKeys(type: WorkflowNodeType, config: Record<string, unknown> | undefined): string[] {
  if (config === undefined) return [];
  const accepted = configKeysOf(type);
  return Object.keys(config).filter((key) => !accepted.includes(key));
}

/**
 * Where a node lands when the caller did not place it: one column right of
 * everything already on the canvas, stepped down so several additions in one
 * turn do not stack on each other.
 */
function nextPosition(draft: Draft): { x: number; y: number } {
  const rightMost = Object.values(draft.positions).reduce((max, placed) => Math.max(max, placed.x), 0);
  const slot = draft.slot;
  draft.slot += 1;
  return { x: rightMost + NODE_WIDTH + 80, y: slot * (NODE_HEIGHT + 48) };
}

function addNode(draft: Draft, operation: Extract<BuilderOperation, { op: 'add_node' }>): void {
  if (draft.nodes.has(operation.id)) {
    reject(draft, operation.op, operation.id, `node id "${operation.id}" already exists`);
    return;
  }
  const unknown = unknownConfigKeys(operation.type, operation.config);
  if (unknown.length > 0) {
    reject(
      draft,
      operation.op,
      operation.id,
      `a ${operation.type} node has no config key ${unknown.map((key) => `"${key}"`).join(', ')}; it takes ${configKeysOf(operation.type).join(', ')}`,
    );
    return;
  }
  const base = defaultNodeOf(operation.type, operation.id);
  const parsed = workflowNodeSchema.safeParse({
    ...base,
    ...(operation.label === undefined ? {} : { label: operation.label }),
    config: { ...base.config, ...operation.config },
  });
  if (!parsed.success) {
    reject(draft, operation.op, operation.id, `not a valid ${operation.type} node — ${issueMessage(parsed.error)}`);
    return;
  }
  draft.nodes.set(operation.id, parsed.data);
  draft.positions[operation.id] = operation.position ?? nextPosition(draft);
  draft.applied.push(`added ${operation.type} "${parsed.data.label}" as ${operation.id}`);
}

function updateNode(draft: Draft, operation: Extract<BuilderOperation, { op: 'update_node' }>): void {
  const current = draft.nodes.get(operation.id);
  if (!current) {
    reject(draft, operation.op, operation.id, `no node "${operation.id}"`);
    return;
  }
  const unknown = unknownConfigKeys(current.type, operation.config);
  if (unknown.length > 0) {
    reject(
      draft,
      operation.op,
      operation.id,
      `a ${current.type} node has no config key ${unknown.map((key) => `"${key}"`).join(', ')}; it takes ${configKeysOf(current.type).join(', ')}`,
    );
    return;
  }
  const parsed = workflowNodeSchema.safeParse({
    ...current,
    ...(operation.label === undefined ? {} : { label: operation.label }),
    ...(operation.config === undefined ? {} : { config: { ...current.config, ...operation.config } }),
  });
  if (!parsed.success) {
    reject(draft, operation.op, operation.id, `not a valid ${current.type} node — ${issueMessage(parsed.error)}`);
    return;
  }
  draft.nodes.set(operation.id, parsed.data);
  draft.applied.push(`updated ${operation.id}`);
}

function removeNode(draft: Draft, operation: Extract<BuilderOperation, { op: 'remove_node' }>): void {
  if (!draft.nodes.has(operation.id)) {
    reject(draft, operation.op, operation.id, `no node "${operation.id}"`);
    return;
  }
  draft.nodes.delete(operation.id);
  const before = draft.edges.length;
  draft.edges = draft.edges.filter((edge) => edge.from !== operation.id && edge.to !== operation.id);
  delete draft.positions[operation.id];
  const dropped = before - draft.edges.length;
  draft.applied.push(`removed ${operation.id}${dropped > 0 ? ` and ${dropped} edge(s)` : ''}`);
}

function connect(draft: Draft, operation: Extract<BuilderOperation, { op: 'connect' }>): void {
  const from = draft.nodes.get(operation.from.node);
  const to = draft.nodes.get(operation.to);
  if (!from || !to) {
    const missing = from ? operation.to : operation.from.node;
    reject(draft, operation.op, missing, `no node "${missing}"`);
    return;
  }
  const candidate: WorkflowEdge = { from: operation.from.node, to: operation.to, port: operation.from.port };
  const refusal = edgeRefusal({ nodes: [...draft.nodes.values()], edges: draft.edges }, candidate);
  if (refusal !== null) {
    reject(draft, operation.op, from.id, refusal);
    return;
  }
  draft.edges.push({ from: operation.from.node, to: operation.to, port: operation.from.port });
  draft.applied.push(`connected ${operation.from.node} --${operation.from.port}--> ${operation.to}`);
}

function disconnect(draft: Draft, operation: Extract<BuilderOperation, { op: 'disconnect' }>): void {
  const index = draft.edges.findIndex(
    (edge) => edge.from === operation.from.node && edge.port === operation.from.port && edge.to === operation.to,
  );
  if (index === -1) {
    reject(
      draft,
      operation.op,
      operation.from.node,
      `no edge from ${operation.from.node} on ${operation.from.port} to ${operation.to}`,
    );
    return;
  }
  draft.edges.splice(index, 1);
  draft.applied.push(`disconnected ${operation.from.node} --${operation.from.port}--> ${operation.to}`);
}

function applyOne(draft: Draft, operation: BuilderOperation): void {
  switch (operation.op) {
    case 'add_node':
      addNode(draft, operation);
      return;
    case 'update_node':
      updateNode(draft, operation);
      return;
    case 'remove_node':
      removeNode(draft, operation);
      return;
    case 'move_node': {
      if (!draft.nodes.has(operation.id)) {
        reject(draft, operation.op, operation.id, `no node "${operation.id}"`);
        return;
      }
      draft.positions[operation.id] = operation.position;
      draft.applied.push(`moved ${operation.id}`);
      return;
    }
    case 'connect':
      connect(draft, operation);
      return;
    case 'disconnect':
      disconnect(draft, operation);
      return;
  }
}

function revert(
  definition: WorkflowDefinition,
  layout: CanvasLayout,
  draft: Draft,
  context: ValidationContext,
  reason: string,
): OperationOutcome {
  return {
    definition,
    layout,
    applied: [],
    rejected: [...draft.rejected, { op: 'definition', target: '', reason }],
    diagnostics: validateWorkflow(definition, context),
    reverted: true,
  };
}

/**
 * Applies operations to a definition in order. A rejected operation leaves the
 * graph untouched and the rest still apply, so one bad guess does not throw away
 * a good plan. The exception is the graph itself: an edit that would leave the
 * definition with more errors than it started with is dropped whole, because the
 * studio will not store a draft that fails validation, and a half-applied edit
 * is harder to explain than a refused one.
 */
export function applyOperations(
  definition: WorkflowDefinition,
  layout: CanvasLayout,
  operations: readonly BuilderOperation[],
  context: ValidationContext = defaultValidationContext(),
): OperationOutcome {
  const before = validationErrors(validateWorkflow(definition, context)).length;
  const draft: Draft = {
    nodes: new Map(definition.nodes.map((node) => [node.id, node])),
    edges: [...definition.edges],
    positions: { ...layout.positions },
    applied: [],
    rejected: [],
    slot: 0,
  };

  for (const operation of operations) applyOne(draft, operation);

  const candidate = workflowDefinitionSchema.safeParse({
    ...definition,
    nodes: [...draft.nodes.values()],
    edges: draft.edges,
  });
  if (!candidate.success) {
    return revert(definition, layout, draft, context, `the edit does not describe a workflow — ${issueMessage(candidate.error)}`);
  }

  const diagnostics = validateWorkflow(candidate.data, context);
  const errors = validationErrors(diagnostics);
  if (errors.length > before) {
    const named = errors.map((error) => `${error.code}${error.nodeId ? `@${error.nodeId}` : ''}`).join(', ');
    return revert(definition, layout, draft, context, `the edit would leave ${errors.length} validation error(s): ${named}`);
  }

  return {
    definition: candidate.data,
    layout: { ...layout, positions: draft.positions },
    applied: draft.applied,
    rejected: draft.rejected,
    diagnostics,
    reverted: false,
  };
}
