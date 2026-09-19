import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { ZodError, z } from 'zod';
import {
  adjustmentRequestSchema,
  apiError,
  clockOutRequestSchema,
  errorCodes,
  idempotencyKeySchema,
  isoDateTimeSchema,
  parseActorContext,
  timesheetApprovalRequestSchema,
  uuidSchema,
  ActorContextError,
  type ApiErrorBody,
} from '@wfm/contracts';
import { DomainError, type AttendanceService } from './domain/attendance.ts';
import { createServiceFromEnv } from './runtime.ts';

/**
 * Transport only. Every handler parses the actor and the body (the contracts'
 * zod schemas are the validation boundary), delegates to the domain service,
 * and maps domain errors to status codes. Logic lives in domain/attendance.ts.
 */

const clockInBodySchema = z.object({
  employeeId: uuidSchema,
  at: isoDateTimeSchema.optional(),
});

const noShowBodySchema = z.object({
  minutesLate: z.int().nonnegative().optional(),
  shiftStartsAt: isoDateTimeSchema.optional(),
});

let current: AttendanceService | null = null;

export function setAttendanceService(service: AttendanceService | null): void {
  current = service;
}

function serviceOf(): AttendanceService {
  current ??= createServiceFromEnv({ ...process.env });
  return current;
}

function requiredIdempotencyKey(headers: Record<string, string | undefined>): string {
  return idempotencyKeySchema.parse(headers['idempotency-key']);
}

function optionalIdempotencyKey(headers: Record<string, string | undefined>): string | null {
  const key = headers['idempotency-key'];
  return key ? idempotencyKeySchema.parse(key) : null;
}

function statusFilter(value: unknown): 'open' | 'resolved' | 'all' {
  if (value === 'resolved') return 'resolved';
  if (value === 'all') return 'all';
  return 'open';
}

export const app = new Elysia()
  .use(cors())
  .onError(({ error, set }) => {
    if (error instanceof ActorContextError) {
      set.status = 401;
      return apiError(errorCodes.invalidActorContext, error.message);
    }
    if (error instanceof ZodError) {
      set.status = 400;
      return apiError(errorCodes.validation, 'request validation failed', error.issues);
    }
    if (error instanceof DomainError) {
      set.status = error.status;
      return apiError(error.code, error.message);
    }
    set.status = 500;
    const body: ApiErrorBody = { error: { code: 'INTERNAL_ERROR', message: String(error) } };
    return body;
  })
  .get('/health', () => ({ status: 'ok', service: 'time-attendance-service' }))
  .get('/timesheets/:timesheetId', ({ headers, params }) =>
    serviceOf().getTimesheetDetail(parseActorContext(headers), uuidSchema.parse(params.timesheetId)),
  )
  .get('/timesheets/:timesheetId/exceptions', ({ headers, params, query }) =>
    serviceOf().listExceptions(
      parseActorContext(headers),
      uuidSchema.parse(params.timesheetId),
      statusFilter(query.status),
    ),
  )
  .get('/award-rules/:ruleCode', ({ headers, params }) =>
    serviceOf().getAwardRule(parseActorContext(headers), params.ruleCode),
  )
  .post('/timesheets/:timesheetId/adjustments', ({ headers, params, body }) =>
    serviceOf().applyAdjustment(
      parseActorContext(headers),
      uuidSchema.parse(params.timesheetId),
      requiredIdempotencyKey(headers),
      adjustmentRequestSchema.parse(body),
    ),
  )
  .post('/timesheets/:timesheetId/approval', ({ headers, params, body }) =>
    serviceOf().decideApproval(
      parseActorContext(headers),
      uuidSchema.parse(params.timesheetId),
      optionalIdempotencyKey(headers),
      timesheetApprovalRequestSchema.parse(body),
    ),
  )
  .post('/shifts/:shiftId/clock-in', ({ headers, params, body }) =>
    serviceOf().clockIn(
      parseActorContext(headers),
      uuidSchema.parse(params.shiftId),
      clockInBodySchema.parse(body),
    ),
  )
  .post('/shifts/:shiftId/clock-out', ({ headers, params, body }) =>
    serviceOf().clockOut(
      parseActorContext(headers),
      uuidSchema.parse(params.shiftId),
      clockOutRequestSchema.parse(body),
    ),
  )
  .post('/timesheets/:timesheetId/no-show', ({ headers, params, body }) =>
    serviceOf().recordNoShow(
      parseActorContext(headers),
      uuidSchema.parse(params.timesheetId),
      noShowBodySchema.parse(body),
    ),
  );

export type TimeAttendanceApi = typeof app;
