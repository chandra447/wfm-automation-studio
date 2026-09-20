import { defaultNodeOf, summaryOf } from '@wfm/workflows';
import { triggerCatalog } from '@wfm/contracts';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePortSchema,
  legalPortsByNodeType,
  portLabels,
  workflowDefinitionSchema,
  type CanvasLayout,
  type EdgePort,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@wfm/workflows';
import type { Diagnostic } from '@wfm/workflows';
import type { Edge, Node } from '@xyflow/react';

export interface BuilderSnapshot {
  definition: WorkflowDefinition;
  layout: CanvasLayout;
}

export interface BuilderNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  diagnostics: Diagnostic[];
}

export type BuilderFlowNode = Node<BuilderNodeData, 'wfm'>;

export const NODE_TYPE = 'wfm' as const;

/** Node accents come from the theme tokens named after the node type. */
export const accentVarByNodeType: Record<WorkflowNodeType, string> = {
  trigger: 'var(--color-node-trigger)',
  condition: 'var(--color-node-condition)',
  ai_decision: 'var(--color-node-ai)',
  policy_check: 'var(--color-node-policy)',
  human_approval: 'var(--color-node-approval)',
  action: 'var(--color-node-action)',
  artifact: 'var(--color-node-artifact)',
  end: 'var(--color-node-end)',
};

export function edgeKey(edge: WorkflowEdge): string {
  return `${edge.from}::${edge.port}::${edge.to}`;
}

export function legalPortsFor(nodeType: WorkflowNodeType): readonly EdgePort[] {
  return legalPortsByNodeType[nodeType];
}

export function isEdgePort(value: string | null | undefined): value is EdgePort {
  return typeof value === 'string' && edgePortSchema.safeParse(value).success;
}

/**
 * Flow nodes for the canvas. Every committed edit rebuilds this array, and
 * React Flow drops a node's selection when the node object is replaced without
 * a `selected` flag — so the selected id is carried through here, otherwise the
 * inspector would close on the first keystroke of a field edit.
 */
export function toFlowNodes(
  definition: WorkflowDefinition,
  layout: CanvasLayout,
  grouped: Record<string, Diagnostic[]>,
  selectedId: string | null,
): BuilderFlowNode[] {
  return definition.nodes.map((node) => ({
    id: node.id,
    type: NODE_TYPE,
    position: layout.positions[node.id] ?? { x: 0, y: 0 },
    selected: node.id === selectedId,
    data: { node, diagnostics: grouped[node.id] ?? [] },
  }));
}

export function toFlowEdges(definition: WorkflowDefinition): Edge[] {
  return definition.edges.map((edge) => ({
    id: edgeKey(edge),
    source: edge.from,
    target: edge.to,
    sourceHandle: edge.port,
    label: portLabels[edge.port],
    labelStyle: { fill: 'var(--color-ink-muted)', fontSize: 10 },
    labelBgStyle: { fill: 'var(--color-canvas)', fillOpacity: 0.95 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
  }));
}

export function diagnosticsByNode(diagnostics: Diagnostic[]): Record<string, Diagnostic[]> {
  const grouped: Record<string, Diagnostic[]> = {};
  for (const diagnostic of diagnostics) {
    if (!diagnostic.nodeId) continue;
    (grouped[diagnostic.nodeId] ??= []).push(diagnostic);
  }
  return grouped;
}

function isFlowPosition(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === 'number' && typeof candidate.y === 'number';
}

export function parseLocalLayout(value: unknown): CanvasLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const viewport = candidate.viewport;
  if (typeof viewport !== 'object' || viewport === null) return null;
  const viewportRecord = viewport as Record<string, unknown>;
  if (
    typeof viewportRecord.x !== 'number' ||
    typeof viewportRecord.y !== 'number' ||
    typeof viewportRecord.zoom !== 'number'
  ) {
    return null;
  }
  const positions: CanvasLayout['positions'] = {};
  if (typeof candidate.positions === 'object' && candidate.positions !== null) {
    for (const [nodeId, position] of Object.entries(candidate.positions as Record<string, unknown>)) {
      if (isFlowPosition(position)) positions[nodeId] = position;
    }
  }
  return { viewport: { x: viewportRecord.x, y: viewportRecord.y, zoom: viewportRecord.zoom }, positions };
}

export interface LocalDraft {
  savedAt: number;
  snapshot: BuilderSnapshot;
}

const LOCAL_DRAFT_PREFIX = 'wfm.builder.';

export function readLocalDraft(workflowId: string): LocalDraft | null {
  const raw = window.localStorage.getItem(`${LOCAL_DRAFT_PREFIX}${workflowId}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const parsedDefinition = workflowDefinitionSchema.safeParse(record.definition);
    const layout = parseLocalLayout(record.layout);
    if (!parsedDefinition.success || !layout) return null;
    return {
      savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
      snapshot: { definition: parsedDefinition.data, layout },
    };
  } catch {
    return null;
  }
}

export function writeLocalDraft(workflowId: string, snapshot: BuilderSnapshot): void {
  const payload = JSON.stringify({
    savedAt: Date.now(),
    definition: snapshot.definition,
    layout: snapshot.layout,
  });
  try {
    window.localStorage.setItem(`${LOCAL_DRAFT_PREFIX}${workflowId}`, payload);
  } catch {
    // Storage quota or private-mode block; autosave to the server still applies.
  }
}

export function clearLocalDraft(workflowId: string): void {
  window.localStorage.removeItem(`${LOCAL_DRAFT_PREFIX}${workflowId}`);
}

export function nodeSummary(node: WorkflowNode): string {
  return summaryOf(node);
}

/**
 * Applies one field edit. The inspector writes a single key that the kind's own
 * field list declares; the node union cannot express "one key at a time", so
 * this is the one place a loose form value enters a node config.
 */
export function withConfigKey(node: WorkflowNode, key: string, value: unknown): WorkflowNode {
  const config: Record<string, unknown> = { ...node.config };
  if (value === undefined) delete config[key];
  else config[key] = value;
  return { ...node, config } as WorkflowNode;
}

export function nextNodeId(existingIds: readonly string[], nodeType: WorkflowNodeType): string {
  if (!existingIds.includes(nodeType)) return nodeType;
  for (let n = 2; ; n += 1) {
    const candidate = `${nodeType}_${n}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
}

export const NODE_SIZE = { width: NODE_WIDTH, height: NODE_HEIGHT };

export function emptyDefinitionFor(eventType: string): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    name: 'Untitled workflow',
    description: '',
    enabled: true,
    nodes: [
      { id: 'trigger', type: 'trigger', label: 'When it happens', config: { eventType, conditions: [] } },
      { id: 'done', type: 'end', label: 'Done', config: { outcome: 'completed' } },
    ],
    edges: [{ from: 'trigger', to: 'done', port: 'always' }],
  });
}

export function defaultEventType(): string {
  return triggerCatalog()[0]?.eventType ?? 'shift.cancelled';
}

export function defaultNode(nodeType: WorkflowNodeType): WorkflowNode {
  return defaultNodeOf(nodeType, 'pending_id');
}

export type DemoTemplateId = 'coverage-rescue' | 'payroll-exception';

/** Offline entry points: /builder/<template-id> loads the template without the API. */
export function demoTemplateId(workflowId: string): DemoTemplateId | null {
  return workflowId === 'coverage-rescue' || workflowId === 'payroll-exception' ? workflowId : null;
}
