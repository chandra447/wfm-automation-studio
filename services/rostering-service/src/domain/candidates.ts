import type { Candidate, CandidateList } from '@wfm/contracts';
import type { Sql } from 'postgres';
import type { EmployeeRow, ShiftRow } from '../db/rows.ts';
import { NotFoundError } from './errors.ts';

/**
 * Deterministic candidate ranking for a shift. Everything the score depends on
 * is computed here so the same roster state always produces the same order —
 * the engine's proposer and the human approval both read this list.
 */

export const REST_RULE_HOURS = 10;
export const REST_LOOKBACK_HOURS = 48;
export const STANDARD_WEEK_HOURS = 38;
const OVERTIME_LOW_RATIO = 0.8;

const COST_WITHIN_BASELINE_SCORE = 2;
const COST_CLOSE_TO_BASELINE_SCORE = 1;
const CLOSE_TO_BASELINE_RATIO = 0.1;
const OVERTIME_NONE_SCORE = 1.5;
const OVERTIME_LOW_SCORE = 0.5;
const REST_COMFORTABLE_HOURS = 24;
const REST_COMFORTABLE_SCORE = 0.5;

export interface CandidateShift {
  id: string;
  locationName: string;
  timeZone: string;
  requiredQualificationCodes: string[];
  startsAt: Date;
  endsAt: Date;
  hourlyRateCents: number;
  baselineCostCents: number;
}

export interface CandidateOccupancy {
  previousShiftEnd: Date | null;
  hasOverlappingShift: boolean;
}

type OvertimeRisk = Candidate['overtimeRisk'];

const formatterCache: Record<string, Intl.DateTimeFormat> = {};

function timeZoneParts(date: Date, timeZone: string): { weekday: number; minuteOfDay: number } {
  const formatter = (formatterCache[timeZone] ??= new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }));
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  if (weekdayIndex < 0) throw new Error(`unknown weekday ${parts.weekday}`);
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return { weekday: weekdayIndex, minuteOfDay: hour * 60 + Number(parts.minute ?? '0') };
}

/** A local-day segment of the shift: [start, end) in minutes of one weekday. */
function shiftSegments(shift: { startsAt: Date; endsAt: Date }, timeZone: string): Array<{ weekday: number; startMinute: number; endMinute: number }> {
  const start = timeZoneParts(shift.startsAt, timeZone);
  const end = timeZoneParts(shift.endsAt, timeZone);
  const segments: Array<{ weekday: number; startMinute: number; endMinute: number }> = [];
  let weekday = start.weekday;
  let startMinute = start.minuteOfDay;
  for (let day = 0; day < 8 && weekday !== end.weekday; day += 1) {
    segments.push({ weekday, startMinute, endMinute: 1440 });
    weekday = (weekday + 1) % 7;
    startMinute = 0;
  }
  segments.push({ weekday, startMinute, endMinute: end.minuteOfDay });
  return segments;
}

export function isAvailable(
  availability: Array<{ weekday: number; startMinute: number; endMinute: number }>,
  shift: { startsAt: Date; endsAt: Date },
  timeZone: string,
): boolean {
  return shiftSegments(shift, timeZone).every((segment) =>
    availability.some(
      (window) =>
        window.weekday === segment.weekday
        && window.startMinute <= segment.startMinute
        && window.endMinute >= segment.endMinute,
    ),
  );
}

export function restHoursBeforeShift(startsAt: Date, previousShiftEnd: Date | null): number {
  if (!previousShiftEnd) return REST_LOOKBACK_HOURS;
  return (startsAt.getTime() - previousShiftEnd.getTime()) / 3_600_000;
}

export function overtimeRisk(weeklyHours: number, shiftHours: number): OvertimeRisk {
  const scheduled = weeklyHours + shiftHours;
  if (scheduled > STANDARD_WEEK_HOURS) return 'high';
  if (scheduled >= STANDARD_WEEK_HOURS * OVERTIME_LOW_RATIO) return 'low';
  return 'none';
}

function holdsAllQualifications(qualificationCodes: string[], requiredQualificationCodes: string[]): boolean {
  return requiredQualificationCodes.every((code) => qualificationCodes.includes(code));
}

/**
 * Score = cost (0-2) + overtime risk (0-1.5) + rest turnaround comfort (0-0.5).
 * Blending cost, fatigue risk, and turnaround in one deterministic number keeps
 * the ranking explainable: the reasons array names every input that moved it.
 */
export function rankCandidates(
  shift: CandidateShift,
  employees: EmployeeRow[],
  occupancy: Record<string, CandidateOccupancy>,
  excludedEmployeeIds: string[] = [],
): Candidate[] {
  const shiftHours = (shift.endsAt.getTime() - shift.startsAt.getTime()) / 3_600_000;
  const candidates: Candidate[] = [];

  for (const employee of employees) {
    if (excludedEmployeeIds.includes(employee.id)) continue;
    if (!holdsAllQualifications(employee.qualificationCodes, shift.requiredQualificationCodes)) continue;

    const busy = occupancy[employee.id];
    if (!busy || busy.hasOverlappingShift) continue;

    if (!isAvailable(employee.availability, shift, shift.timeZone)) continue;

    const restHours = restHoursBeforeShift(shift.startsAt, busy.previousShiftEnd);
    if (restHours < REST_RULE_HOURS) continue;

    const estimatedCostCents = Math.round(shiftHours * employee.hourlyRateCents);
    const costDeltaVsBaselineCents = estimatedCostCents - shift.baselineCostCents;
    const overtime = overtimeRisk(employee.weeklyHours, shiftHours);
    const deltaRatio = Math.abs(costDeltaVsBaselineCents) / Math.max(shift.baselineCostCents, 1);

    let score = 0;
    if (costDeltaVsBaselineCents <= 0) {
      score += COST_WITHIN_BASELINE_SCORE;
    } else if (deltaRatio <= CLOSE_TO_BASELINE_RATIO) {
      score += COST_CLOSE_TO_BASELINE_SCORE;
    }
    if (overtime === 'none') score += OVERTIME_NONE_SCORE;
    if (overtime === 'low') score += OVERTIME_LOW_SCORE;
    if (restHours >= REST_COMFORTABLE_HOURS) score += REST_COMFORTABLE_SCORE;

    candidates.push({
      employeeId: employee.id,
      employeeName: employee.name,
      qualificationCodes: employee.qualificationCodes,
      hourlyRateCents: employee.hourlyRateCents,
      estimatedCostCents,
      costDeltaVsBaselineCents,
      overtimeRisk: overtime,
      restHoursBeforeShift: Math.round(restHours * 100) / 100,
      meetsRestRule: true,
      score,
      reasons: [
        `holds all required qualifications (${shift.requiredQualificationCodes.join(', ')})`,
        busy.previousShiftEnd
          ? `meets the ${REST_RULE_HOURS}h rest rule (${Math.round(restHours * 100) / 100}h since previous shift end)`
          : `meets the ${REST_RULE_HOURS}h rest rule (no previous shift ending within ${REST_LOOKBACK_HOURS}h before start)`,
        `available for the full shift window (${shift.locationName} local time)`,
        `overtime risk ${overtime} (${employee.weeklyHours}h scheduled + ${Math.round(shiftHours * 100) / 100}h shift against a ${STANDARD_WEEK_HOURS}h standard week)`,
        `estimated cost ${(estimatedCostCents / 100).toFixed(2)} (${costDeltaVsBaselineCents >= 0 ? '+' : '-'}${(Math.abs(costDeltaVsBaselineCents) / 100).toFixed(2)} vs baseline ${(shift.baselineCostCents / 100).toFixed(2)})`,
      ],
    });
  }

  return candidates.sort((a, b) =>
    b.score - a.score
    || a.estimatedCostCents - b.estimatedCostCents
    || a.employeeId.localeCompare(b.employeeId),
  );
}

export async function listCandidates(
  sql: Sql,
  tenantId: string,
  shiftId: string,
  excludeEmployeeIds: string[] = [],
): Promise<CandidateList> {
  const [shift] = await sql<ShiftRow[]>`
    SELECT s.id, s.tenant_id AS "tenantId", s.location_id AS "locationId", l.name AS "locationName",
           l.timezone AS "timeZone", s.role_name AS "roleName", s.required_qualification_codes AS "requiredQualificationCodes",
           s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.hourly_rate_cents AS "hourlyRateCents",
           s.status, s.assigned_employee_id AS "assignedEmployeeId", s.baseline_cost_cents AS "baselineCostCents"
    FROM shifts s
    JOIN locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
    WHERE s.id = ${shiftId} AND s.tenant_id = ${tenantId}
  `;
  if (!shift) throw new NotFoundError('shift not found');

  const employees = await sql<EmployeeRow[]>`
    SELECT e.id, e.name, e.hourly_rate_cents AS "hourlyRateCents", e.weekly_hours AS "weeklyHours",
           COALESCE(json_agg(DISTINCT q.code) FILTER (WHERE q.code IS NOT NULL), '[]') AS "qualificationCodes",
           COALESCE(
             json_agg(json_build_object('weekday', a.weekday, 'startMinute', a.start_minute, 'endMinute', a.end_minute))
               FILTER (WHERE a.id IS NOT NULL), '[]'
           ) AS availability
    FROM employees e
    LEFT JOIN employee_qualifications q ON q.employee_id = e.id AND q.tenant_id = e.tenant_id
    LEFT JOIN employee_availability a ON a.employee_id = e.id AND a.tenant_id = e.tenant_id
    WHERE e.tenant_id = ${tenantId}
    GROUP BY e.id, e.name, e.hourly_rate_cents, e.weekly_hours
  `;

  const overlaps = await sql<Array<{ employeeId: string }>>`
    SELECT DISTINCT assigned_employee_id AS "employeeId"
    FROM shifts
    WHERE tenant_id = ${tenantId} AND id <> ${shiftId} AND status <> 'cancelled'
      AND assigned_employee_id IS NOT NULL
      AND starts_at < ${shift.endsAt} AND ends_at > ${shift.startsAt}
  `;
  const overlapping = overlaps.map((row) => row.employeeId);

  const previous = await sql<Array<{ employeeId: string; lastEnd: Date }>>`
    SELECT assigned_employee_id AS "employeeId", MAX(ends_at) AS "lastEnd"
    FROM shifts
    WHERE tenant_id = ${tenantId} AND id <> ${shiftId} AND status <> 'cancelled'
      AND assigned_employee_id IS NOT NULL
      AND ends_at <= ${shift.startsAt}
      AND ends_at > ${shift.startsAt} - ${`${REST_LOOKBACK_HOURS} hours`}::interval
    GROUP BY assigned_employee_id
  `;

  const occupancy: Record<string, CandidateOccupancy> = {};
  for (const employee of employees) {
    occupancy[employee.id] = {
      previousShiftEnd: null,
      hasOverlappingShift: overlapping.includes(employee.id),
    };
  }
  for (const row of previous) {
    const entry = occupancy[row.employeeId];
    if (entry) entry.previousShiftEnd = row.lastEnd;
  }

  return {
    shiftId: shift.id,
    candidates: rankCandidates(shift, employees, occupancy, excludeEmployeeIds),
    generatedAt: new Date().toISOString(),
  };
}
