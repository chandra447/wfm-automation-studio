import { z } from 'zod';
import { centsSchema, isoDateTimeSchema, uuidSchema } from '../primitives.ts';

/** Time & attendance service request/response contracts. */

export const payLineSchema = z.object({
  payTypeCode: z.string().min(1),
  description: z.string().min(1),
  minutes: z.int().nonnegative(),
  rateCents: centsSchema,
  multiplier: z.number().positive(),
  amountCents: centsSchema,
});

export const breakRecordSchema = z.object({
  breakId: uuidSchema,
  type: z.enum(['unpaid', 'paid']),
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  minutes: z.int().nonnegative(),
  recordedBy: z.enum(['employee', 'manager', 'system']),
});

export const timesheetExceptionSchema = z.object({
  exceptionId: uuidSchema,
  timesheetId: uuidSchema,
  type: z.enum(['missed_break', 'overtime', 'award_violation', 'no_show']),
  awardRuleCode: z.string().min(1),
  detail: z.string().min(1),
  overtimeMinutes: z.int().nonnegative(),
  estimatedPayImpactCents: centsSchema,
  status: z.enum(['open', 'resolved']),
  detectedAt: isoDateTimeSchema,
});

export const timesheetSchema = z.object({
  timesheetId: uuidSchema,
  tenantId: uuidSchema,
  employeeId: uuidSchema,
  employeeName: z.string().min(1),
  shiftId: uuidSchema.nullable(),
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  status: z.enum(['open', 'submitted', 'approved', 'adjusted']),
  workedMinutes: z.int().nonnegative(),
  ordinaryMinutes: z.int().nonnegative(),
  overtimeMinutes: z.int().nonnegative(),
  paidMinutes: z.int().nonnegative(),
  totalPayCents: centsSchema,
  breaks: z.array(breakRecordSchema),
  payLines: z.array(payLineSchema),
  exceptions: z.array(timesheetExceptionSchema),
});

export const awardRuleSchema = z.object({
  ruleCode: z.string().min(1),
  name: z.string().min(1),
  maxOrdinaryMinutesPerDay: z.int().positive(),
  overtimeMultiplier: z.number().positive(),
  breakRequiredAfterMinutes: z.int().positive(),
  unpaidBreakMinutes: z.int().nonnegative(),
  minimumRestHoursBetweenShifts: z.number().nonnegative(),
  effectiveFrom: isoDateTimeSchema,
});

export const adjustmentRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  unpaidBreakMinutesDelta: z.int().default(0),
  overtimeMinutesDelta: z.int().default(0),
});

export const adjustmentResponseSchema = z.object({
  timesheetId: uuidSchema,
  adjustmentId: uuidSchema,
  unpaidBreakMinutesDelta: z.int(),
  overtimeMinutesDelta: z.int(),
  payImpactCents: centsSchema,
  appliedBy: z.string().min(1),
});

export const timesheetApprovalRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).max(500),
});

export const clockOutRequestSchema = z.object({
  employeeId: uuidSchema,
  shiftId: uuidSchema.nullable(),
  at: isoDateTimeSchema,
  breakMinutesTaken: z.int().nonnegative(),
});

export const timesheetDetailResponseSchema = z.object({
  timesheet: timesheetSchema,
  awardRule: awardRuleSchema,
});

export type PayLine = z.infer<typeof payLineSchema>;
export type BreakRecord = z.infer<typeof breakRecordSchema>;
export type TimesheetException = z.infer<typeof timesheetExceptionSchema>;
export type Timesheet = z.infer<typeof timesheetSchema>;
export type AwardRule = z.infer<typeof awardRuleSchema>;
export type AdjustmentRequest = z.infer<typeof adjustmentRequestSchema>;
export type AdjustmentResponse = z.infer<typeof adjustmentResponseSchema>;
export type TimesheetApprovalRequest = z.infer<typeof timesheetApprovalRequestSchema>;
export type ClockOutRequest = z.infer<typeof clockOutRequestSchema>;
export type TimesheetDetailResponse = z.infer<typeof timesheetDetailResponseSchema>;
