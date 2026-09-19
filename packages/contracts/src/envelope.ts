import { z } from 'zod';
import { actorSchema, isoDateTimeSchema, uuidSchema } from './primitives.ts';

/**
 * Event envelope. Mirrors the shape Humanforce HR already emits as skinny
 * webhooks ({id, event, timestamp, links}) and adds what a multi-tenant
 * workflow platform needs: schema version, tenant partition key, correlation
 * and causation ids, and W3C trace context.
 */
export const envelopeBaseSchema = z.object({
  eventId: uuidSchema,
  eventType: z.string().min(1),
  eventVersion: z.int().positive(),
  occurredAt: isoDateTimeSchema,
  tenantId: uuidSchema,
  aggregate: z.object({
    type: z.string().min(1),
    id: uuidSchema,
  }),
  actor: actorSchema.nullable(),
  correlationId: uuidSchema,
  causationId: uuidSchema.nullable(),
  traceparent: z.string().min(1).nullable(),
  payload: z.unknown(),
});

export type EnvelopeBase = z.infer<typeof envelopeBaseSchema>;

export class EventValidationError extends Error {
  override readonly name = 'EventValidationError';
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

export interface EventContext {
  tenantId: string;
  actor?: EnvelopeBase['actor'];
  correlationId?: string;
  causationId?: string | null;
  traceparent?: string | null;
  occurredAt?: string;
  eventId?: string;
}


