import { z } from 'zod';
import { conditionSchema } from '@wfm/contracts';

/**
 * The workflow DSL. Users compose these nodes and edges on the studio canvas;
 * the engine compiles the saved definition into an executable graph. Nothing in
 * this file knows about LangGraph, Redis, or the domain services — it is the
 * contract between the canvas, the validator, and the compiler.
 */

export const nodeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'node ids are lower_snake_case');

export const workflowNodeTypeSchema = z.enum([
  'trigger',
  'condition',
  'ai_decision',
  'policy_check',
  'human_approval',
  'action',
  'end',
]);

export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;

/** Ports carry the outcome of a node; edges label which port they leave from. */
export const edgePortSchema = z.enum(['always', 'true', 'false', 'passed', 'failed', 'approved', 'rejected']);

export type EdgePort = z.infer<typeof edgePortSchema>;

export const policyCheckKindSchema = z.enum([
  'cost_delta_cap',
  'rest_rule',
  'availability',
  'award_validity',
  'overtime_risk',
]);

export type PolicyCheckKind = z.infer<typeof policyCheckKindSchema>;

export const approvalDisplaySchema = z.enum(['rationale', 'evidence', 'payImpact', 'candidateComparison']);

export const aiOutputSchema = z.enum(['candidate_choice', 'timesheet_adjustment', 'coverage_plan']);

export const triggerNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('trigger'),
  label: z.string().min(1).max(80),
  config: z.object({
    eventType: z.string().min(1),
    conditions: z.array(conditionSchema).default([]),
  }),
});

export const conditionNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('condition'),
  label: z.string().min(1).max(80),
  config: z.object({
    description: z.string().max(200).default(''),
    conditions: z.array(conditionSchema).min(1),
  }),
});

export const aiDecisionNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('ai_decision'),
  label: z.string().min(1).max(80),
  config: z.object({
    goal: z.string().min(10).max(600),
    tools: z.array(z.string().min(1)).min(1),
    output: aiOutputSchema,
    mustCiteEvidence: z.boolean().default(true),
  }),
});

export const policyCheckNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('policy_check'),
  label: z.string().min(1).max(80),
  config: z.object({
    checks: z.array(policyCheckKindSchema).min(1),
    costCapCents: z.int().nonnegative().default(0),
    escalateOnFailure: z.boolean().default(true),
  }),
});

export const humanApprovalNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('human_approval'),
  label: z.string().min(1).max(80),
  config: z.object({
    role: z.string().min(1).max(60),
    timeoutMinutes: z.int().positive().max(10_080),
    escalateTo: z.string().min(1).max(60),
    show: z.array(approvalDisplaySchema).min(1),
  }),
});

/**
 * Input templates reference earlier node outputs or the trigger event:
 *   {{input.payload.shiftId}}          — the trigger event's payload
 *   {{nodes.rank.output.candidateIds}} — an upstream node's output
 *   {{now+4h}}                         — a computed timestamp
 * Templates are validated at save time so a typo cannot become a 3am page.
 */
export const actionNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('action'),
  label: z.string().min(1).max(80),
  config: z.object({
    command: z.string().min(1),
    input: z.record(z.string().min(1), z.string().min(1)),
  }),
});

export const endNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal('end'),
  label: z.string().min(1).max(80),
  config: z.object({ outcome: z.enum(['completed', 'stopped', 'needs_attention']).default('completed') }),
});

export const workflowNodeSchema = z.discriminatedUnion('type', [
  triggerNodeSchema,
  conditionNodeSchema,
  aiDecisionNodeSchema,
  policyCheckNodeSchema,
  humanApprovalNodeSchema,
  actionNodeSchema,
  endNodeSchema,
]);

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type TriggerNode = z.infer<typeof triggerNodeSchema>;
export type ConditionNode = z.infer<typeof conditionNodeSchema>;
export type AiDecisionNode = z.infer<typeof aiDecisionNodeSchema>;
export type PolicyCheckNode = z.infer<typeof policyCheckNodeSchema>;
export type HumanApprovalNode = z.infer<typeof humanApprovalNodeSchema>;
export type ActionNode = z.infer<typeof actionNodeSchema>;
export type EndNode = z.infer<typeof endNodeSchema>;

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

/** Which ports are legal on the outgoing edges of each node type. */
export const legalPortsByNodeType: Readonly<Record<WorkflowNodeType, readonly EdgePort[]>> = {
  trigger: ['always'],
  condition: ['true', 'false'],
  ai_decision: ['always'],
  policy_check: ['passed', 'failed'],
  human_approval: ['approved', 'rejected'],
  action: ['always'],
  end: [],
};

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;
