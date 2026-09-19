import { z } from 'zod';
import { centsSchema, isoDateTimeSchema, uuidSchema } from '../primitives.ts';

/** Rostering service request/response contracts. */

export const shiftStatusSchema = z.enum(['draft', 'published', 'offered', 'assigned', 'cancelled']);

export const shiftSchema = z.object({
  shiftId: uuidSchema,
  tenantId: uuidSchema,
  locationId: uuidSchema,
  locationName: z.string().min(1),
  roleName: z.string().min(1),
  requiredQualificationCodes: z.array(z.string().min(1)),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  hourlyRateCents: centsSchema,
  status: shiftStatusSchema,
  assignedEmployeeId: uuidSchema.nullable(),
});

export const candidateSchema = z.object({
  employeeId: uuidSchema,
  employeeName: z.string().min(1),
  qualificationCodes: z.array(z.string().min(1)),
  hourlyRateCents: centsSchema,
  estimatedCostCents: centsSchema,
  costDeltaVsBaselineCents: centsSchema,
  overtimeRisk: z.enum(['none', 'low', 'high']),
  restHoursBeforeShift: z.number().nonnegative(),
  meetsRestRule: z.boolean(),
  score: z.number(),
  reasons: z.array(z.string().min(1)),
});

export const candidateListSchema = z.object({
  shiftId: uuidSchema,
  candidates: z.array(candidateSchema),
  generatedAt: isoDateTimeSchema,
});

export const createOffersRequestSchema = z.object({
  employeeIds: z.array(uuidSchema).min(1),
  expiresAt: isoDateTimeSchema,
  reason: z.string().min(1).max(500),
});

export const offersResponseSchema = z.object({
  shiftId: uuidSchema,
  offers: z.array(
    z.object({
      offerId: uuidSchema,
      employeeId: uuidSchema,
      status: z.enum(['sent', 'accepted', 'declined', 'expired']),
    }),
  ),
});

export const assignShiftRequestSchema = z.object({
  employeeId: uuidSchema,
  reason: z.string().min(1).max(500),
});

export const cancellationRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  cancelledByEmployeeId: uuidSchema.optional(),
});

export const acceptanceRequestSchema = z.object({
  employeeId: uuidSchema,
  offerId: uuidSchema,
});

export const shiftListQuerySchema = z.object({
  locationId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  status: shiftStatusSchema.optional(),
});

export type Shift = z.infer<typeof shiftSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type CandidateList = z.infer<typeof candidateListSchema>;
export type CreateOffersRequest = z.infer<typeof createOffersRequestSchema>;
export type OffersResponse = z.infer<typeof offersResponseSchema>;
export type AssignShiftRequest = z.infer<typeof assignShiftRequestSchema>;
export type CancellationRequest = z.infer<typeof cancellationRequestSchema>;
export type AcceptanceRequest = z.infer<typeof acceptanceRequestSchema>;
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;
