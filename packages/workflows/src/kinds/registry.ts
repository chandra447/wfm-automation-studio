import { z } from 'zod';
import { edgePortSchema, type EdgePort } from '../primitives.ts';
import type { ValidationContext } from '../diagnostics.ts';
import { actionKind } from './action.ts';
import { aiDecisionKind } from './ai-decision.ts';
import { artifactKind } from './artifact.ts';
import { conditionKind } from './condition.ts';
import { endKind } from './end.ts';
import { humanApprovalKind } from './human-approval.ts';
import { policyCheckKind } from './policy-check.ts';
import { triggerKind } from './trigger.ts';
import type { NodeCapabilities, NodeKind } from './types.ts';

/**
 * The one list of node kinds. Everything else is derived: the runtime schema,
 * the static union, the legal ports, the palette, and the capability lookups
 * the validator and the compiler read.
 *
 * Adding a kind is: one declaration file, one line in `nodeKinds`, and one line
 * in the schema tuple below. The tuple is explicit because zod requires one:
 * `Object.values(nodeKinds).map(...)` compiles to an array, which zod rejects,
 * and the failure mode is silent at runtime while every type collapses.
 */

/** The ordered list of kinds. The schema tuple and the runtime enum both read it. */
export const NODE_TYPE_ORDER = [
  'trigger',
  'condition',
  'ai_decision',
  'policy_check',
  'human_approval',
  'action',
  'artifact',
  'end',
] as const;

export const nodeKinds = {
  trigger: triggerKind,
  condition: conditionKind,
  ai_decision: aiDecisionKind,
  policy_check: policyCheckKind,
  human_approval: humanApprovalKind,
  action: actionKind,
  artifact: artifactKind,
  end: endKind,
} as const;

/** Compile-time guarantee that the registry covers every kind in the order list. */
const registryCoversOrder: Record<(typeof NODE_TYPE_ORDER)[number], NodeKind> = nodeKinds;
void registryCoversOrder;

export const workflowNodeTypeSchema = z.enum(NODE_TYPE_ORDER);

export const workflowNodeSchema = z.discriminatedUnion('type', [
  nodeKinds.trigger.nodeSchema,
  nodeKinds.condition.nodeSchema,
  nodeKinds.ai_decision.nodeSchema,
  nodeKinds.policy_check.nodeSchema,
  nodeKinds.human_approval.nodeSchema,
  nodeKinds.action.nodeSchema,
  nodeKinds.artifact.nodeSchema,
  nodeKinds.end.nodeSchema,
]);

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeType = WorkflowNode['type'];
export type NodeFor<T extends WorkflowNodeType> = Extract<WorkflowNode, { type: T }>;

/** Compile-time guarantee that every registry key matches its kind's literal type. */
type RegistryKeysMatch = {
  [T in WorkflowNodeType]: (typeof nodeKinds)[T]['type'] extends T ? true : never;
}[WorkflowNodeType];
const registryKeysMatch: RegistryKeysMatch = true;
void registryKeysMatch;

/**
 * Narrows a node to one kind without a cast. Executors use this because a union
 * of per-kind signatures cannot be called with the union node type.
 */
export function isNode<K extends WorkflowNodeType>(node: WorkflowNode, type: K): node is NodeFor<K> {
  return node.type === type;
}

export function kindOf(node: WorkflowNode): NodeKind {
  return nodeKinds[node.type];
}

export function kindFor<T extends WorkflowNodeType>(type: T): (typeof nodeKinds)[T] {
  return nodeKinds[type];
}

/** Capabilities for one node, with any config-dependent ones resolved. */
export function capabilitiesOf(node: WorkflowNode): NodeCapabilities {
  const kind = kindOf(node);
  return kind.capabilitiesOf === undefined ? kind.capabilities : kind.capabilitiesOf(node);
}

export function hasCapability(node: WorkflowNode, capability: keyof NodeCapabilities): boolean {
  return capabilitiesOf(node)[capability] === true;
}

export const legalPortsByNodeType = {
  trigger: nodeKinds.trigger.ports,
  condition: nodeKinds.condition.ports,
  ai_decision: nodeKinds.ai_decision.ports,
  policy_check: nodeKinds.policy_check.ports,
  human_approval: nodeKinds.human_approval.ports,
  action: nodeKinds.action.ports,
  artifact: nodeKinds.artifact.ports,
  end: nodeKinds.end.ports,
} satisfies Record<WorkflowNodeType, readonly EdgePort[]>;

export const nodePalette: ReadonlyArray<{ type: WorkflowNodeType; label: string; description: string; accent: string; icon: string }> = [
  { type: 'trigger', ...nodeKinds.trigger.palette },
  { type: 'condition', ...nodeKinds.condition.palette },
  { type: 'ai_decision', ...nodeKinds.ai_decision.palette },
  { type: 'policy_check', ...nodeKinds.policy_check.palette },
  { type: 'human_approval', ...nodeKinds.human_approval.palette },
  { type: 'action', ...nodeKinds.action.palette },
  { type: 'artifact', ...nodeKinds.artifact.palette },
  { type: 'end', ...nodeKinds.end.palette },
];

/** What the canvas creates when a node is dropped on the graph. */
export function defaultNodeOf(type: WorkflowNodeType, id: string): WorkflowNode {
  const kind = nodeKinds[type];
  return workflowNodeSchema.parse({
    id,
    type,
    label: kind.defaultLabel,
    config: kind.schema.parse(kind.defaultConfig),
  });
}

export function summaryOf(node: WorkflowNode): string {
  const kind = kindOf(node);
  const parsed = kind.schema.safeParse(node.config);
  return parsed.success ? kind.summary(parsed.data) : '';
}

export function configRulesFor(node: WorkflowNode, context: ValidationContext) {
  return kindOf(node).configRules.flatMap((rule) => rule(node, context));
}

export function templateSlotsOf(node: WorkflowNode): ReadonlyArray<{ origin: string; template: string; mode: 'inline' | 'whole' }> {
  const kind = kindOf(node);
  const parsed = kind.schema.safeParse(node.config);
  return parsed.success ? kind.templates(parsed.data) : [];
}

export function fieldsOf(type: WorkflowNodeType) {
  return kindFor(type).fields;
}

/** Where an edge may arrive. The canvas draws one target handle per entry. */
export function inputsOf(type: WorkflowNodeType) {
  return kindFor(type).inputs;
}

export const portLabels: Readonly<Record<EdgePort, string>> = {
  always: 'next',
  true: 'yes',
  false: 'no',
  passed: 'passed',
  failed: 'failed',
  approved: 'approved',
  rejected: 'rejected',
};

export { edgePortSchema };
export type { NodeCapabilities, NodeKind };
