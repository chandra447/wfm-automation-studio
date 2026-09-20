import type { EventBus } from '@wfm/eventbus';
import {
  makeEvent,
  type Actor,
  type AnyWfmEvent,
  type ApprovalRequested,
  type ApprovalDecided,
  type ActionExecuted,
  type RunCompleted,
  type RunStarted,
} from '@wfm/contracts';

export const ENGINE_ACTOR: Actor = { type: 'system', id: 'studio-engine' };

function context(tenantId: string, correlationId: string, causationId: string | null) {
  return {
    tenantId,
    actor: ENGINE_ACTOR,
    correlationId,
    ...(causationId ? { causationId } : {}),
  };
}

export async function publishRunStarted(
  bus: EventBus,
  input: { tenantId: string; correlationId: string; causationId: string | null } & RunStarted,
): Promise<AnyWfmEvent> {
  const { tenantId, correlationId, causationId, ...payload } = input;
  const event = makeEvent('workflow.run_started', payload, context(tenantId, correlationId, causationId));
  await bus.publish(tenantId, event);
  return event;
}

export async function publishApprovalRequested(
  bus: EventBus,
  input: { tenantId: string; correlationId: string; causationId: string | null } & ApprovalRequested,
): Promise<AnyWfmEvent> {
  const { tenantId, correlationId, causationId, ...payload } = input;
  const event = makeEvent('workflow.approval_requested', payload, context(tenantId, correlationId, causationId));
  await bus.publish(tenantId, event);
  return event;
}

export async function publishApprovalDecided(
  bus: EventBus,
  input: { tenantId: string; correlationId: string; causationId: string | null } & ApprovalDecided,
): Promise<AnyWfmEvent> {
  const { tenantId, correlationId, causationId, ...payload } = input;
  const event = makeEvent('workflow.approval_decided', payload, context(tenantId, correlationId, causationId));
  await bus.publish(tenantId, event);
  return event;
}

export async function publishActionExecuted(
  bus: EventBus,
  input: { tenantId: string; correlationId: string; causationId: string | null } & ActionExecuted,
): Promise<AnyWfmEvent> {
  const { tenantId, correlationId, causationId, ...payload } = input;
  const event = makeEvent('workflow.action_executed', payload, context(tenantId, correlationId, causationId));
  await bus.publish(tenantId, event);
  return event;
}

export async function publishRunCompleted(
  bus: EventBus,
  input: { tenantId: string; correlationId: string; causationId: string | null } & RunCompleted,
): Promise<AnyWfmEvent> {
  const { tenantId, correlationId, causationId, ...payload } = input;
  const event = makeEvent('workflow.run_completed', payload, context(tenantId, correlationId, causationId));
  await bus.publish(tenantId, event);
  return event;
}
