import {
  adjustmentRequestSchema,
  adjustmentResponseSchema,
  apiErrorSchema,
  assignmentRequestSchema,
  awardRuleSchema,
  cancellationRequestSchema,
  candidateListSchema,
  clockOutRequestSchema,
  createOffersRequestSchema,
  errorCodes,
  offersResponseSchema,
  shiftSchema,
  timesheetApprovalRequestSchema,
  timesheetDetailResponseSchema,
  timesheetExceptionSchema,
  type AdjustmentResponse,
  type AssignShiftRequest,
  type AwardRule,
  type CancellationRequest,
  type CandidateList,
  type CreateOffersRequest,
  type OffersResponse,
  type Shift,
  type Timesheet,
  type TimesheetDetailResponse,
  type TimesheetException,
} from '@wfm/contracts';
import { z } from 'zod';
import { DomainClientError } from './errors.ts';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const REQUEST_TIMEOUT_MS = 15_000;

/** Engine identity sent to domain services; tenant scoping comes per call. */
const SYSTEM_ACTOR_HEADERS = {
  'x-user-id': 'studio-engine',
  'x-user-roles': 'system',
} as const;

type AdjustmentRequestBody = z.infer<typeof adjustmentRequestSchema>;
type TimesheetApprovalBody = z.infer<typeof timesheetApprovalRequestSchema>;
type ClockOutBody = z.infer<typeof clockOutRequestSchema>;

const clockOutResponseSchema = z.object({
  timesheet: z.custom<Timesheet>((value) => value !== null),
  emittedEvents: z.array(z.string().min(1)),
});
const timesheetEnvelopeSchema = z.object({ timesheet: z.custom<Timesheet>((value) => value !== null) });

export interface RosteringClient {
  getShift: (tenantId: string, shiftId: string) => Promise<Shift>;
  listCandidates: (
    tenantId: string,
    shiftId: string,
    options?: { excludeEmployeeIds?: readonly string[] },
  ) => Promise<CandidateList>;
  createOffers: (
    tenantId: string,
    shiftId: string,
    request: CreateOffersRequest,
    idempotencyKey: string,
  ) => Promise<OffersResponse>;
  assignEmployee: (
    tenantId: string,
    shiftId: string,
    request: AssignShiftRequest,
    idempotencyKey: string,
  ) => Promise<Shift>;
  cancelShift: (tenantId: string, shiftId: string, request: CancellationRequest) => Promise<Shift>;
}

export interface AttendanceClient {
  getTimesheet: (tenantId: string, timesheetId: string) => Promise<TimesheetDetailResponse>;
  listExceptions: (tenantId: string, timesheetId: string) => Promise<TimesheetException[]>;
  getAwardRule: (tenantId: string, ruleCode: string) => Promise<AwardRule>;
  applyAdjustment: (
    tenantId: string,
    timesheetId: string,
    request: AdjustmentRequestBody,
    idempotencyKey: string,
  ) => Promise<AdjustmentResponse>;
  decideTimesheet: (
    tenantId: string,
    timesheetId: string,
    request: TimesheetApprovalBody,
  ) => Promise<{ timesheet: Timesheet }>;
  clockOut: (tenantId: string, shiftId: string, request: ClockOutBody) => Promise<{ timesheet: Timesheet; emittedEvents: string[] }>;
}

export interface DomainClients {
  rostering: RosteringClient;
  attendance: AttendanceClient;
}

export interface DomainClientEnvironment {
  ROSTERING_BASE_URL?: string;
  TIME_ATTENDANCE_BASE_URL?: string;
}

async function request(
  method: 'GET' | 'POST',
  url: string,
  tenantId: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { ...SYSTEM_ACTOR_HEADERS, 'x-tenant-id': tenantId };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;

  const response = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(raw);
    throw new DomainClientError(
      response.status,
      parsed.success ? parsed.data.error.code : errorCodes.validation,
      parsed.success ? parsed.data.error.message : `unexpected body from ${url}`,
    );
  }
  return raw;
}

/**
 * Typed HTTP clients for the two domain services. Every response is parsed with
 * the zod schemas in @wfm/contracts (a bad payload is a permanent failure, not
 * a surprise), and every mutation carries an Idempotency-Key (ADR-0007).
 */
export function createDomainClients(env: DomainClientEnvironment): DomainClients {
  if (!env.ROSTERING_BASE_URL) throw new Error('ROSTERING_BASE_URL is required');
  if (!env.TIME_ATTENDANCE_BASE_URL) throw new Error('TIME_ATTENDANCE_BASE_URL is required');
  const rosteringBase = env.ROSTERING_BASE_URL.replace(/\/$/, '');
  const attendanceBase = env.TIME_ATTENDANCE_BASE_URL.replace(/\/$/, '');

  const rostering: RosteringClient = {
    getShift: async (tenantId, shiftId) =>
      shiftSchema.parse(await request("GET", `${rosteringBase}/shifts/${shiftId}`, tenantId)),
    listCandidates: async (tenantId, shiftId, options) => {
      const params = new URLSearchParams();
      for (const employeeId of options?.excludeEmployeeIds ?? []) params.append('excludeEmployeeIds', employeeId);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return candidateListSchema.parse(
        await request('GET', `${rosteringBase}/shifts/${shiftId}/candidates${query}`, tenantId),
      );
    },
    createOffers: async (tenantId, shiftId, body, idempotencyKey) => {
      createOffersRequestSchema.parse(body);
      return offersResponseSchema.parse(
        await request('POST', `${rosteringBase}/shifts/${shiftId}/offers`, tenantId, body, idempotencyKey),
      );
    },
    assignEmployee: async (tenantId, shiftId, body, idempotencyKey) => {
      assignShiftRequestSchema.parse(body);
      return shiftSchema.parse(
        await request('POST', `${rosteringBase}/shifts/${shiftId}/assignment`, tenantId, body, idempotencyKey),
      );
    },
    cancelShift: async (tenantId, shiftId, body) =>
      shiftSchema.parse(await request('POST', `${rosteringBase}/shifts/${shiftId}/cancellation`, tenantId, body)),
  };

  const attendance: AttendanceClient = {
    getTimesheet: async (tenantId, timesheetId) =>
      timesheetDetailResponseSchema.parse(await request('GET', `${attendanceBase}/timesheets/${timesheetId}`, tenantId)),
    listExceptions: async (tenantId, timesheetId) =>
      z
        .array(timesheetExceptionSchema)
        .parse(await request('GET', `${attendanceBase}/timesheets/${timesheetId}/exceptions`, tenantId)),
    getAwardRule: async (tenantId, ruleCode) =>
      awardRuleSchema.parse(await request('GET', `${attendanceBase}/award-rules/${ruleCode}`, tenantId)),
    applyAdjustment: async (tenantId, timesheetId, body, idempotencyKey) => {
      adjustmentRequestSchema.parse(body);
      return adjustmentResponseSchema.parse(
        await request('POST', `${attendanceBase}/timesheets/${timesheetId}/adjustments`, tenantId, body, idempotencyKey),
      );
    },
    decideTimesheet: async (tenantId, timesheetId, body) => {
      timesheetApprovalRequestSchema.parse(body);
      return timesheetEnvelopeSchema.parse(
        await request('POST', `${attendanceBase}/timesheets/${timesheetId}/approval`, tenantId, body),
      );
    },
    clockOut: async (tenantId, shiftId, body) => {
      clockOutRequestSchema.parse(body);
      return clockOutResponseSchema.parse(
        await request("POST", `${attendanceBase}/shifts/${shiftId}/clock-out`, tenantId, body),
      );
    },
  };

  return { rostering, attendance };
}
