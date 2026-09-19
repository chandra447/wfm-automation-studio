import {
  ActorContextError,
  acceptanceRequestSchema,
  actorFromContext,
  apiError,
  assignShiftRequestSchema,
  cancellationRequestSchema,
  createOffersRequestSchema,
  errorCodes,
  idempotencyKeySchema,
  parseActorContext,
  shiftListQuerySchema,
} from '@wfm/contracts';
import { createLogger } from '@wfm/observability';
import { Elysia } from 'elysia';
import { z, ZodError } from 'zod';
import type { Sql } from 'postgres';
import { listCandidates } from './domain/candidates.ts';
import type { CommandContext } from './domain/context.ts';
import { ForbiddenError, IdempotencyMismatchError, NotFoundError, PreconditionError } from './domain/errors.ts';
import {
  acceptOffer,
  assignShift,
  cancelShift,
  getShift,
  listShiftOffers,
  listShifts,
  publishShift,
  requestSwap,
  sendOffers,
} from './domain/shifts.ts';

const logger = createLogger('rostering-service');

const swapRequestSchema = z.object({
  requestingEmployeeId: z.uuid(),
  targetEmployeeId: z.uuid().optional(),
  reason: z.string().min(1).max(500),
});

function requiredIdempotencyKey(headers: Record<string, string | undefined>): string {
  const header = headers['idempotency-key'];
  if (header === undefined) {
    throw new ZodError([{ code: 'custom', path: [], message: 'Idempotency-Key header is required' }]);
  }
  return idempotencyKeySchema.parse(header);
}

function optionalIdempotencyKey(headers: Record<string, string | undefined>): string | undefined {
  const header = headers['idempotency-key'];
  if (header === undefined) return undefined;
  return idempotencyKeySchema.parse(header);
}

function commandOf(headers: Record<string, string | undefined>): CommandContext {
  const actorContext = parseActorContext(headers);
  const correlationHeader = headers['x-correlation-id'];
  return {
    tenantId: actorContext.tenantId,
    actor: actorFromContext(actorContext),
    ...(correlationHeader === undefined ? {} : { correlationId: z.uuid().parse(correlationHeader) }),
    traceparent: headers['traceparent'] ?? null,
    now: new Date(),
  };
}

function logCommand(tenantId: string, shiftId: string, events: readonly { eventType: string }[], replayed: boolean): void {
  logger.info(
    {
      tenantId,
      shiftId,
      replayed,
      events: events.map((event) => event.eventType),
    },
    'command applied',
  );
}

export function createRosteringApp(sql: Sql) {
  return new Elysia({ name: 'rostering-service' })
    .onError(({ error, set }) => {
      if (error instanceof ActorContextError) {
        set.status = 401;
        return apiError(errorCodes.invalidActorContext, error.message);
      }
      if (error instanceof IdempotencyMismatchError) {
        set.status = 409;
        return apiError(errorCodes.idempotencyMismatch, error.message);
      }
      if (error instanceof PreconditionError) {
        set.status = 409;
        return apiError(errorCodes.preconditionFailed, error.message);
      }
      if (error instanceof ForbiddenError) {
        set.status = 403;
        return apiError(errorCodes.forbidden, error.message);
      }
      if (error instanceof NotFoundError) {
        set.status = 404;
        return apiError(errorCodes.notFound, error.message);
      }
      if (error instanceof ZodError) {
        set.status = 400;
        return apiError(errorCodes.validation, 'request validation failed', error.issues);
      }
      logger.error({ err: error }, 'unhandled error');
      set.status = 500;
      return { error: { code: 'INTERNAL_ERROR', message: 'internal error' } };
    })
    .get('/health', () => ({ status: 'ok', service: 'rostering-service' }))
    .get('/shifts', async ({ headers, query }) => ({
      shifts: await listShifts(sql, parseActorContext(headers).tenantId, shiftListQuerySchema.parse(query)),
    }))
    .get('/shifts/:shiftId', async ({ headers, params, set }) => {
      const shift = await getShift(sql, parseActorContext(headers).tenantId, params.shiftId);
      if (!shift) {
        set.status = 404;
        return apiError(errorCodes.notFound, 'shift not found');
      }
      return shift;
    })
    .get('/shifts/:shiftId/candidates', ({ headers, params, query }) => {
      const raw = query['excludeEmployeeIds'];
      const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      const excludeEmployeeIds = z.array(z.uuid()).min(0).parse(values);
      return listCandidates(sql, parseActorContext(headers).tenantId, params.shiftId, excludeEmployeeIds);
    })
    .get('/shifts/:shiftId/offers', ({ headers, params }) =>
      listShiftOffers(sql, parseActorContext(headers).tenantId, params.shiftId),
    )
    .post(
      '/shifts/:shiftId/offers',
      async ({ headers, params, body, set }) => {
        const ctx = commandOf(headers);
        const result = await sendOffers(
          sql,
          ctx,
          params.shiftId,
          createOffersRequestSchema.parse(body),
          requiredIdempotencyKey(headers),
        );
        logCommand(ctx.tenantId, params.shiftId, result.events, result.replayed);
        set.status = result.status;
        return result.body;
      },
    )
    .post(
      '/shifts/:shiftId/assignment',
      async ({ headers, params, body, set }) => {
        const ctx = commandOf(headers);
        const result = await assignShift(
          sql,
          ctx,
          params.shiftId,
          assignShiftRequestSchema.parse(body),
          requiredIdempotencyKey(headers),
        );
        logCommand(ctx.tenantId, params.shiftId, result.events, result.replayed);
        set.status = result.status;
        return result.body;
      },
    )
    .post(
      '/shifts/:shiftId/cancellation',
      async ({ headers, params, body, set }) => {
        const ctx = commandOf(headers);
        const result = await cancelShift(
          sql,
          ctx,
          params.shiftId,
          cancellationRequestSchema.parse(body),
          optionalIdempotencyKey(headers),
        );
        logCommand(ctx.tenantId, params.shiftId, result.events, result.replayed);
        set.status = result.status;
        return result.body;
      },
    )
    .post(
      '/shifts/:shiftId/acceptance',
      async ({ headers, params, body, set }) => {
        const ctx = commandOf(headers);
        const result = await acceptOffer(
          sql,
          ctx,
          params.shiftId,
          acceptanceRequestSchema.parse(body),
          optionalIdempotencyKey(headers),
        );
        logCommand(ctx.tenantId, params.shiftId, result.events, result.replayed);
        set.status = result.status;
        return result.body;
      },
    )
    .post(
      '/shifts/:shiftId/publication',
      async ({ headers, params, set }) => {
        const ctx = commandOf(headers);
        const result = await publishShift(sql, ctx, params.shiftId, optionalIdempotencyKey(headers));
        logCommand(ctx.tenantId, params.shiftId, result.events, result.replayed);
        set.status = result.status;
        return result.body;
      },
    )
    .post(
      '/shifts/:shiftId/swap-request',
      async ({ headers, params, body, set }) => {
        const ctx = commandOf(headers);
        const result = await requestSwap(
          sql,
          ctx,
          params.shiftId,
          swapRequestSchema.parse(body),
          optionalIdempotencyKey(headers),
        );
        logCommand(ctx.tenantId, params.shiftId, result.events, result.replayed);
        set.status = result.status;
        return result.body;
      },
    );
}
