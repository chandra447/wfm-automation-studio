import type { Actor, EventContext } from '@wfm/contracts';

/** Actor, tenant, and tracing context carried into every command and its events. */
export interface CommandContext {
  tenantId: string;
  actor: Actor;
  correlationId?: string;
  traceparent: string | null;
  now: Date;
}

export function eventContextOf(ctx: CommandContext): EventContext {
  return {
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
    traceparent: ctx.traceparent,
    occurredAt: ctx.now.toISOString(),
  };
}
