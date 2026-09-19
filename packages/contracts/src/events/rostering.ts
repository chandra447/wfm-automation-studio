import { z } from 'zod';
import { centsSchema, isoDateTimeSchema, uuidSchema } from '../primitives.ts';

/** Rostering domain events. Slugs follow the `entity.past_tense` convention. */

export const shiftPublishedSchema = z.object({
  shiftId: uuidSchema,
  locationId: uuidSchema,
  roleName: z.string().min(1),
  requiredQualificationCodes: z.array(z.string().min(1)),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  hourlyRateCents: centsSchema,
});

export const shiftUnfilledSchema = z.object({
  shiftId: uuidSchema,
  locationId: uuidSchema,
  startsAt: isoDateTimeSchema,
  hoursUntilStart: z.number().nonnegative(),
});

export const shiftCancelledSchema = z.object({
  shiftId: uuidSchema,
  locationId: uuidSchema,
  startsAt: isoDateTimeSchema,
  hoursUntilStart: z.number().nonnegative(),
  reason: z.string().min(1),
  cancelledByEmployeeId: uuidSchema.nullable(),
  requiredQualificationCodes: z.array(z.string().min(1)),
  roleName: z.string().min(1),
});

export const shiftSwapRequestedSchema = z.object({
  swapRequestId: uuidSchema,
  shiftId: uuidSchema,
  requestingEmployeeId: uuidSchema,
  targetEmployeeId: uuidSchema.nullable(),
  reason: z.string().min(1),
});

export const shiftOffersSentSchema = z.object({
  shiftId: uuidSchema,
  offerIds: z.array(uuidSchema),
  employeeIds: z.array(uuidSchema),
  expiresAt: isoDateTimeSchema,
  reason: z.string().min(1),
});

export const shiftAssignedSchema = z.object({
  shiftId: uuidSchema,
  employeeId: uuidSchema,
  assignedBy: z.enum(['manager', 'system', 'employee_acceptance']),
});

export type ShiftPublished = z.infer<typeof shiftPublishedSchema>;
export type ShiftUnfilled = z.infer<typeof shiftUnfilledSchema>;
export type ShiftCancelled = z.infer<typeof shiftCancelledSchema>;
export type ShiftSwapRequested = z.infer<typeof shiftSwapRequestedSchema>;
export type ShiftOffersSent = z.infer<typeof shiftOffersSentSchema>;
export type ShiftAssigned = z.infer<typeof shiftAssignedSchema>;
