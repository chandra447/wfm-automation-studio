import { z } from 'zod';

/** Shared HTTP conventions. */

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const errorCodes = {
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  validation: 'VALIDATION_FAILED',
  invalidActorContext: 'INVALID_ACTOR_CONTEXT',
  idempotencyMismatch: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  preconditionFailed: 'PRECONDITION_FAILED',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export function apiError(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
