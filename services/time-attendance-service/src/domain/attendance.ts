import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActorContext,
  AdjustmentRequest,
  AdjustmentResponse,
  AnyWfmEvent,
  AwardRule,
  BreakRecord,
  PayLine,
  Timesheet,
  TimesheetApprovalRequest,
  TimesheetDetailResponse,
  TimesheetException,
} from '@wfm/contracts';
import {
  adjustmentResponseSchema,
  actorFromContext,
  errorCodes,
  makeEvent,
  timesheetSchema,
} from '@wfm/contracts';
import { enqueueEvents } from '@wfm/outbox';
import type { Database, Tx, ScopedTx } from '../db/client.ts';
import {
  adjustments as adjustmentsTable,
  awardRules,
  breaks as breaksTable,
  employees as employeesTable,
  exceptions as exceptionsTable,
  idempotencyKeys,
  payLines as payLinesTable,
  timesheets as timesheetsTable,
} from '../db/schema.ts';
import { computeAwardTotals, roundCentsHalfUp } from './award.ts';

export class DomainError extends Error {
  constructor(
    readonly code: (typeof errorCodes)[keyof typeof errorCodes],
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}


type TimesheetRow = typeof timesheetsTable.$inferSelect;
type EmployeeRow = typeof employeesTable.$inferSelect;
type AwardRuleRow = typeof awardRules.$inferSelect;
type BreakRow = typeof breaksTable.$inferSelect;
type PayLineRow = typeof payLinesTable.$inferSelect;
type ExceptionRow = typeof exceptionsTable.$inferSelect;

/**
 * drizzle holds the transaction's SQL client private, but the outbox must
 * enqueue into that same client; the runtime shape is stable in the pinned
 * drizzle version, so the guarded read is pinned here once.
 */
function rawClientOf(session: unknown): Tx {
  if (typeof session !== 'object' || session === null || !('client' in session)) {
    throw new Error('drizzle transaction session has no underlying SQL client');
  }
  return session.client as Tx;
}

export interface ClockResponse {
  timesheet: Timesheet;
  emittedEvents: string[];
}

export interface NoShowResponse {
  emittedEvents: string[];
}

export interface ApprovalResponse {
  timesheet: Timesheet;
}

export type ExceptionStatusFilter = 'open' | 'resolved' | 'all';

export interface AttendanceService {
  getTimesheetDetail: (context: ActorContext, timesheetId: string) => Promise<TimesheetDetailResponse>;
  listExceptions: (
    context: ActorContext,
    timesheetId: string,
    status: ExceptionStatusFilter,
  ) => Promise<TimesheetException[]>;
  getAwardRule: (context: ActorContext, ruleCode: string) => Promise<AwardRule>;
  clockIn: (
    context: ActorContext,
    shiftId: string,
    request: { employeeId: string; at?: string | undefined },
  ) => Promise<ClockResponse>;
  clockOut: (
    context: ActorContext,
    shiftId: string,
    request: { employeeId: string; shiftId: string | null; at: string; breakMinutesTaken: number },
  ) => Promise<ClockResponse>;
  applyAdjustment: (
    context: ActorContext,
    timesheetId: string,
    idempotencyKey: string,
    request: AdjustmentRequest,
  ) => Promise<AdjustmentResponse>;
  decideApproval: (
    context: ActorContext,
    timesheetId: string,
    idempotencyKey: string | null,
    request: TimesheetApprovalRequest,
  ) => Promise<ApprovalResponse>;
  recordNoShow: (
    context: ActorContext,
    timesheetId: string,
    request: { minutesLate?: number | undefined; shiftStartsAt?: string | undefined },
  ) => Promise<NoShowResponse>;
  close: () => Promise<void>;
}

interface ServiceDeps {
  database: Database;
}

function notFound(what: string): DomainError {
  return new DomainError(errorCodes.notFound, 404, `${what} not found`);
}

function toTimesheetDto(
  row: TimesheetRow,
  breaks: BreakRecord[],
  payLines: PayLine[],
  exceptions: TimesheetException[],
): Timesheet {
  return {
    timesheetId: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    shiftId: row.shiftId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd ? row.periodEnd.toISOString() : row.periodStart.toISOString(),
    status: row.status,
    workedMinutes: row.workedMinutes,
    ordinaryMinutes: row.ordinaryMinutes,
    overtimeMinutes: row.overtimeMinutes,
    paidMinutes: row.paidMinutes,
    totalPayCents: row.totalPayCents,
    breaks,
    payLines,
    exceptions,
  };
}

function toAwardRuleDto(row: AwardRuleRow): AwardRule {
  return {
    ruleCode: row.ruleCode,
    name: row.name,
    maxOrdinaryMinutesPerDay: row.maxOrdinaryMinutesPerDay,
    overtimeMultiplier: Number(row.overtimeMultiplier),
    breakRequiredAfterMinutes: row.breakRequiredAfterMinutes,
    unpaidBreakMinutes: row.unpaidBreakMinutes,
    minimumRestHoursBetweenShifts: Number(row.minimumRestHoursBetweenShifts),
    effectiveFrom: row.effectiveFrom.toISOString(),
  };
}

function toBreakDto(row: BreakRow): BreakRecord {
  return {
    breakId: row.id,
    type: row.type,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    minutes: row.minutes,
    recordedBy: row.recordedBy,
  };
}

function toPayLineDto(row: PayLineRow): PayLine {
  return {
    payTypeCode: row.payTypeCode,
    description: row.description,
    minutes: row.minutes,
    rateCents: row.rateCents,
    multiplier: Number(row.multiplier),
    amountCents: row.amountCents,
  };
}

function toExceptionDto(row: ExceptionRow): TimesheetException {
  return {
    exceptionId: row.id,
    timesheetId: row.timesheetId,
    type: row.type,
    awardRuleCode: row.awardRuleCode,
    detail: row.detail,
    overtimeMinutes: row.overtimeMinutes,
    estimatedPayImpactCents: row.estimatedPayImpactCents,
    status: row.status,
    detectedAt: row.detectedAt.toISOString(),
  };
}

/**
 * Half-up cents for a signed minute delta: the half rounds away from zero so a
 * credited minute and a debited minute of the same size stay symmetric.
 */
function signedCentsFor(minutes: number, rateCents: number, multiplier: number): number {
  const sign = Math.sign(minutes);
  return sign * roundCentsHalfUp((Math.abs(minutes) * rateCents * multiplier) / 60);
}

const approvalResponseSchema = z.object({ timesheet: timesheetSchema });

export function createAttendanceService({ database }: ServiceDeps): AttendanceService {
  /**
   * Runs work inside one Postgres transaction. drizzle keeps the transaction's
   * underlying SQL client private, so the one library-boundary read lives
   * here; the outbox writes into that same client.
   */
  async function withTransaction<T>(work: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return database.db.transaction(async (dtx) => {
      return work({ db: dtx, raw: rawClientOf(dtx._.session) });
    });
  }

  async function loadEmployee(tx: ScopedTx, context: ActorContext, employeeId: string): Promise<EmployeeRow> {
    const rows = await tx.db
      .select()
      .from(employeesTable)
      .where(and(eq(employeesTable.tenantId, context.tenantId), eq(employeesTable.id, employeeId)))
      .limit(1);
    const employee = rows[0];
    if (!employee) throw notFound('employee');
    return employee;
  }

  /** The employee's award rule effective at `at`; the latest effective row wins. */
  async function resolveAwardRule(
    tx: ScopedTx,
    context: ActorContext,
    employee: EmployeeRow,
    at: Date,
  ): Promise<AwardRuleRow> {
    const rules = await tx.db
      .select()
      .from(awardRules)
      .where(eq(awardRules.tenantId, context.tenantId))
      .orderBy(desc(awardRules.effectiveFrom));
    const effective = rules.filter((rule) => rule.effectiveFrom.getTime() <= at.getTime());
    if (employee.awardRuleCode) {
      const matched =
        effective.find((rule) => rule.ruleCode === employee.awardRuleCode) ??
        rules.find((rule) => rule.ruleCode === employee.awardRuleCode);
      if (matched) return matched;
      throw notFound(`award rule ${employee.awardRuleCode}`);
    }
    const chosen = effective[0] ?? rules[0];
    if (!chosen) throw notFound('award rule');
    return chosen;
  }

  async function loadAwardRuleByCode(
    tx: ScopedTx,
    context: ActorContext,
    ruleCode: string,
  ): Promise<AwardRuleRow> {
    const rows = await tx.db
      .select()
      .from(awardRules)
      .where(and(eq(awardRules.tenantId, context.tenantId), eq(awardRules.ruleCode, ruleCode)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound(`award rule ${ruleCode}`);
    return row;
  }

  async function loadTimesheet(tx: ScopedTx, context: ActorContext, timesheetId: string): Promise<TimesheetRow> {
    const rows = await tx.db
      .select()
      .from(timesheetsTable)
      .where(and(eq(timesheetsTable.tenantId, context.tenantId), eq(timesheetsTable.id, timesheetId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('timesheet');
    return row;
  }

  /**
   * Finds the open timesheet to clock out of: the one rostered to this shift
   * first, otherwise the employee's latest open shift-less timesheet.
   */
  async function findOpenTimesheet(
    tx: ScopedTx,
    context: ActorContext,
    employeeId: string,
    shiftId: string | null,
  ): Promise<TimesheetRow | null> {
    const rows = await tx.db
      .select()
      .from(timesheetsTable)
      .where(
        and(
          eq(timesheetsTable.tenantId, context.tenantId),
          eq(timesheetsTable.employeeId, employeeId),
          eq(timesheetsTable.status, 'open'),
          shiftId
            ? dsql`(${timesheetsTable.shiftId} = ${shiftId} or ${timesheetsTable.shiftId} is null)`
            : dsql`${timesheetsTable.shiftId} is null`,
        ),
      )
      .orderBy(
        dsql`case when ${timesheetsTable.shiftId} = ${shiftId} then 0 else 1 end`,
        desc(timesheetsTable.periodStart),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function buildTimesheet(
    tx: ScopedTx,
    row: TimesheetRow,
    awardRule: AwardRuleRow,
  ): Promise<{ timesheet: Timesheet; awardRule: AwardRule }> {
    const [breakRows, payLineRows, exceptionRows] = await Promise.all([
      tx.db.select().from(breaksTable).where(eq(breaksTable.timesheetId, row.id)).orderBy(breaksTable.startedAt),
      tx.db
        .select()
        .from(payLinesTable)
        .where(eq(payLinesTable.timesheetId, row.id))
        .orderBy(payLinesTable.payTypeCode),
      tx.db
        .select()
        .from(exceptionsTable)
        .where(eq(exceptionsTable.timesheetId, row.id))
        .orderBy(desc(exceptionsTable.detectedAt)),
    ]);

    return {
      timesheet: toTimesheetDto(
        row,
        breakRows.map(toBreakDto),
        payLineRows.map(toPayLineDto),
        exceptionRows.map(toExceptionDto),
      ),
      awardRule: toAwardRuleDto(awardRule),
    };
  }

  /**
   * Wraps a domain mutation with the idempotency ledger: the first request
   * stores its response inside the same transaction as the domain write; a
   * retry with the same key and body replays the stored response, a retry with
   * a different body is rejected (ADR-0007).
   */
  async function withIdempotency<T>(
    tx: ScopedTx,
    context: ActorContext,
    idempotencyKey: string,
    requestJson: string,
    responseSchema: z.ZodType<T>,
    produce: () => Promise<T>,
  ): Promise<T> {
    const ledger = tx.db;
    const existing = await ledger
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, context.tenantId), eq(idempotencyKeys.idempotencyKey, idempotencyKey)))
      .for('update')
      .limit(1);
    const prior = existing[0];
    if (prior) {
      if (prior.requestHash !== requestJson) {
        throw new DomainError(
          errorCodes.idempotencyMismatch,
          409,
          'this idempotency key was already used with a different request',
        );
      }
      return responseSchema.parse(JSON.parse(prior.response));
    }

    const value = await produce();
    await ledger.insert(idempotencyKeys).values({
      id: crypto.randomUUID(),
      tenantId: context.tenantId,
      idempotencyKey,
      requestHash: requestJson,
      response: JSON.stringify(value),
    });
    return value;
  }

  return {
    async getTimesheetDetail(context, timesheetId) {
      return withTransaction(async (tx) => {
        const row = await loadTimesheet(tx, context, timesheetId);
        const employee = await loadEmployee(tx, context, row.employeeId);
        const awardRule = await resolveAwardRule(tx, context, employee, row.periodEnd ?? row.periodStart);
        return buildTimesheet(tx, row, awardRule);
      });
    },

    async listExceptions(context, timesheetId, status) {
      return withTransaction(async (tx) => {
        const row = await loadTimesheet(tx, context, timesheetId);
        const employee = await loadEmployee(tx, context, row.employeeId);
        const awardRule = await resolveAwardRule(tx, context, employee, row.periodEnd ?? row.periodStart);
        const { timesheet } = await buildTimesheet(tx, row, awardRule);
        return status === 'all' ? timesheet.exceptions : timesheet.exceptions.filter((e) => e.status === status);
      });
    },

    async getAwardRule(context, ruleCode) {
      return withTransaction(async (tx) => toAwardRuleDto(await loadAwardRuleByCode(tx, context, ruleCode)));
    },

    async clockIn(context, shiftId, request) {
      const at = request.at ? new Date(request.at) : new Date();
      return withTransaction(async (tx) => {
        const employee = await loadEmployee(tx, context, request.employeeId);
        const open = await tx.db
          .select({ id: timesheetsTable.id })
          .from(timesheetsTable)
          .where(
            and(
              eq(timesheetsTable.tenantId, context.tenantId),
              eq(timesheetsTable.employeeId, request.employeeId),
              eq(timesheetsTable.status, 'open'),
            ),
          )
          .limit(1);
        if (open[0]) {
          throw new DomainError(errorCodes.conflict, 409, 'an open timesheet already exists for this employee');
        }

        const timesheetId = crypto.randomUUID();
        await tx.db.insert(timesheetsTable).values({
          id: timesheetId,
          tenantId: context.tenantId,
          employeeId: request.employeeId,
          employeeName: employee.name,
          shiftId,
          periodStart: at,
          periodEnd: null,
          status: 'open',
        });

        const event = makeEvent(
          'attendance.clock_in_recorded',
          { employeeId: request.employeeId, shiftId, timesheetId, at: at.toISOString() },
          { tenantId: context.tenantId, actor: actorFromContext(context, 'employee') },
        );
        await enqueueEvents(tx.raw, [event]);

        const row = await loadTimesheet(tx, context, timesheetId);
        const awardRule = await resolveAwardRule(tx, context, employee, at);
        const { timesheet } = await buildTimesheet(tx, row, awardRule);
        return { timesheet, emittedEvents: ['attendance.clock_in_recorded'] };
      });
    },

    async clockOut(context, shiftId, request) {
      const at = new Date(request.at);
      return withTransaction(async (tx) => {
        const employee = await loadEmployee(tx, context, request.employeeId);
        const rule = await resolveAwardRule(tx, context, employee, at);
        const open = await findOpenTimesheet(tx, context, request.employeeId, shiftId);
        if (!open) {
          throw new DomainError(errorCodes.preconditionFailed, 412, 'no open timesheet to clock out of');
        }

        const spanMinutes = Math.floor((at.getTime() - open.periodStart.getTime()) / 60_000);
        if (spanMinutes <= 0) {
          throw new DomainError(errorCodes.preconditionFailed, 412, 'clock-out time is not after clock-in');
        }
        if (request.breakMinutesTaken > spanMinutes) {
          throw new DomainError(errorCodes.validation, 400, 'break minutes exceed the clocked span');
        }

        const workedMinutes = spanMinutes - request.breakMinutesTaken;
        const totals = computeAwardTotals({
          rule: {
            maxOrdinaryMinutesPerDay: rule.maxOrdinaryMinutesPerDay,
            overtimeMultiplier: Number(rule.overtimeMultiplier),
            unpaidBreakMinutes: rule.unpaidBreakMinutes,
            breakRequiredAfterMinutes: rule.breakRequiredAfterMinutes,
          },
          workedMinutes,
          breakMinutesTaken: request.breakMinutesTaken,
          hourlyRateCents: employee.hourlyRateCents,
        });

        const selfClocked = context.employeeId === request.employeeId;
        const actorType = selfClocked ? 'employee' : 'manager';
        const eventContext = { tenantId: context.tenantId, actor: actorFromContext(context, actorType) };
        const events: AnyWfmEvent[] = [];
        const exceptionRows: Array<typeof exceptionsTable.$inferInsert> = [];

        if (request.breakMinutesTaken > 0) {
          await tx.db.insert(breaksTable).values({
            id: crypto.randomUUID(),
            tenantId: context.tenantId,
            timesheetId: open.id,
            type: 'unpaid',
            startedAt: new Date(at.getTime() - request.breakMinutesTaken * 60_000),
            endedAt: at,
            minutes: request.breakMinutesTaken,
            recordedBy: actorType,
          });
        }

        events.push(
          makeEvent(
            'attendance.clock_out_recorded',
            {
              employeeId: request.employeeId,
              shiftId,
              timesheetId: open.id,
              at: request.at,
              breakMinutesTaken: request.breakMinutesTaken,
            },
            eventContext,
          ),
        );

        const raisedBreaches: Array<{ type: 'missed_break' | 'overtime'; detail: string; overtimeMinutes: number; impactCents: number }> = [];

        if (totals.unpaidBreakMinutesOwed > 0) {
          const missedBreakCents = roundCentsHalfUp(
            (totals.unpaidBreakMinutesOwed * employee.hourlyRateCents) / 60,
          );
          const detail = `Required unpaid break of ${rule.unpaidBreakMinutes} min after ${rule.breakRequiredAfterMinutes} min of work was not taken; ${totals.unpaidBreakMinutesOwed} min owed at the ordinary rate.`;
          exceptionRows.push({
            id: crypto.randomUUID(),
            tenantId: context.tenantId,
            timesheetId: open.id,
            type: 'missed_break',
            awardRuleCode: rule.ruleCode,
            detail,
            overtimeMinutes: 0,
            estimatedPayImpactCents: missedBreakCents,
            status: 'open',
            detectedAt: at,
          });
          events.push(
            makeEvent(
              'attendance.missed_break',
              {
                employeeId: request.employeeId,
                shiftId,
                timesheetId: open.id,
                workedMinutes,
                requiredBreakMinutes: rule.breakRequiredAfterMinutes,
                breakMinutesTaken: request.breakMinutesTaken,
              },
              eventContext,
            ),
            makeEvent(
              'award.rule_violation_detected',
              { timesheetId: open.id, employeeId: request.employeeId, ruleCode: rule.ruleCode, detail },
              eventContext,
            ),
          );
          raisedBreaches.push({
            type: 'missed_break',
            detail,
            overtimeMinutes: 0,
            impactCents: missedBreakCents,
          });
        }

        if (totals.overtimeMinutes > 0) {
          const multiplier = Number(rule.overtimeMultiplier);
          const overtimeBaseCents = roundCentsHalfUp((totals.overtimeMinutes * employee.hourlyRateCents) / 60);
          const premiumCents =
            roundCentsHalfUp((totals.overtimeMinutes * employee.hourlyRateCents * multiplier) / 60) -
            overtimeBaseCents;
          const detail = `${totals.overtimeMinutes} min beyond ${rule.maxOrdinaryMinutesPerDay} ordinary minutes at ${multiplier}x.`;
          exceptionRows.push({
            id: crypto.randomUUID(),
            tenantId: context.tenantId,
            timesheetId: open.id,
            type: 'overtime',
            awardRuleCode: rule.ruleCode,
            detail,
            overtimeMinutes: totals.overtimeMinutes,
            estimatedPayImpactCents: premiumCents,
            status: 'open',
            detectedAt: at,
          });
          raisedBreaches.push({
            type: 'overtime',
            detail,
            overtimeMinutes: totals.overtimeMinutes,
            impactCents: premiumCents,
          });
        }

        if (exceptionRows.length > 0) await tx.db.insert(exceptionsTable).values(exceptionRows);

        // One exception event per clock-out, whatever combination of breaches
        // it contained. Two events for one timesheet would start two runs, and
        // two runs could each apply their own stale adjustment.
        if (raisedBreaches.length > 0) {
          const primary = raisedBreaches[0]!;
          events.push(
            makeEvent(
              'timesheet.exception_raised',
              {
                timesheetId: open.id,
                employeeId: request.employeeId,
                shiftId,
                exceptionType: primary.type,
                awardRuleCode: rule.ruleCode,
                detail: raisedBreaches.map((breach) => breach.detail).join(' '),
                overtimeMinutes: raisedBreaches.reduce((sum, breach) => sum + breach.overtimeMinutes, 0),
                estimatedPayImpactCents: raisedBreaches.reduce((sum, breach) => sum + breach.impactCents, 0),
              },
              eventContext,
            ),
          );
        }

        await tx.db
          .update(timesheetsTable)
          .set({
            periodEnd: at,
            status: 'submitted',
            workedMinutes,
            ordinaryMinutes: totals.ordinaryMinutes,
            overtimeMinutes: totals.overtimeMinutes,
            paidMinutes: workedMinutes,
            totalPayCents: totals.totalPayCents,
            updatedAt: at,
          })
          .where(eq(timesheetsTable.id, open.id));

        const payLineRows: Array<typeof payLinesTable.$inferInsert> = [];
        if (totals.ordinaryMinutes > 0) {
          payLineRows.push({
            id: crypto.randomUUID(),
            tenantId: context.tenantId,
            timesheetId: open.id,
            payTypeCode: 'ORD',
            description: 'Ordinary hours',
            minutes: totals.ordinaryMinutes,
            rateCents: employee.hourlyRateCents,
            multiplier: '1.000',
            amountCents: roundCentsHalfUp((totals.ordinaryMinutes * employee.hourlyRateCents) / 60),
          });
        }
        if (totals.overtimeMinutes > 0) {
          const multiplier = Number(rule.overtimeMultiplier);
          payLineRows.push({
            id: crypto.randomUUID(),
            tenantId: context.tenantId,
            timesheetId: open.id,
            payTypeCode: 'OVERTIME',
            description: `Overtime at ${multiplier}x`,
            minutes: totals.overtimeMinutes,
            rateCents: employee.hourlyRateCents,
            multiplier: multiplier.toFixed(3),
            amountCents: roundCentsHalfUp(
              (totals.overtimeMinutes * employee.hourlyRateCents * multiplier) / 60,
            ),
          });
        }
        if (payLineRows.length > 0) await tx.db.insert(payLinesTable).values(payLineRows);

        await enqueueEvents(tx.raw, events);

        const closed = await loadTimesheet(tx, context, open.id);
        const { timesheet } = await buildTimesheet(tx, closed, rule);
        return { timesheet, emittedEvents: events.map((event) => event.eventType) };
      });
    },

    async applyAdjustment(context, timesheetId, idempotencyKey, request) {
      const requestJson = JSON.stringify({ timesheetId, ...request });
      return withTransaction(async (tx) =>
        withIdempotency(tx, context, idempotencyKey, requestJson, adjustmentResponseSchema, async () => {
          const row = await loadTimesheet(tx, context, timesheetId);
          const employee = await loadEmployee(tx, context, row.employeeId);
          const rule = await resolveAwardRule(tx, context, employee, row.periodEnd ?? row.periodStart);
          const multiplier = Number(rule.overtimeMultiplier);

          const unpaidImpact = signedCentsFor(request.unpaidBreakMinutesDelta, employee.hourlyRateCents, 1);
          const overtimeImpact = signedCentsFor(
            request.overtimeMinutesDelta,
            employee.hourlyRateCents,
            multiplier,
          );
          const payImpact = unpaidImpact + overtimeImpact;

          const ordinaryMinutes = row.ordinaryMinutes + request.unpaidBreakMinutesDelta;
          const overtimeMinutes = row.overtimeMinutes + request.overtimeMinutesDelta;
          const paidMinutes =
            row.paidMinutes + request.unpaidBreakMinutesDelta + request.overtimeMinutesDelta;
          if (ordinaryMinutes < 0 || overtimeMinutes < 0 || paidMinutes < 0) {
            throw new DomainError(errorCodes.preconditionFailed, 412, 'adjustment would drive a minute total negative');
          }

          const adjustmentId = crypto.randomUUID();
          await tx.db.insert(adjustmentsTable).values({
            id: adjustmentId,
            tenantId: context.tenantId,
            timesheetId,
            unpaidBreakMinutesDelta: request.unpaidBreakMinutesDelta,
            overtimeMinutesDelta: request.overtimeMinutesDelta,
            payImpactCents: payImpact,
            approvedBy: context.userId,
            reason: request.reason,
            idempotencyKey,
          });

          await tx.db
            .update(timesheetsTable)
            .set({
              ordinaryMinutes,
              overtimeMinutes,
              paidMinutes,
              totalPayCents: row.totalPayCents + payImpact,
              status: 'adjusted',
              updatedAt: new Date(),
            })
            .where(eq(timesheetsTable.id, timesheetId));

          /** Moves an existing pay line by delta, or creates it when absent. */
          async function applyLineDelta(
            payTypeCode: string,
            description: string,
            minutesDelta: number,
            centsDelta: number,
            lineMultiplier: string,
          ): Promise<void> {
            const existingRows = await tx.db
              .select()
              .from(payLinesTable)
              .where(and(eq(payLinesTable.timesheetId, timesheetId), eq(payLinesTable.payTypeCode, payTypeCode)))
              .limit(1);
            const existing = existingRows[0];
            if (existing) {
              await tx.db
                .update(payLinesTable)
                .set({
                  minutes: existing.minutes + minutesDelta,
                  amountCents: existing.amountCents + centsDelta,
                })
                .where(eq(payLinesTable.id, existing.id));
              return;
            }
            if (minutesDelta === 0) return;
            await tx.db.insert(payLinesTable).values({
              id: crypto.randomUUID(),
              tenantId: context.tenantId,
              timesheetId,
              payTypeCode,
              description,
              minutes: minutesDelta,
              rateCents: employee.hourlyRateCents,
              multiplier: lineMultiplier,
              amountCents: centsDelta,
            });
          }

          if (request.unpaidBreakMinutesDelta !== 0) {
            await applyLineDelta(
              'ORD',
              'Missed unpaid break compensated at the ordinary rate',
              request.unpaidBreakMinutesDelta,
              unpaidImpact,
              '1.000',
            );
          }
          if (request.overtimeMinutesDelta !== 0) {
            await applyLineDelta(
              'OVERTIME',
              `Overtime adjustment at ${multiplier}x`,
              request.overtimeMinutesDelta,
              overtimeImpact,
              multiplier.toFixed(3),
            );
          }

          const event = makeEvent(
            'timesheet.adjusted',
            {
              timesheetId,
              adjustmentId,
              unpaidBreakMinutesDelta: request.unpaidBreakMinutesDelta,
              overtimeMinutesDelta: request.overtimeMinutesDelta,
              payImpactCents: payImpact,
              approvedBy: context.userId,
              reason: request.reason,
            },
            { tenantId: context.tenantId, actor: actorFromContext(context) },
          );
          await enqueueEvents(tx.raw, [event]);

          return {
            timesheetId,
            adjustmentId,
            unpaidBreakMinutesDelta: request.unpaidBreakMinutesDelta,
            overtimeMinutesDelta: request.overtimeMinutesDelta,
            payImpactCents: payImpact,
            appliedBy: context.userId,
          };
        }),
      );
    },

    async decideApproval(context, timesheetId, idempotencyKey, request) {
      const produce = async (tx: ScopedTx): Promise<ApprovalResponse> => {
        const row = await loadTimesheet(tx, context, timesheetId);
        if (row.status === 'approved') {
          throw new DomainError(errorCodes.conflict, 409, 'timesheet is already approved');
        }

        const employee = await loadEmployee(tx, context, row.employeeId);
        const rule = await resolveAwardRule(tx, context, employee, row.periodEnd ?? row.periodStart);

        if (request.decision === 'reject') {
          await tx.db
            .update(timesheetsTable)
            .set({ status: 'open', updatedAt: new Date() })
            .where(eq(timesheetsTable.id, timesheetId));
          const reopened = { ...row, status: 'open' as const };
          return { timesheet: (await buildTimesheet(tx, reopened, rule)).timesheet };
        }

        if (!row.periodEnd) {
          throw new DomainError(errorCodes.preconditionFailed, 412, 'clock out before approving');
        }
        await tx.db
          .update(timesheetsTable)
          .set({ status: 'approved', updatedAt: new Date() })
          .where(eq(timesheetsTable.id, timesheetId));

        const event = makeEvent(
          'timesheet.submitted',
          {
            timesheetId,
            employeeId: row.employeeId,
            periodStart: row.periodStart.toISOString(),
            periodEnd: row.periodEnd.toISOString(),
            totalPayCents: row.totalPayCents,
          },
          { tenantId: context.tenantId, actor: actorFromContext(context) },
        );
        await enqueueEvents(tx.raw, [event]);

        const approved = { ...row, status: 'approved' as const };
        return { timesheet: (await buildTimesheet(tx, approved, rule)).timesheet };
      };

      return withTransaction(async (tx) =>
        idempotencyKey
          ? withIdempotency(
              tx,
              context,
              idempotencyKey,
              JSON.stringify({ timesheetId, ...request }),
              approvalResponseSchema,
              () => produce(tx),
            )
          : produce(tx),
      );
    },

    async recordNoShow(context, timesheetId, request) {
      const at = new Date();
      return withTransaction(async (tx) => {
        const row = await loadTimesheet(tx, context, timesheetId);
        if (!row.shiftId) {
          throw new DomainError(errorCodes.preconditionFailed, 412, 'no-show requires a rostered shift');
        }
        const employee = await loadEmployee(tx, context, row.employeeId);
        const rule = await resolveAwardRule(tx, context, employee, at);
        const shiftStartsAt = request.shiftStartsAt ?? row.periodStart.toISOString();
        const minutesLate = request.minutesLate ?? 0;
        const detail = `Employee did not attend shift ${row.shiftId} (start ${shiftStartsAt}); recorded ${minutesLate} min late.`;

        await tx.db.insert(exceptionsTable).values({
          id: crypto.randomUUID(),
          tenantId: context.tenantId,
          timesheetId,
          type: 'no_show',
          awardRuleCode: rule.ruleCode,
          detail,
          overtimeMinutes: 0,
          estimatedPayImpactCents: 0,
          status: 'open',
          detectedAt: at,
        });

        const event = makeEvent(
          'attendance.no_show',
          {
            employeeId: row.employeeId,
            shiftId: row.shiftId,
            timesheetId,
            shiftStartsAt,
            minutesLate,
          },
          { tenantId: context.tenantId, actor: actorFromContext(context, 'manager') },
        );
        await enqueueEvents(tx.raw, [event]);
        return { emittedEvents: ['attendance.no_show'] };
      });
    },

    async close() {
      await database.sql.close({ timeout: 5 });
    },
  };
}
