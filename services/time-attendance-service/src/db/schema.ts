import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type TimesheetStatus = 'open' | 'submitted' | 'approved' | 'adjusted';
export type BreakType = 'unpaid' | 'paid';
export type BreakRecordedBy = 'employee' | 'manager' | 'system';
export type ExceptionType = 'missed_break' | 'overtime' | 'award_violation' | 'no_show';
export type ExceptionStatus = 'open' | 'resolved';

export const employees = pgTable(
    'employees',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      name: text('name').notNull(),
      hourlyRateCents: integer('hourly_rate_cents').notNull(),
      awardRuleCode: text('award_rule_code'),
    },
    (table) => [index('employees_tenant_idx').on(table.tenantId)],
);

export const awardRules = pgTable(
  'award_rules',
  {
    tenantId: uuid('tenant_id').notNull(),
    ruleCode: text('rule_code').notNull(),
    name: text('name').notNull(),
    maxOrdinaryMinutesPerDay: integer('max_ordinary_minutes_per_day').notNull(),
    overtimeMultiplier: numeric('overtime_multiplier', { precision: 6, scale: 3 }).notNull(),
    breakRequiredAfterMinutes: integer('break_required_after_minutes').notNull(),
    unpaidBreakMinutes: integer('unpaid_break_minutes').notNull(),
    minimumRestHoursBetweenShifts: numeric('minimum_rest_hours_between_shifts', {
      precision: 5,
      scale: 2,
    }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('award_rules_tenant_code_unique').on(table.tenantId, table.ruleCode)],
);

export const timesheets = pgTable(
  'timesheets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    employeeName: text('employee_name').notNull(),
    shiftId: uuid('shift_id'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    status: text('status').$type<TimesheetStatus>().notNull(),
    workedMinutes: integer('worked_minutes').notNull().default(0),
    ordinaryMinutes: integer('ordinary_minutes').notNull().default(0),
    overtimeMinutes: integer('overtime_minutes').notNull().default(0),
    paidMinutes: integer('paid_minutes').notNull().default(0),
    totalPayCents: integer('total_pay_cents').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('timesheets_tenant_idx').on(table.tenantId),
    index('timesheets_employee_shift_idx').on(table.employeeId, table.shiftId),
  ],
);

export const breaks = pgTable(
  'breaks',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    timesheetId: uuid('timesheet_id')
      .notNull()
      .references(() => timesheets.id),
    type: text('type').$type<BreakType>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    minutes: integer('minutes').notNull(),
    recordedBy: text('recorded_by').$type<BreakRecordedBy>().notNull(),
  },
  (table) => [index('breaks_timesheet_idx').on(table.timesheetId)],
);

export const payLines = pgTable(
  'pay_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    timesheetId: uuid('timesheet_id')
      .notNull()
      .references(() => timesheets.id),
    payTypeCode: text('pay_type_code').notNull(),
    description: text('description').notNull(),
    minutes: integer('minutes').notNull(),
    rateCents: integer('rate_cents').notNull(),
    multiplier: numeric('multiplier', { precision: 6, scale: 3 }).notNull(),
    amountCents: integer('amount_cents').notNull(),
  },
  (table) => [index('pay_lines_timesheet_idx').on(table.timesheetId)],
);

export const exceptions = pgTable(
  'exceptions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    timesheetId: uuid('timesheet_id')
      .notNull()
      .references(() => timesheets.id),
    type: text('type').$type<ExceptionType>().notNull(),
    awardRuleCode: text('award_rule_code').notNull(),
    detail: text('detail').notNull(),
    overtimeMinutes: integer('overtime_minutes').notNull().default(0),
    estimatedPayImpactCents: integer('estimated_pay_impact_cents').notNull().default(0),
    status: text('status').$type<ExceptionStatus>().notNull().default('open'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('exceptions_timesheet_idx').on(table.timesheetId),
    index('exceptions_status_idx').on(table.status),
  ],
);

export const adjustments = pgTable(
  'adjustments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    timesheetId: uuid('timesheet_id')
      .notNull()
      .references(() => timesheets.id),
    unpaidBreakMinutesDelta: integer('unpaid_break_minutes_delta').notNull(),
    overtimeMinutesDelta: integer('overtime_minutes_delta').notNull(),
    payImpactCents: integer('pay_impact_cents').notNull(),
    approvedBy: text('approved_by').notNull(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('adjustments_timesheet_idx').on(table.timesheetId)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: text('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idempotency_keys_unique').on(table.tenantId, table.idempotencyKey)],
);
