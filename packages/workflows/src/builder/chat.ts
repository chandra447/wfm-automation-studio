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

export const builderFocusSchema = z.object({
  /** Nodes the agent asked the canvas to point at. */
  nodeIds: z.array(z.string()),
  /** Edges, as `from::port::to`, the agent asked the canvas to point at. */
  edgeIds: z.array(z.string()),
});

export const builderChatResponseSchema = z.object({
  reply: z.string(),
  definition: workflowDefinitionSchema,
  layout: canvasLayoutSchema,
  applied: z.array(z.string()),
  rejected: z.array(builderRejectionSchema),
  diagnostics: z.array(diagnosticSchema),
  /** What the agent asked the canvas to highlight, from its selection tools. */
  focus: builderFocusSchema,
  /** The tools the agent called this turn, in order, for the transcript. */
  steps: z.array(z.string()),
  model: z.string().nullable(),
  tokens: tokenUsageSchema,
});

/**
 * A tool call as the transcript shows it while the turn is still running. The
 * fields say what the call has at this moment rather than narrating a
 * lifecycle: `input` is null until the model has finished writing the
 * arguments, and `output` is null until the tool answers.
 */
export const builderToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(['running', 'done', 'failed']),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
});

/**
 * What the builder chat sends while a turn is in flight. The turn ends with
 * `done`, carrying exactly the response the blocking route returns, so a client
 * that only wants the result can ignore everything before it.
 *
 * `token` names the model run that produced it. A turn makes several model
 * calls — a preamble beside the tool calls, and the summary the harness writes
 * when the conversation is long — and only the last one is the answer, which is
 * why the run travels with the text instead of the client guessing.
 */
export const builderStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), run: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool'), call: builderToolCallSchema }),
  z.object({ type: z.literal('focus'), focus: builderFocusSchema }),
  z.object({ type: z.literal('done'), response: builderChatResponseSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type BuilderToolCall = z.infer<typeof builderToolCallSchema>;
export type BuilderStreamEvent = z.infer<typeof builderStreamEventSchema>;
export type CanvasLayoutPayload = z.infer<typeof canvasLayoutSchema>;
export type BuilderFocus = z.infer<typeof builderFocusSchema>;
export type BuilderChatRequest = z.infer<typeof builderChatRequestSchema>;
export type BuilderChatResponse = z.infer<typeof builderChatResponseSchema>;
export type BuilderChatMessage = z.infer<typeof builderChatMessageSchema>;
export type BuilderChatHistory = z.infer<typeof builderChatHistorySchema>;
export type BuilderRejection = z.infer<typeof builderRejectionSchema>;
