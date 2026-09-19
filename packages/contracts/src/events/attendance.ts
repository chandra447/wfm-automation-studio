import { z } from 'zod';
import { centsSchema, isoDateTimeSchema, uuidSchema } from '../primitives.ts';

/** Time & attendance / award compliance domain events. */

export const clockInRecordedSchema = z.object({
  employeeId: uuidSchema,
  shiftId: uuidSchema.nullable(),
  timesheetId: uuidSchema,
  at: isoDateTimeSchema,
});

export const clockOutRecordedSchema = z.object({
  employeeId: uuidSchema,
  shiftId: uuidSchema.nullable(),
  timesheetId: uuidSchema,
  at: isoDateTimeSchema,
  breakMinutesTaken: z.int().nonnegative(),
});

export const missedBreakSchema = z.object({
  employeeId: uuidSchema,
  shiftId: uuidSchema.nullable(),
  timesheetId: uuidSchema,
  workedMinutes: z.int().positive(),
  requiredBreakMinutes: z.int().positive(),
  breakMinutesTaken: z.int().nonnegative(),
});

export const noShowSchema = z.object({
  employeeId: uuidSchema,
  shiftId: uuidSchema,
  timesheetId: uuidSchema.nullable(),
  shiftStartsAt: isoDateTimeSchema,
  minutesLate: z.int().nonnegative(),
});

export const timesheetExceptionRaisedSchema = z.object({
  timesheetId: uuidSchema,
  employeeId: uuidSchema,
  shiftId: uuidSchema.nullable(),
  exceptionType: z.enum(['missed_break', 'overtime', 'award_violation', 'no_show']),
  awardRuleCode: z.string().min(1),
  detail: z.string().min(1),
  overtimeMinutes: z.int().nonnegative(),
  estimatedPayImpactCents: centsSchema,
});

export const timesheetSubmittedSchema = z.object({
  timesheetId: uuidSchema,
  employeeId: uuidSchema,
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  totalPayCents: centsSchema,
});

export const timesheetAdjustedSchema = z.object({
  timesheetId: uuidSchema,
  adjustmentId: uuidSchema,
  unpaidBreakMinutesDelta: z.int(),
  overtimeMinutesDelta: z.int(),
  payImpactCents: centsSchema,
  approvedBy: z.string().min(1),
  reason: z.string().min(1),
});

export const awardRuleViolationSchema = z.object({
  timesheetId: uuidSchema,
  employeeId: uuidSchema,
  ruleCode: z.string().min(1),
  detail: z.string().min(1),
});

export type ClockInRecorded = z.infer<typeof clockInRecordedSchema>;
export type ClockOutRecorded = z.infer<typeof clockOutRecordedSchema>;
export type MissedBreak = z.infer<typeof missedBreakSchema>;
export type NoShow = z.infer<typeof noShowSchema>;
export type TimesheetExceptionRaised = z.infer<typeof timesheetExceptionRaisedSchema>;
export type TimesheetSubmitted = z.infer<typeof timesheetSubmittedSchema>;
export type TimesheetAdjusted = z.infer<typeof timesheetAdjustedSchema>;
export type AwardRuleViolation = z.infer<typeof awardRuleViolationSchema>;
