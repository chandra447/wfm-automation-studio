import {
  makeEvent,
  type Actor,
  type OffersResponse,
  type Shift,
  type ShiftListQuery,
} from '@wfm/contracts';
import type { Sql } from 'postgres';
import type { OfferRow, ShiftRow, Tx } from '../db/rows.ts';
import { eventContextOf, type CommandContext } from './context.ts';
import { ForbiddenError, NotFoundError, PreconditionError } from './errors.ts';
import { runKeyed, type CommandResult } from './idempotency.ts';

export type { CommandContext } from './context.ts';

export interface SwapRequestBody {
  requestingEmployeeId: string;
  targetEmployeeId?: string | undefined;
  reason: string;
}

export interface SwapRequestResponse {
  swapRequestId: string;
  shiftId: string;
  requestingEmployeeId: string;
  targetEmployeeId: string | null;
  reason: string;
}

export interface OffersDetail {
  shiftId: string;
  offers: Array<{ offerId: string; employeeId: string; status: OfferRow['status']; expiresAt: string }>;
}

function shiftDto(row: ShiftRow): Shift {
  return {
    shiftId: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    locationName: row.locationName,
    roleName: row.roleName,
    requiredQualificationCodes: row.requiredQualificationCodes,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    hourlyRateCents: row.hourlyRateCents,
    status: row.status,
    assignedEmployeeId: row.assignedEmployeeId,
  };
}

async function loadShift(tx: Sql | Tx, tenantId: string, shiftId: string): Promise<ShiftRow> {
  const rows = await tx<ShiftRow[]>`
    SELECT s.id, s.tenant_id AS "tenantId", s.location_id AS "locationId", l.name AS "locationName",
           l.timezone AS "timeZone", s.role_name AS "roleName",
           s.required_qualification_codes AS "requiredQualificationCodes",
           s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.hourly_rate_cents AS "hourlyRateCents",
           s.status, s.assigned_employee_id AS "assignedEmployeeId", s.baseline_cost_cents AS "baselineCostCents"
    FROM shifts s
    JOIN locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
    WHERE s.id = ${shiftId} AND s.tenant_id = ${tenantId}
  `;
  const shift = rows[0];
  if (!shift) throw new NotFoundError('shift not found');
  return shift;
}

export async function getShift(sql: Sql, tenantId: string, shiftId: string): Promise<Shift | null> {
  const rows = await sql<ShiftRow[]>`
    SELECT s.id, s.tenant_id AS "tenantId", s.location_id AS "locationId", l.name AS "locationName",
           l.timezone AS "timeZone", s.role_name AS "roleName",
           s.required_qualification_codes AS "requiredQualificationCodes",
           s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.hourly_rate_cents AS "hourlyRateCents",
           s.status, s.assigned_employee_id AS "assignedEmployeeId", s.baseline_cost_cents AS "baselineCostCents"
    FROM shifts s
    JOIN locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
    WHERE s.id = ${shiftId} AND s.tenant_id = ${tenantId}
  `;
  return rows[0] ? shiftDto(rows[0]) : null;
}

export async function listShifts(sql: Sql, tenantId: string, query: ShiftListQuery): Promise<Shift[]> {
  const conditions = [sql`s.tenant_id = ${tenantId}`];
  if (query.locationId !== undefined) conditions.push(sql`s.location_id = ${query.locationId}`);
  if (query.from !== undefined) conditions.push(sql`s.starts_at >= ${query.from}`);
  if (query.to !== undefined) conditions.push(sql`s.starts_at <= ${query.to}`);
  if (query.status !== undefined) conditions.push(sql`s.status = ${query.status}`);

  const where = conditions.reduce((left, right) => sql`${left} AND ${right}`);

  const rows = await sql<ShiftRow[]>`
    SELECT s.id, s.tenant_id AS "tenantId", s.location_id AS "locationId", l.name AS "locationName",
           l.timezone AS "timeZone", s.role_name AS "roleName",
           s.required_qualification_codes AS "requiredQualificationCodes",
           s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.hourly_rate_cents AS "hourlyRateCents",
           s.status, s.assigned_employee_id AS "assignedEmployeeId", s.baseline_cost_cents AS "baselineCostCents"
    FROM shifts s
    JOIN locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
    WHERE ${where}
    ORDER BY s.starts_at
  `;
  return rows.map(shiftDto);
}

export async function listShiftOffers(sql: Sql, tenantId: string, shiftId: string): Promise<OffersDetail> {
  await loadShift(sql, tenantId, shiftId);
  const rows = await sql<OfferRow[]>`
    SELECT id, tenant_id AS "tenantId", shift_id AS "shiftId", employee_id AS "employeeId",
           status, expires_at AS "expiresAt"
    FROM shift_offers
    WHERE shift_id = ${shiftId} AND tenant_id = ${tenantId}
    ORDER BY created_at
  `;
  return {
    shiftId,
    offers: rows.map((row) => ({
      offerId: row.id,
      employeeId: row.employeeId,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
    })),
  };
}

async function assertEmployeesExist(tx: Tx, tenantId: string, employeeIds: string[]): Promise<void> {
  const known = await tx<Array<{ id: string }>>`
    SELECT id FROM employees WHERE tenant_id = ${tenantId} AND id = ANY(${employeeIds})
  `;
  if (known.length !== employeeIds.length) {
    const missing = employeeIds.filter((id) => !known.some((row) => row.id === id));
    throw new NotFoundError(`unknown employees: ${missing.join(', ')}`);
  }
}

export async function sendOffers(
  sql: Sql,
  ctx: CommandContext,
  shiftId: string,
  body: { employeeIds: string[]; expiresAt: string; reason: string },
  idempotencyKey: string,
): Promise<CommandResult> {
  return runKeyed(sql, ctx.tenantId, idempotencyKey, body, async (tx) => {
    const shift = await loadShift(tx, ctx.tenantId, shiftId);
    if (shift.status === 'cancelled' || shift.status === 'assigned') {
      throw new PreconditionError(`cannot offer a ${shift.status} shift`);
    }

    const employeeIds = [...new Set(body.employeeIds)];
    await assertEmployeesExist(tx, ctx.tenantId, employeeIds);

    await tx`
      INSERT INTO shift_offers (id, tenant_id, shift_id, employee_id, status, expires_at)
      SELECT gen_random_uuid(), ${ctx.tenantId}, ${shiftId}, x.employee_id, 'sent', ${body.expiresAt}
      FROM unnest(${employeeIds}::uuid[]) AS x(employee_id)
      ON CONFLICT (shift_id, employee_id) DO NOTHING
    `;

    await tx`UPDATE shifts SET status = 'offered' WHERE id = ${shiftId} AND status IN ('draft', 'published')`;

    const outstanding = await tx<OfferRow[]>`
      SELECT id, tenant_id AS "tenantId", shift_id AS "shiftId", employee_id AS "employeeId",
             status, expires_at AS "expiresAt"
      FROM shift_offers
      WHERE shift_id = ${shiftId} AND tenant_id = ${ctx.tenantId} AND status = 'sent'
      ORDER BY created_at
    `;

    const event = makeEvent(
      'shift.offers_sent',
      {
        shiftId,
        offerIds: outstanding.map((row) => row.id),
        employeeIds: outstanding.map((row) => row.employeeId),
        expiresAt: body.expiresAt,
        reason: body.reason,
      },
      eventContextOf(ctx),
    );

    const response: OffersResponse = {
      shiftId,
      offers: outstanding.map((row) => ({ offerId: row.id, employeeId: row.employeeId, status: row.status })),
    };
    return { status: 200, body: response, events: [event] };
  });
}

export async function assignShift(
  sql: Sql,
  ctx: CommandContext,
  shiftId: string,
  body: { employeeId: string; reason: string },
  idempotencyKey: string,
): Promise<CommandResult> {
  return runKeyed(sql, ctx.tenantId, idempotencyKey, body, async (tx) => {
    const shift = await loadShift(tx, ctx.tenantId, shiftId);
    if (shift.status === 'cancelled') throw new PreconditionError('cannot assign a cancelled shift');
    if (shift.assignedEmployeeId !== null) throw new PreconditionError('shift already assigned');

    await assertEmployeesExist(tx, ctx.tenantId, [body.employeeId]);

    await tx`
      UPDATE shifts SET status = 'assigned', assigned_employee_id = ${body.employeeId} WHERE id = ${shiftId}
    `;

    const event = makeEvent(
      'shift.assigned',
      { shiftId, employeeId: body.employeeId, assignedBy: 'manager' },
      eventContextOf(ctx),
    );

    const assigned: ShiftRow = { ...shift, status: 'assigned', assignedEmployeeId: body.employeeId };
    return { status: 200, body: shiftDto(assigned), events: [event] };
  });
}

export async function cancelShift(
  sql: Sql,
  ctx: CommandContext,
  shiftId: string,
  body: { reason: string; cancelledByEmployeeId?: string | undefined },
  idempotencyKey: string | undefined,
): Promise<CommandResult> {
  return runKeyed(sql, ctx.tenantId, idempotencyKey, body, async (tx) => {
    const shift = await loadShift(tx, ctx.tenantId, shiftId);
    if (shift.status === 'cancelled') throw new PreconditionError('shift already cancelled');

    const hoursUntilStart = Math.max(
      0,
      Math.round(((shift.startsAt.getTime() - ctx.now.getTime()) / 3_600_000) * 100) / 100,
    );

    // An employee calling in sick vacates the shift: it returns to the open
    // pool so the coverage workflow can fill it. Cancelling the shift itself
    // (nobody named) is terminal.
    const vacatedByEmployee = body.cancelledByEmployeeId !== undefined;
    const nextStatus = vacatedByEmployee ? 'published' : 'cancelled';

    await tx`
      UPDATE shifts SET status = ${nextStatus}, assigned_employee_id = NULL WHERE id = ${shiftId}
    `;

    const event = makeEvent(
      'shift.cancelled',
      {
        shiftId,
        locationId: shift.locationId,
        startsAt: shift.startsAt.toISOString(),
        hoursUntilStart,
        reason: body.reason,
        cancelledByEmployeeId: body.cancelledByEmployeeId ?? null,
        requiredQualificationCodes: shift.requiredQualificationCodes,
        roleName: shift.roleName,
      },
      eventContextOf(ctx),
    );

    const cancelled: ShiftRow = { ...shift, status: nextStatus, assignedEmployeeId: null };
    return { status: 200, body: shiftDto(cancelled), events: [event] };
  });
}

export async function acceptOffer(
  sql: Sql,
  ctx: CommandContext,
  shiftId: string,
  body: { employeeId: string; offerId: string },
  idempotencyKey: string | undefined,
): Promise<CommandResult> {
  const employeeActor: Actor = { type: 'employee', id: body.employeeId };
  return runKeyed(sql, ctx.tenantId, idempotencyKey, body, async (tx) => {
    const shift = await loadShift(tx, ctx.tenantId, shiftId);
    if (shift.status === 'cancelled') throw new PreconditionError('cannot accept an offer for a cancelled shift');

    const offers = await tx<OfferRow[]>`
      SELECT id, tenant_id AS "tenantId", shift_id AS "shiftId", employee_id AS "employeeId",
             status, expires_at AS "expiresAt"
      FROM shift_offers
      WHERE id = ${body.offerId} AND shift_id = ${shiftId} AND tenant_id = ${ctx.tenantId}
    `;
    const offer = offers[0];
    if (!offer) throw new NotFoundError('offer not found');
    if (offer.employeeId !== body.employeeId) throw new ForbiddenError('offer belongs to another employee');
    if (offer.status !== 'sent') throw new PreconditionError(`offer already ${offer.status}`);
    if (offer.expiresAt.getTime() <= ctx.now.getTime()) throw new PreconditionError('offer has expired');

    await tx`UPDATE shift_offers SET status = 'accepted' WHERE id = ${offer.id}`;
    await tx`
      UPDATE shifts SET status = 'assigned', assigned_employee_id = ${body.employeeId} WHERE id = ${shiftId}
    `;

    const event = makeEvent(
      'shift.assigned',
      { shiftId, employeeId: body.employeeId, assignedBy: 'employee_acceptance' },
      eventContextOf({ ...ctx, actor: employeeActor }),
    );

    const assigned: ShiftRow = { ...shift, status: 'assigned', assignedEmployeeId: body.employeeId };
    return { status: 200, body: shiftDto(assigned), events: [event] };
  });
}

export async function publishShift(
  sql: Sql,
  ctx: CommandContext,
  shiftId: string,
  idempotencyKey: string | undefined,
): Promise<CommandResult> {
  const body = { shiftId };
  return runKeyed(sql, ctx.tenantId, idempotencyKey, body, async (tx) => {
    const shift = await loadShift(tx, ctx.tenantId, shiftId);
    if (shift.status === 'cancelled') throw new PreconditionError('cannot publish a cancelled shift');
    if (shift.status !== 'draft') {
      return { status: 200, body: shiftDto(shift), events: [] };
    }

    await tx`UPDATE shifts SET status = 'published' WHERE id = ${shiftId}`;

    const event = makeEvent(
      'shift.published',
      {
        shiftId,
        locationId: shift.locationId,
        roleName: shift.roleName,
        requiredQualificationCodes: shift.requiredQualificationCodes,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        hourlyRateCents: shift.hourlyRateCents,
      },
      eventContextOf(ctx),
    );

    const published: ShiftRow = { ...shift, status: 'published' };
    return { status: 200, body: shiftDto(published), events: [event] };
  });
}

export async function requestSwap(
  sql: Sql,
  ctx: CommandContext,
  shiftId: string,
  body: SwapRequestBody,
  idempotencyKey: string | undefined,
): Promise<CommandResult> {
  const employeeActor: Actor = { type: 'employee', id: body.requestingEmployeeId };
  return runKeyed(sql, ctx.tenantId, idempotencyKey, body, async (tx) => {
    const shift = await loadShift(tx, ctx.tenantId, shiftId);
    if (shift.status !== 'assigned' || shift.assignedEmployeeId !== body.requestingEmployeeId) {
      throw new PreconditionError('only the assigned employee can request a swap');
    }
    if (body.targetEmployeeId !== undefined) {
      await assertEmployeesExist(tx, ctx.tenantId, [body.targetEmployeeId]);
    }

    const swapRequestId = crypto.randomUUID();
    await tx`
      INSERT INTO swap_requests (id, tenant_id, shift_id, requesting_employee_id, target_employee_id, reason)
      VALUES (${swapRequestId}, ${ctx.tenantId}, ${shiftId}, ${body.requestingEmployeeId}, ${body.targetEmployeeId ?? null}, ${body.reason})
    `;

    const event = makeEvent(
      'shift.swap_requested',
      {
        swapRequestId,
        shiftId,
        requestingEmployeeId: body.requestingEmployeeId,
        targetEmployeeId: body.targetEmployeeId ?? null,
        reason: body.reason,
      },
      eventContextOf({ ...ctx, actor: employeeActor }),
    );

    const response: SwapRequestResponse = {
      swapRequestId,
      shiftId,
      requestingEmployeeId: body.requestingEmployeeId,
      targetEmployeeId: body.targetEmployeeId ?? null,
      reason: body.reason,
    };
    return { status: 200, body: response, events: [event] };
  });
}
