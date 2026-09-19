import { z } from 'zod';
import { centsSchema, isoDateTimeSchema, uuidSchema } from '../primitives.ts';

/**
 * Events the Automation Studio itself publishes back onto the backbone.
 * Other services (and the customer's other systems) can subscribe to these to
 * react to automation outcomes without knowing anything about the engine.
 */

export const runStartedSchema = z.object({
  runId: uuidSchema,
  workflowId: uuidSchema,
  triggerEventId: uuidSchema,
  triggerEventType: z.string().min(1),
});

export const approvalRequestedSchema = z.object({
  runId: uuidSchema,
  approvalId: uuidSchema,
  workflowId: uuidSchema,
  requestedFromRole: z.string().min(1),
  expiresAt: isoDateTimeSchema,
  subject: z.string().min(1),
  payImpactCents: centsSchema,
});

export const approvalDecidedSchema = z.object({
  runId: uuidSchema,
  approvalId: uuidSchema,
  decision: z.enum(['approved', 'rejected', 'timed_out']),
  decidedBy: z.string().min(1),
  reason: z.string().min(1),
});

export const actionExecutedSchema = z.object({
  runId: uuidSchema,
  workflowId: uuidSchema,
  action: z.string().min(1),
  targetService: z.enum(['rostering', 'time-attendance']),
  command: z.string().min(1),
  idempotencyKey: z.string().min(1),
  resultSummary: z.string().min(1),
  payImpactCents: centsSchema,
});

export const runCompletedSchema = z.object({
  runId: uuidSchema,
  workflowId: uuidSchema,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  actionsExecuted: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

export type RunStarted = z.infer<typeof runStartedSchema>;
export type ApprovalRequested = z.infer<typeof approvalRequestedSchema>;
export type ApprovalDecided = z.infer<typeof approvalDecidedSchema>;
export type ActionExecuted = z.infer<typeof actionExecutedSchema>;
export type RunCompleted = z.infer<typeof runCompletedSchema>;
