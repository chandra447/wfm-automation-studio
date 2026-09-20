import { z } from 'zod';
import {
  aiOutputSchema,
  approvalDisplaySchema,
  edgePortSchema,
  nodeIdSchema,
  policyCheckKindSchema,
  NODE_HEIGHT,
  NODE_WIDTH,
  type EdgePort,
} from './primitives.ts';
import {
  workflowNodeSchema,
  workflowNodeTypeSchema,
  type NodeFor,
  type WorkflowNode,
  type WorkflowNodeType,
} from './kinds/registry.ts';

/**
 * The workflow DSL. Users compose these nodes and edges on the studio canvas;
 * the engine compiles the saved definition into an executable graph. Nothing in
 * this file knows about LangGraph, Redis, or the domain services — it is the
 * contract between the canvas, the validator, and the compiler.
 *
 * The node shapes themselves live in kinds/*.ts, one file per kind. This module
 * assembles them into the definition schema and re-exports the vocabulary the
 * rest of the repo imports from `@wfm/workflows`.
 */

export { edgePortSchema, nodeIdSchema, NODE_HEIGHT, NODE_WIDTH, workflowNodeTypeSchema, workflowNodeSchema };
export type { EdgePort, WorkflowNode, WorkflowNodeType };

export { policyCheckKindSchema, approvalDisplaySchema, aiOutputSchema };
export type { PolicyCheckKind } from './primitives.ts';

export const workflowEdgeSchema = z.object({
  from: nodeIdSchema,
  to: nodeIdSchema,
  port: edgePortSchema.default('always'),
});

export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
  nodes: z.array(workflowNodeSchema).min(2),
  edges: z.array(workflowEdgeSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Per-kind aliases, derived from the union so they cannot drift from it. */
export type TriggerNode = NodeFor<'trigger'>;
export type ConditionNode = NodeFor<'condition'>;
export type AiDecisionNode = NodeFor<'ai_decision'>;
export type AgentNode = NodeFor<'agent'>;
export type PolicyCheckNode = NodeFor<'policy_check'>;
export type HumanApprovalNode = NodeFor<'human_approval'>;
export type ActionNode = NodeFor<'action'>;
export type ArtifactNode = NodeFor<'artifact'>;
export type EndNode = NodeFor<'end'>;
