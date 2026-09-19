import { z } from 'zod';

/** All identifiers are UUIDs; branded wrappers keep call sites honest. */
export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const TenantId = z.uuid();
export const EmployeeId = z.uuid();
export const ShiftId = z.uuid();
export const TimesheetId = z.uuid();

export const actorSchema = z.object({
  type: z.enum(['employee', 'manager', 'system', 'integration']),
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

export type Actor = z.infer<typeof actorSchema>;

/** Actor context extracted from request headers (ADR-0008). */
export const actorContextSchema = z.object({
  tenantId: TenantId,
  userId: z.string().min(1),
  roles: z.array(z.string().min(1)),
  employeeId: EmployeeId.optional(),
});

export type ActorContext = z.infer<typeof actorContextSchema>;

export class ActorContextError extends Error {
  override readonly name = 'ActorContextError';
}

/**
 * Parses the demo actor headers. Production replaces this with OIDC token
 * validation; the downstream policy checks do not change.
 */
export function parseActorContext(headers: Record<string, string | undefined>): ActorContext {
  const tenantId = headers['x-tenant-id'];
  const userId = headers['x-user-id'];
  const roles = (headers['x-user-roles'] ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  const employeeId = headers['x-employee-id'];

  const parsed = actorContextSchema.safeParse({
    tenantId,
    userId,
    roles,
    ...(employeeId ? { employeeId } : {}),
  });
  if (!parsed.success) {
    throw new ActorContextError(
      `Missing or invalid actor context: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

export function actorFromContext(context: ActorContext, type: Actor['type'] = 'manager'): Actor {
  return {
    type,
    id: context.employeeId ?? context.userId,
  };
}

/** Money is integer cents everywhere. Never floats. */
export const centsSchema = z.int();

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Idempotency keys are required on every state-changing command (ADR-0007). */
export const idempotencyKeySchema = z.string().min(8).max(200);
