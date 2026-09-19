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

export function toFlowNodes(
  definition: WorkflowDefinition,
  layout: CanvasLayout,
  grouped: Record<string, Diagnostic[]>,
): BuilderFlowNode[] {
  return definition.nodes.map((node) => ({
    id: node.id,
    type: NODE_TYPE,
    position: layout.positions[node.id] ?? { x: 0, y: 0 },
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
  switch (node.type) {
    case 'trigger':
      return node.config.conditions.length > 0
        ? `${node.config.eventType} · ${node.config.conditions.length} filter${node.config.conditions.length === 1 ? '' : 's'}`
        : node.config.eventType;
    case 'condition': {
      const base = node.config.conditions.length === 1 ? '1 condition' : `${node.config.conditions.length} conditions`;
      return node.config.description.length > 0 ? `${base} · ${node.config.description}` : base;
    }
    case 'ai_decision':
      return `${node.config.tools.length} tool${node.config.tools.length === 1 ? '' : 's'}`;
    case 'policy_check':
      return node.config.checks.join(' · ');
    case 'human_approval':
      return `${node.config.role} · ${node.config.timeoutMinutes} min`;
    case 'action':
      return node.config.command;
    case 'end':
      return node.config.outcome;
  }
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
  switch (nodeType) {
    case 'trigger':
      return {
        id: 'trigger',
        type: 'trigger',
        label: 'When it happens',
        config: { eventType: defaultEventType(), conditions: [] },
      };
    case 'condition':
      return {
        id: 'condition',
        type: 'condition',
        label: 'If…',
        config: { description: '', conditions: [{ field: 'payload.hoursUntilStart', op: 'lt', value: 12 }] },
      };
    case 'ai_decision':
      return {
        id: 'ai_decision',
        type: 'ai_decision',
        label: 'AI decision',
        config: {
          goal: 'Describe what the AI should decide and which trade-off it may accept.',
          tools: ['shift.get'],
          output: 'candidate_choice',
          mustCiteEvidence: true,
        },
      };
    case 'policy_check':
      return {
        id: 'policy_check',
        type: 'policy_check',
        label: 'Policy check',
        config: { checks: ['cost_delta_cap'], costCapCents: 0, escalateOnFailure: true },
      };
    case 'human_approval':
      return {
        id: 'human_approval',
        type: 'human_approval',
        label: 'Human approval',
        config: {
          role: 'roster_manager',
          timeoutMinutes: 240,
          escalateTo: 'operations_lead',
          show: ['rationale', 'evidence'],
        },
      };
    case 'action':
      return { id: 'action', type: 'action', label: 'Action', config: { command: 'rostering.send_offers', input: {} } };
    case 'end':
      return { id: 'end', type: 'end', label: 'End', config: { outcome: 'completed' } };
  }
}

export type DemoTemplateId = 'coverage-rescue' | 'payroll-exception';

/** Offline entry points: /builder/<template-id> loads the template without the API. */
export function demoTemplateId(workflowId: string): DemoTemplateId | null {
  return workflowId === 'coverage-rescue' || workflowId === 'payroll-exception' ? workflowId : null;
}
