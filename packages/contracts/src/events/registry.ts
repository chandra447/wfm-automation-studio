import { z } from 'zod';
import { EventValidationError, envelopeBaseSchema, type EventContext } from '../envelope.ts';
import * as rostering from './rostering.ts';
import * as attendance from './attendance.ts';
import * as studio from './studio.ts';

/**
 * Single source of truth for every event on the backbone. The studio trigger
 * catalogue, JSON Schema exports, producer validation, and the contract tests
 * all read from this registry, so a new event cannot be published without a
 * definition here.
 */
export interface EventDefinition<TType extends string = string, TPayload extends z.ZodType = z.ZodType> {
  type: TType;
  version: number;
  owner: 'rostering' | 'time-attendance' | 'studio';
  aggregateType: string;
  summary: string;
  schema: TPayload;
  aggregateIdOf: (payload: z.infer<TPayload>) => string;
  sample: z.infer<TPayload>;
}

function defineEvent<TType extends string, TPayload extends z.ZodType>(
  definition: EventDefinition<TType, TPayload>,
): EventDefinition<TType, TPayload> {
  return definition;
}

export const eventDefinitions = [
  defineEvent({
    type: 'shift.published',
    version: 1,
    owner: 'rostering',
    aggregateType: 'shift',
    summary: 'A shift was published onto the roster and is now open to employees.',
    schema: rostering.shiftPublishedSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      shiftId: '22222222-2222-4222-8222-000000000001',
      locationId: '33333333-3333-4333-8333-000000000001',
      roleName: 'Registered Nurse',
      requiredQualificationCodes: ['RN', 'AGED_CARE'],
      startsAt: '2026-09-21T04:00:00.000Z',
      endsAt: '2026-09-21T12:00:00.000Z',
      hourlyRateCents: 6200,
    },
  }),
  defineEvent({
    type: 'shift.unfilled',
    version: 1,
    owner: 'rostering',
    aggregateType: 'shift',
    summary: 'A published shift is still unfilled inside the coverage window.',
    schema: rostering.shiftUnfilledSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      shiftId: '22222222-2222-4222-8222-000000000002',
      locationId: '33333333-3333-4333-8333-000000000001',
      startsAt: '2026-09-22T04:00:00.000Z',
      hoursUntilStart: 26,
    },
  }),
  defineEvent({
    type: 'shift.cancelled',
    version: 1,
    owner: 'rostering',
    aggregateType: 'shift',
    summary: 'A rostered employee cancelled — the shift needs coverage.',
    schema: rostering.shiftCancelledSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      shiftId: '22222222-2222-4222-8222-000000000003',
      locationId: '33333333-3333-4333-8333-000000000001',
      startsAt: '2026-09-21T04:00:00.000Z',
      hoursUntilStart: 7.5,
      reason: 'Sick leave',
      cancelledByEmployeeId: '44444444-4444-4444-8444-000000000001',
      requiredQualificationCodes: ['RN', 'AGED_CARE'],
      roleName: 'Registered Nurse',
    },
  }),
  defineEvent({
    type: 'shift.swap_requested',
    version: 1,
    owner: 'rostering',
    aggregateType: 'shift',
    summary: 'An employee asked to swap a shift with a colleague.',
    schema: rostering.shiftSwapRequestedSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      swapRequestId: '55555555-5555-4555-8555-000000000001',
      shiftId: '22222222-2222-4222-8222-000000000004',
      requestingEmployeeId: '44444444-4444-4444-8444-000000000002',
      targetEmployeeId: null,
      reason: 'University exam',
    },
  }),
  defineEvent({
    type: 'shift.offers_sent',
    version: 1,
    owner: 'rostering',
    aggregateType: 'shift',
    summary: 'Shift offers were issued to one or more employees.',
    schema: rostering.shiftOffersSentSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      shiftId: '22222222-2222-4222-8222-000000000003',
      offerIds: ['66666666-6666-4666-8666-000000000001'],
      employeeIds: ['44444444-4444-4444-8444-000000000003'],
      expiresAt: '2026-09-20T23:00:00.000Z',
      reason: 'Coverage rescue for cancelled shift',
    },
  }),
  defineEvent({
    type: 'shift.assigned',
    version: 1,
    owner: 'rostering',
    aggregateType: 'shift',
    summary: 'A shift is filled.',
    schema: rostering.shiftAssignedSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      shiftId: '22222222-2222-4222-8222-000000000003',
      employeeId: '44444444-4444-4444-8444-000000000003',
      assignedBy: 'employee_acceptance',
    },
  }),
  defineEvent({
    type: 'attendance.clock_in_recorded',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary: 'An employee clocked in.',
    schema: attendance.clockInRecordedSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      employeeId: '44444444-4444-4444-8444-000000000003',
      shiftId: '22222222-2222-4222-8222-000000000005',
      timesheetId: '77777777-7777-4777-8777-000000000001',
      at: '2026-09-20T23:58:00.000Z',
    },
  }),
  defineEvent({
    type: 'attendance.clock_out_recorded',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary: 'An employee clocked out.',
    schema: attendance.clockOutRecordedSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      employeeId: '44444444-4444-4444-8444-000000000003',
      shiftId: '22222222-2222-4222-8222-000000000005',
      timesheetId: '77777777-7777-4777-8777-000000000001',
      at: '2026-09-21T08:15:00.000Z',
      breakMinutesTaken: 0,
    },
  }),
  defineEvent({
    type: 'attendance.missed_break',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary: 'An unpaid break required by the award was not taken.',
    schema: attendance.missedBreakSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      employeeId: '44444444-4444-4444-8444-000000000003',
      shiftId: '22222222-2222-4222-8222-000000000005',
      timesheetId: '77777777-7777-4777-8777-000000000001',
      workedMinutes: 495,
      requiredBreakMinutes: 30,
      breakMinutesTaken: 0,
    },
  }),
  defineEvent({
    type: 'attendance.no_show',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'shift',
    summary: 'An employee did not arrive for a rostered shift.',
    schema: attendance.noShowSchema,
    aggregateIdOf: (payload) => payload.shiftId,
    sample: {
      employeeId: '44444444-4444-4444-8444-000000000004',
      shiftId: '22222222-2222-4222-8222-000000000006',
      timesheetId: null,
      shiftStartsAt: '2026-09-21T04:00:00.000Z',
      minutesLate: 45,
    },
  }),
  defineEvent({
    type: 'timesheet.exception_raised',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary:
      'A pay-affecting exception was detected on a timesheet (overtime, missed break, award breach).',
    schema: attendance.timesheetExceptionRaisedSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      timesheetId: '77777777-7777-4777-8777-000000000001',
      employeeId: '44444444-4444-4444-8444-000000000003',
      shiftId: '22222222-2222-4222-8222-000000000005',
      exceptionType: 'missed_break',
      awardRuleCode: 'MA000034',
      detail: 'Unpaid 30 minute break not recorded on a 8.25 hour shift',
      overtimeMinutes: 75,
      estimatedPayImpactCents: 8240,
    },
  }),
  defineEvent({
    type: 'timesheet.submitted',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary: 'A timesheet was submitted for approval.',
    schema: attendance.timesheetSubmittedSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      timesheetId: '77777777-7777-4777-8777-000000000001',
      employeeId: '44444444-4444-4444-8444-000000000003',
      periodStart: '2026-09-14T00:00:00.000Z',
      periodEnd: '2026-09-20T23:59:59.000Z',
      totalPayCents: 512300,
    },
  }),
  defineEvent({
    type: 'timesheet.adjusted',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary: 'An approved adjustment was applied to a timesheet.',
    schema: attendance.timesheetAdjustedSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      timesheetId: '77777777-7777-4777-8777-000000000001',
      adjustmentId: '88888888-8888-4888-8888-000000000001',
      unpaidBreakMinutesDelta: 30,
      overtimeMinutesDelta: -75,
      payImpactCents: -8240,
      approvedBy: 'people-ops@demo.test',
      reason: 'Break recorded by exception approval',
    },
  }),
  defineEvent({
    type: 'award.rule_violation_detected',
    version: 1,
    owner: 'time-attendance',
    aggregateType: 'timesheet',
    summary: 'A timesheet breaches an award rule (rest period, ordinary hours, break entitlement).',
    schema: attendance.awardRuleViolationSchema,
    aggregateIdOf: (payload) => payload.timesheetId,
    sample: {
      timesheetId: '77777777-7777-4777-8777-000000000001',
      employeeId: '44444444-4444-4444-8444-000000000003',
      ruleCode: 'MIN_REST_10H',
      detail: 'Only 8.5 hours between consecutive shifts',
    },
  }),
  defineEvent({
    type: 'workflow.run_started',
    version: 1,
    owner: 'studio',
    aggregateType: 'run',
    summary: 'An automation run was started from a matched trigger.',
    schema: studio.runStartedSchema,
    aggregateIdOf: (payload) => payload.runId,
    sample: {
      runId: '99999999-9999-4999-8999-000000000001',
      workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      triggerEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
      triggerEventType: 'shift.cancelled',
    },
  }),
  defineEvent({
    type: 'workflow.approval_requested',
    version: 1,
    owner: 'studio',
    aggregateType: 'run',
    summary: 'A run is waiting on a human decision.',
    schema: studio.approvalRequestedSchema,
    aggregateIdOf: (payload) => payload.runId,
    sample: {
      runId: '99999999-9999-4999-8999-000000000001',
      approvalId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      requestedFromRole: 'roster_manager',
      expiresAt: '2026-09-20T08:00:00.000Z',
      subject: 'Coverage rescue for shift 2222…0003',
      payImpactCents: 18400,
    },
  }),
  defineEvent({
    type: 'workflow.approval_decided',
    version: 1,
    owner: 'studio',
    aggregateType: 'run',
    summary: 'A human approved, rejected, or let an approval expire.',
    schema: studio.approvalDecidedSchema,
    aggregateIdOf: (payload) => payload.runId,
    sample: {
      runId: '99999999-9999-4999-8999-000000000001',
      approvalId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      decision: 'approved',
      decidedBy: 'manager@demo.test',
      reason: 'Coverage required for morning medication round',
    },
  }),
  defineEvent({
    type: 'workflow.action_executed',
    version: 1,
    owner: 'studio',
    aggregateType: 'run',
    summary: 'The engine issued a command to a domain service.',
    schema: studio.actionExecutedSchema,
    aggregateIdOf: (payload) => payload.runId,
    sample: {
      runId: '99999999-9999-4999-8999-000000000001',
      workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      action: 'send_offers',
      targetService: 'rostering',
      command: 'POST /shifts/{shiftId}/offers',
      idempotencyKey: 'run:99999999:step:send_offers',
      resultSummary: 'Offers sent to 3 employees',
      payImpactCents: 18400,
    },
  }),
  defineEvent({
    type: 'workflow.run_completed',
    version: 1,
    owner: 'studio',
    aggregateType: 'run',
    summary: 'A run finished.',
    schema: studio.runCompletedSchema,
    aggregateIdOf: (payload) => payload.runId,
    sample: {
      runId: '99999999-9999-4999-8999-000000000001',
      workflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      status: 'succeeded',
      actionsExecuted: 2,
      durationMs: 480000,
    },
  }),
] as const;

export type EventDefinitionList = typeof eventDefinitions;
export type EventType = EventDefinitionList[number]['type'];

const definitionsByType: Readonly<Record<string, EventDefinition>> = Object.fromEntries(
  eventDefinitions.map((definition) => [definition.type, definition as EventDefinition]),
);

export function definitionFor(eventType: string): EventDefinition | undefined {
  return definitionsByType[eventType];
}

export type PayloadOf<TType extends EventType> = z.infer<
  Extract<EventDefinitionList[number], { type: TType }>['schema']
>;

export type WfmEvent<TType extends EventType> = z.infer<typeof envelopeBaseSchema> & {
  eventType: TType;
  payload: PayloadOf<TType>;
};

export type AnyWfmEvent = { [K in EventType]: WfmEvent<K> }[EventType];

/**
 * Validates an incoming event against the registry. Unknown types and unknown
 * versions are rejected explicitly (they go to the DLQ rather than being
 * silently ignored) — see ADR-0007.
 */
export function parseEvent(input: unknown): AnyWfmEvent {
  const envelope = envelopeBaseSchema.safeParse(input);
  if (!envelope.success) {
    throw new EventValidationError(
      'invalid envelope',
      envelope.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const definition = definitionsByType[envelope.data.eventType];
  if (!definition) {
    throw new EventValidationError(`unknown event type: ${envelope.data.eventType}`);
  }
  if (definition.version !== envelope.data.eventVersion) {
    throw new EventValidationError(
      `unsupported version ${envelope.data.eventVersion} for ${definition.type} (expected ${definition.version})`,
    );
  }

  const payload = definition.schema.safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new EventValidationError(
      `invalid payload for ${definition.type}`,
      payload.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  return { ...envelope.data, payload: payload.data } as AnyWfmEvent;
}

export function makeEvent<TType extends EventType>(
  type: TType,
  payload: PayloadOf<TType>,
  context: EventContext,
): WfmEvent<TType> {
  const definition = definitionsByType[type];
  if (!definition) throw new EventValidationError(`unknown event type: ${type}`);

  const validatedPayload = definition.schema.parse(payload) as PayloadOf<TType>;
  const event = {
    eventId: context.eventId ?? crypto.randomUUID(),
    eventType: type,
    eventVersion: definition.version,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    tenantId: context.tenantId,
    aggregate: { type: definition.aggregateType, id: definition.aggregateIdOf(validatedPayload) },
    actor: context.actor ?? null,
    correlationId: context.correlationId ?? crypto.randomUUID(),
    causationId: context.causationId ?? null,
    traceparent: context.traceparent ?? null,
    payload: validatedPayload,
  };
  return event as WfmEvent<TType>;
}
