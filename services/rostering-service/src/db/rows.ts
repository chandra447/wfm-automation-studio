import type { z } from 'zod';
import type { SQL } from 'bun';
import type { shiftStatusSchema } from '@wfm/contracts';

export type Tx = SQL;

export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

export type OfferStatus = 'sent' | 'accepted' | 'declined' | 'expired';

export interface ShiftRow {
  id: string;
  tenantId: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  roleName: string;
  requiredQualificationCodes: string[];
  startsAt: Date;
  endsAt: Date;
  hourlyRateCents: number;
  status: ShiftStatus;
  assignedEmployeeId: string | null;
  baselineCostCents: number;
}

export interface EmployeeRow {
  id: string;
  name: string;
  hourlyRateCents: number;
  weeklyHours: number;
  qualificationCodes: string[];
  availability: Array<{ weekday: number; startMinute: number; endMinute: number }>;
}

export interface OfferRow {
  id: string;
  tenantId: string;
  shiftId: string;
  employeeId: string;
  status: OfferStatus;
  expiresAt: Date;
}

export interface SwapRequestRow {
  id: string;
  tenantId: string;
  shiftId: string;
  requestingEmployeeId: string;
  targetEmployeeId: string | null;
  reason: string;
}
