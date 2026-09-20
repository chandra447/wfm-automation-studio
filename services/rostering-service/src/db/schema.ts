import { customType, pgTable, integer, pgEnum, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Rostering persistence. This file is the model drizzle-kit generates
 * migrations from (drizzle.config.ts → drizzle/); query code uses Bun's SQL
 * client against the same columns because the outbox and every transactional
 * write share its transaction type (ADR-0007).
 */

/**
 * Bun SQL encodes a string bound for a jsonb column a second time, so a
 * drizzle `jsonb()` column (which JSON.stringifys its driver data) lands as a
 * jsonb string scalar. Passing the value through untouched stores the real
 * object; reads already come back parsed.
 */
const jsonbObject = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return 'jsonb';
  },
});

export const shiftStatusEnum = pgEnum('shift_status', ['draft', 'published', 'offered', 'assigned', 'cancelled']);
export const shiftOfferStatusEnum = pgEnum('shift_offer_status', ['sent', 'accepted', 'declined', 'expired']);

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
});

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  hourlyRateCents: integer('hourly_rate_cents').notNull(),
  weeklyHours: integer('weekly_hours').notNull(),
});

export const employeeQualifications = pgTable('employee_qualifications', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  code: text('code').notNull(),
});

/** Windows when the employee can work: weekday 0-6, minutes from midnight. */
export const employeeAvailability = pgTable('employee_availability', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  weekday: integer('weekday').notNull(),
  startMinute: integer('start_minute').notNull(),
  endMinute: integer('end_minute').notNull(),
});

export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  roleName: text('role_name').notNull(),
  requiredQualificationCodes: jsonbObject('required_qualification_codes').$type<string[]>().notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  hourlyRateCents: integer('hourly_rate_cents').notNull(),
  status: shiftStatusEnum('status').notNull().default('draft'),
  assignedEmployeeId: uuid('assigned_employee_id'),
  baselineCostCents: integer('baseline_cost_cents').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shiftOffers = pgTable('shift_offers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  shiftId: uuid('shift_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  status: shiftOfferStatusEnum('status').notNull().default('sent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const swapRequests = pgTable('swap_requests', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  shiftId: uuid('shift_id').notNull(),
  requestingEmployeeId: uuid('requesting_employee_id').notNull(),
  targetEmployeeId: uuid('target_employee_id'),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonbObject('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.key], name: 'idempotency_keys_pkey' })],
);
