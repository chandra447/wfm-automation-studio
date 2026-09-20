import { z } from 'zod';
import { isoDateTimeSchema, tokenUsageSchema, uuidSchema } from '@wfm/contracts';
import { workflowDefinitionSchema } from '../dsl.ts';

/**
 * The wire shape of the builder conversation. It lives beside the DSL rather
 * than in @wfm/contracts because every request carries a full definition and a
 * layout, and the contracts package deliberately does not depend on the DSL.
 *
 * The canvas sends its own current graph with every turn. That is the whole
 * point of the request shape: the agent reasons about what is on the screen
 * right now, including nodes the user dragged, not about what it last saw.
 */

export const canvasLayoutSchema = z.object({
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
});

export const diagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  nodeId: z.string().optional(),
});

export const builderRejectionSchema = z.object({
  op: z.string(),
  target: z.string(),
  reason: z.string(),
});

export const builderChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  /** The graph as it stands on the canvas, positions included. */
  definition: workflowDefinitionSchema,
  layout: canvasLayoutSchema,
  /** Which trigger event's fields the agent should offer to bind. */
  eventType: z.string().min(1).optional(),
  /** Overrides the tenant's configured model for this turn only. */
  model: z.string().min(1).optional(),
});

export const builderChatMessageSchema = z.object({
  messageId: uuidSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: isoDateTimeSchema,
  model: z.string().nullable(),
  applied: z.array(z.string()),
  rejected: z.array(builderRejectionSchema),
});

export const builderChatHistorySchema = z.object({ messages: z.array(builderChatMessageSchema) });

export const builderChatResponseSchema = z.object({
  reply: z.string(),
  definition: workflowDefinitionSchema,
  layout: canvasLayoutSchema,
  applied: z.array(z.string()),
  rejected: z.array(builderRejectionSchema),
  diagnostics: z.array(diagnosticSchema),
  model: z.string().nullable(),
  tokens: tokenUsageSchema,
});

export type CanvasLayoutPayload = z.infer<typeof canvasLayoutSchema>;
export type BuilderChatRequest = z.infer<typeof builderChatRequestSchema>;
export type BuilderChatResponse = z.infer<typeof builderChatResponseSchema>;
export type BuilderChatMessage = z.infer<typeof builderChatMessageSchema>;
export type BuilderChatHistory = z.infer<typeof builderChatHistorySchema>;
export type BuilderRejection = z.infer<typeof builderRejectionSchema>;
